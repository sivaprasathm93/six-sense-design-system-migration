'use strict';

const ts = require('typescript');

const { NEW_PACKAGE, OLD_PACKAGE, PROP_MAP, SIZE_MAP, VARIANT_MAP } = require('./config.cjs');
const { addFlag } = require('./report.cjs');
const {
  endOfLineAfter,
  getImportedName,
  hasIdentifierCollision,
  isReExportedLocal,
  isReferenceIdentifier,
  newlineOf,
  propertyName,
  uniqueIdentifier,
} = require('./source.cjs');

/**
 * Migrates legacy `@old/ui` Buttons to `@acme/ds` in one file.
 *
 * Four stages, in the order they run. Each reads the previous one's output
 * through a shared `plan`, so the sections below are also the reading order:
 *
 *   1. bindings  -- which local names mean the legacy Button, and what they become
 *   2. imports   -- take migrated names off the legacy import
 *   3. usages    -- rewrite tags, props, values, type lookups, aliases
 *   4. imports   -- add the `@acme/ds` import for everything stage 2 and 3 queued
 *
 * Nothing is ever guessed. An unknown literal value, a dynamic expression, or a
 * name collision is left untouched and flagged for a human.
 */

/** The only `@old/ui` exports this migration moves. Card and Modal stay put. */
const MIGRATED_EXPORTS = new Set(['Button', 'ButtonProps']);

const CANONICAL_LOCAL = 'Button';
const FALLBACK_LOCAL = 'AcmeButton';

/**
 * @param {{ sourceFile: import('typescript').SourceFile, text: string,
 *   relativePath: string, report: import('./report.cjs').Report }} ctx
 *   `report` is mutated with counts and flags.
 * @returns {import('./source.cjs').Edit[]}
 */
function transformButton(ctx) {
  const bindings = collectButtonBindings(ctx);
  // Nothing legacy to migrate, and no namespace import that might hide a usage.
  if (!bindings.hasLegacyButton && bindings.namespaceNames.size === 0) return [];

  const plan = {
    bindings,
    edits: [],
    pendingImports: [],
    buttonLocals: buttonLocalsOf(bindings),
    buttonPropsLocals: buttonPropsLocalsOf(bindings),
    /** Legacy namespace local -> local name its Button becomes. */
    namespaceAliases: new Map(),
    /** Props typed as `ButtonProps['variant']`, hence already migrated. */
    safeDynamicVariantProps: new Set(),
    /** Props typed as `ButtonProps['size']`, hence already migrated. */
    safeDynamicSizeProps: new Set(),
  };

  // Type lookups are collected up front: a usage can precede the interface
  // that proves its value is already in the new vocabulary.
  collectSafeDynamicProps(ctx, plan);
  splitLegacyImports(ctx, plan);
  // Usages run before imports are emitted because a namespaced `NS.Button` is
  // the only thing that can reveal an import no named import announced.
  rewriteButtonUsages(ctx, plan);

  // Only `ButtonProps` was imported and no usage proved otherwise: keep the
  // legacy import intact rather than moving a type on its own.
  if (!bindings.hasLegacyButton) {
    return plan.edits.filter((edit) => edit.reason !== 'split-legacy-import');
  }

  emitDesignSystemImports(ctx, plan);
  return plan.edits;
}

// --- Stage 1: bindings -----------------------------------------------------

function importsFrom(sourceFile, moduleName) {
  return sourceFile.statements.filter((statement) => ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text === moduleName);
}

/** `{ A, B as C }` elements of an import, or `null` for other import forms. */
function namedImportsOf(declaration) {
  const bindings = declaration.importClause?.namedBindings;
  return bindings && ts.isNamedImports(bindings) ? bindings.elements : null;
}

/** The `* as NS` binding of an import, or `null`. */
function namespaceImportOf(declaration) {
  const bindings = declaration.importClause?.namedBindings;
  return bindings && ts.isNamespaceImport(bindings) ? bindings : null;
}

/**
 * True when `Button` can be used as a local name without clashing: either it is
 * already the design-system Button, or nothing in the file uses that name.
 */
function isCanonicalButtonAvailable(sourceFile, existingNewBindings) {
  if (existingNewBindings.get(CANONICAL_LOCAL) === CANONICAL_LOCAL) return true;
  return !existingNewBindings.has(CANONICAL_LOCAL)
    && !hasIdentifierCollision(sourceFile, CANONICAL_LOCAL);
}

/** Local name -> imported name for everything already imported from `@acme/ds`. */
function collectExistingBindings(newImports) {
  const existing = new Map();
  for (const declaration of newImports) {
    for (const specifier of namedImportsOf(declaration) || []) {
      existing.set(specifier.name.text, getImportedName(specifier));
    }
  }
  return existing;
}

/**
 * Resolves which local names in a file mean the legacy Button, and what each
 * becomes. Collisions are reported, not resolved: if the target local name
 * already means something else from `@acme/ds`, that import is left as it was.
 *
 * @returns {{ oldImports: object[], newImports: object[],
 *   existingNewBindings: Map<string, string>, migrated: Map<string, string>,
 *   localRenames: Map<string, string>, namespaceNames: Set<string>,
 *   hasLegacyButton: boolean }} `migrated` and `localRenames` are keyed by
 *   local name; `namespaceNames` holds `import * as NS` locals.
 */
function collectButtonBindings(ctx) {
  const { sourceFile, relativePath, report } = ctx;
  const oldImports = importsFrom(sourceFile, OLD_PACKAGE);
  const newImports = importsFrom(sourceFile, NEW_PACKAGE);

  const bindings = {
    oldImports,
    newImports,
    existingNewBindings: collectExistingBindings(newImports),
    migrated: new Map(),
    localRenames: new Map(),
    namespaceNames: new Set(),
    hasLegacyButton: false,
  };

  const importsButtonByName = oldImports.some((declaration) => (namedImportsOf(declaration) || [])
    .some((specifier) => getImportedName(specifier) === 'Button'));

  for (const declaration of oldImports) {
    const specifiers = namedImportsOf(declaration);
    if (!specifiers) {
      const namespace = namespaceImportOf(declaration);
      if (namespace) bindings.namespaceNames.add(namespace.name.text);
      continue;
    }

    for (const specifier of specifiers) {
      const imported = getImportedName(specifier);
      if (!MIGRATED_EXPORTS.has(imported)) continue;
      // `ButtonProps` on its own stays behind: moving the type without the
      // component it describes would split one API across two packages.
      if (imported === 'ButtonProps' && !importsButtonByName) continue;

      const local = specifier.name.text;
      // Aliases exist mostly to dodge the legacy name; prefer the canonical
      // one -- unless the alias is re-exported, where the local name is this
      // module's public API and renaming it would break (or silently rename)
      // the export.
      const canonicalizable = imported === 'Button' && local !== CANONICAL_LOCAL
        && !isReExportedLocal(sourceFile, local)
        && isCanonicalButtonAvailable(sourceFile, bindings.existingNewBindings);
      const targetLocal = canonicalizable ? CANONICAL_LOCAL : local;

      const existing = bindings.existingNewBindings.get(targetLocal);
      if (existing && existing !== imported) {
        addFlag(report, sourceFile, relativePath, specifier.getStart(sourceFile), 'import-collision',
          `Local name "${targetLocal}" already refers to a different ${NEW_PACKAGE} export; this import was left unchanged.`,
          imported);
        continue;
      }

      bindings.migrated.set(local, imported);
      bindings.localRenames.set(local, targetLocal);
      if (imported === 'Button') bindings.hasLegacyButton = true;
    }
  }

  return bindings;
}

/** Locals that refer to the legacy Button component. */
function buttonLocalsOf(bindings) {
  return new Set([...bindings.migrated].filter(([, imported]) => imported === 'Button').map(([local]) => local));
}

/** Locals that refer to the legacy `ButtonProps` type. */
function buttonPropsLocalsOf(bindings) {
  return new Set([...bindings.migrated].filter(([, imported]) => imported === 'ButtonProps').map(([local]) => local));
}

// --- Stages 2 and 4: imports ----------------------------------------------

/**
 * Quote style and trailing semicolons are copied from the import being
 * rewritten, so the result matches whatever the file already does.
 */
function importStyle(ctx, declaration) {
  return {
    quote: declaration.moduleSpecifier.getText(ctx.sourceFile)[0],
    semicolon: ctx.text.slice(declaration.end - 1, declaration.end) === ';',
    // `import type { ... }` must stay type-only: turning it into a value
    // import changes emit (and breaks `verbatimModuleSyntax`).
    typeOnly: Boolean(declaration.importClause?.isTypeOnly),
  };
}

function renderImport(moduleName, clauseText, { quote, semicolon, typeOnly }) {
  return `import ${typeOnly ? 'type ' : ''}${clauseText} from ${quote}${moduleName}${quote}${semicolon ? ';' : ''}`;
}

function renderNamedImport(moduleName, specifiers, style) {
  if (!specifiers.length) return '';
  return renderImport(moduleName, `{ ${specifiers.join(', ')} }`, style);
}

function renderClause(parts) {
  return parts.filter(Boolean).join(', ');
}

/**
 * Stage 2. Removes migrated specifiers from each legacy import and records what
 * has to be imported from the new package. An import left with nothing becomes
 * an empty edit, which stage 4 may reuse as the insertion point.
 */
function splitLegacyImports(ctx, plan) {
  const { sourceFile } = ctx;
  const { bindings } = plan;

  for (const declaration of bindings.oldImports) {
    const clause = declaration.importClause;
    const specifiers = clause && namedImportsOf(declaration);
    if (!specifiers) continue;

    const moved = [];
    const retained = [];
    for (const specifier of specifiers) {
      const imported = getImportedName(specifier);
      const local = specifier.name.text;
      if (!MIGRATED_EXPORTS.has(imported) || bindings.migrated.get(local) !== imported) {
        retained.push(specifier.getText(sourceFile));
        continue;
      }
      const targetLocal = bindings.localRenames.get(local) || local;
      // Already available from the new package: drop it rather than duplicate it.
      if (bindings.existingNewBindings.get(targetLocal) === imported) continue;
      moved.push(imported === 'Button' && targetLocal === CANONICAL_LOCAL
        ? CANONICAL_LOCAL
        : specifier.getText(sourceFile));
    }
    if (!moved.length) continue;

    const style = importStyle(ctx, declaration);
    const remainder = retained.length || clause.name
      ? renderImport(OLD_PACKAGE, renderClause([
        clause.name ? clause.name.getText(sourceFile) : null,
        retained.length ? `{ ${retained.join(', ')} }` : null,
      ]), style)
      : '';

    // An import that lost every specifier has to take its line with it;
    // otherwise the migration leaves a stray blank line behind.
    const end = remainder ? declaration.end : endOfLineAfter(ctx.text, declaration.end);
    plan.edits.push({
      start: declaration.getStart(sourceFile),
      end,
      text: remainder,
      reason: 'split-legacy-import',
      swallowedNewline: !remainder && end > declaration.end,
    });
    plan.pendingImports.push(...moved.map((raw) => ({ raw, ...style })));
  }
}

/** `Button` or `Button as Alias` for pending imports created from a namespace use. */
function resolveSpecifierText(pendingImports) {
  for (const item of pendingImports) {
    if (item.raw) continue;
    item.raw = item.local === item.imported ? item.imported : `${item.imported} as ${item.local}`;
  }
}

/**
 * Groups pending specifiers by formatting style so each group renders one
 * import. Type-only and value imports are separate groups: they are different
 * kinds of import, not a formatting difference.
 */
function renderAdditions(pendingImports) {
  const groups = new Map();
  for (const item of pendingImports) {
    const quote = item.quote || "'";
    const semicolon = Boolean(item.semicolon);
    const typeOnly = Boolean(item.typeOnly);
    const key = `${quote}:${semicolon}:${typeOnly}`;
    if (!groups.has(key)) groups.set(key, { quote, semicolon, typeOnly, specifiers: [] });
    groups.get(key).specifiers.push(item.raw);
  }
  return [...groups.values()]
    .map((group) => renderNamedImport(NEW_PACKAGE, group.specifiers, group))
    .filter(Boolean);
}

/** An existing value import from the new package that new specifiers can join. */
function findMergeTarget(bindings) {
  return bindings.newImports.find((declaration) => {
    const specifiers = namedImportsOf(declaration);
    return specifiers && !declaration.importClause.isTypeOnly;
  });
}

function mergeIntoExistingImport(ctx, plan, mergeTarget) {
  const { sourceFile } = ctx;
  const existingSpecifiers = namedImportsOf(mergeTarget).map((specifier) => specifier.getText(sourceFile));
  // The target is a value import, so a type-only specifier keeps its own
  // inline `type` modifier rather than silently becoming a value import.
  const addedSpecifiers = plan.pendingImports.map((item) => (item.typeOnly && !/^type\s/.test(item.raw)
    ? `type ${item.raw}`
    : item.raw));
  const clauseText = renderClause([
    mergeTarget.importClause.name?.getText(sourceFile),
    `{ ${[...existingSpecifiers, ...addedSpecifiers].join(', ')} }`,
  ]);

  plan.edits.push({
    start: mergeTarget.getStart(sourceFile),
    end: mergeTarget.end,
    text: renderImport(NEW_PACKAGE, clauseText, importStyle(ctx, mergeTarget)),
    reason: 'merge-design-system-import',
  });
}

function appendNewImports(ctx, plan, additions) {
  const { sourceFile, text } = ctx;
  const lastImport = [...sourceFile.statements].reverse().find(ts.isImportDeclaration);
  if (!lastImport) return;

  // A legacy import that lost every specifier leaves an empty edit at this
  // offset; reuse it so the new import takes the old one's place and line.
  const emptiedImport = plan.edits.find((edit) => edit.start === lastImport.getStart(sourceFile)
    && edit.reason === 'split-legacy-import');
  const newline = newlineOf(text);
  if (emptiedImport && !emptiedImport.text) {
    // The empty edit also swallowed the old import's line break, so the
    // replacement has to put it back.
    emptiedImport.text = additions.join(newline) + (emptiedImport.swallowedNewline ? newline : '');
    return;
  }
  plan.edits.push({
    start: lastImport.end,
    end: lastImport.end,
    text: `${newline}${additions.join(newline)}`,
    reason: 'add-design-system-import',
  });
}

/** Stage 4. Adds the `@acme/ds` import(s) for everything the earlier stages queued. */
function emitDesignSystemImports(ctx, plan) {
  if (!plan.pendingImports.length) return;
  resolveSpecifierText(plan.pendingImports);

  const mergeTarget = findMergeTarget(plan.bindings);
  if (mergeTarget) {
    mergeIntoExistingImport(ctx, plan, mergeTarget);
    return;
  }

  const additions = renderAdditions(plan.pendingImports);
  if (additions.length) appendNewImports(ctx, plan, additions);
}

// --- Stage 3: usages -------------------------------------------------------

/** Props whose *name* changes, e.g. `variant` -> `intent`. */
const RENAMED_PROPS = new Set(Object.keys(PROP_MAP));

/** Props whose *value* vocabulary changes, with the map and flag category each uses. */
const MAPPED_PROP_VALUES = {
  variant: { map: VARIANT_MAP, unknown: 'unknown-variant', dynamic: 'dynamic-variant' },
  size: { map: SIZE_MAP, unknown: 'unknown-size', dynamic: 'dynamic-size' },
};

/**
 * Introduces a `@acme/ds` Button binding for `NS.Button` usages, once per
 * namespace. Falls back to an alias when `Button` is taken locally.
 */
function registerNamespaceButton(ctx, plan, namespace) {
  const { bindings } = plan;

  // Two `import * as X from '@old/ui'` in one file mean the same Button, so
  // reuse the local name already queued instead of importing it twice (which
  // would emit `import { Button, Button }`).
  const queued = plan.pendingImports.find((item) => item.imported === 'Button' && item.local);
  if (queued) {
    plan.namespaceAliases.set(namespace, queued.local);
    bindings.hasLegacyButton = true;
    return;
  }

  const claimed = new Set([
    ...plan.namespaceAliases.values(),
    ...plan.pendingImports.map((item) => item.local).filter(Boolean),
  ]);
  const alias = isCanonicalButtonAvailable(ctx.sourceFile, bindings.existingNewBindings)
    && !claimed.has(CANONICAL_LOCAL)
    ? CANONICAL_LOCAL
    : uniqueIdentifier(ctx.sourceFile, FALLBACK_LOCAL, claimed);
  plan.namespaceAliases.set(namespace, alias);

  if (bindings.existingNewBindings.get(alias) !== 'Button') {
    const declaration = bindings.oldImports
      .find((item) => namespaceImportOf(item)?.name.text === namespace);
    plan.pendingImports.push({
      local: alias,
      imported: 'Button',
      ...importStyle(ctx, declaration),
    });
  }
  // A namespaced usage is a legacy Button too, even with no named import.
  bindings.hasLegacyButton = true;
}

/**
 * Resolves a JSX tag to the local name it should become.
 *
 * @returns {{ local: string, namespace?: string } | null} `null` when the tag
 *   is not a legacy Button.
 */
function resolveLegacyTag(ctx, plan, tagName) {
  if (ts.isIdentifier(tagName)) {
    if (!plan.buttonLocals.has(tagName.text)) return null;
    return { local: plan.bindings.localRenames.get(tagName.text) || tagName.text };
  }

  const isNamespacedButton = ts.isPropertyAccessExpression(tagName)
    && ts.isIdentifier(tagName.expression)
    && tagName.name.text === 'Button'
    && plan.bindings.namespaceNames.has(tagName.expression.text);
  if (!isNamespacedButton) return null;

  const namespace = tagName.expression.text;
  if (!plan.namespaceAliases.has(namespace)) registerNamespaceButton(ctx, plan, namespace);
  return { local: plan.namespaceAliases.get(namespace), namespace };
}

/**
 * Rewrites a literal prop value, or flags it when the value has no mapping.
 *
 * @returns {boolean} whether the value is part of the new vocabulary, i.e.
 *   whether renaming the prop around it would produce code that can compile.
 */
function mapLiteralValue(ctx, plan, literal, { map, unknown }) {
  const { sourceFile, relativePath, report } = ctx;
  const mapped = map[literal.text];
  if (!mapped) {
    addFlag(report, sourceFile, relativePath, literal.getStart(sourceFile), unknown,
      `Value "${literal.text}" has no safe mapping; the prop and its value were left unchanged.`, literal.text);
    return false;
  }
  if (mapped === literal.text) return true;

  // Edit inside the quotes so the file's quote style survives.
  const start = literal.getStart(sourceFile);
  plan.edits.push({ start: start + 1, end: literal.end - 1, text: mapped, reason: 'map-button-value' });
  report.buttonPropValues += 1;
  return true;
}

function isPlainStringLiteral(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/**
 * Maps a `variant` expression, descending into parentheses and both branches of
 * a conditional. Anything else is retained and flagged, unless it is a prop
 * whose type already pins it to the new vocabulary.
 */
function mapVariantExpression(ctx, plan, expression) {
  if (isPlainStringLiteral(expression)) {
    return mapLiteralValue(ctx, plan, expression, MAPPED_PROP_VALUES.variant);
  }
  if (ts.isParenthesizedExpression(expression)) {
    return mapVariantExpression(ctx, plan, expression.expression);
  }
  if (ts.isConditionalExpression(expression)) {
    // Both branches have to be safe before the prop around them is renamed.
    const whenTrue = mapVariantExpression(ctx, plan, expression.whenTrue);
    const whenFalse = mapVariantExpression(ctx, plan, expression.whenFalse);
    return whenTrue && whenFalse;
  }
  // `undefined` is valid for an optional prop in either vocabulary.
  if (ts.isIdentifier(expression) && expression.text === 'undefined') return true;
  if (ts.isIdentifier(expression) && plan.safeDynamicVariantProps.has(expression.text)) return true;
  addFlag(ctx.report, ctx.sourceFile, ctx.relativePath, expression.getStart(ctx.sourceFile),
    'dynamic-variant',
    'Dynamic variant expression was retained; verify its values use the new intent vocabulary.',
    expression.getText(ctx.sourceFile));
  // Dynamic values are renamed: the prop name is what the new component reads,
  // and the flag asks a human to confirm the vocabulary behind it.
  return true;
}

function mapSizeExpression(ctx, plan, expression) {
  if (isPlainStringLiteral(expression)) {
    return mapLiteralValue(ctx, plan, expression, MAPPED_PROP_VALUES.size);
  }
  if (ts.isIdentifier(expression) && plan.safeDynamicSizeProps.has(expression.text)) return true;
  addFlag(ctx.report, ctx.sourceFile, ctx.relativePath, expression.getStart(ctx.sourceFile),
    'dynamic-size',
    'Dynamic size expression was retained; verify its values use the new size vocabulary.',
    expression.getText(ctx.sourceFile));
  return true;
}

function renameTag(ctx, plan, tagName, local) {
  plan.edits.push({
    start: tagName.getStart(ctx.sourceFile),
    end: tagName.end,
    text: local,
    reason: 'replace-namespace-button',
  });
}

/**
 * Maps an attribute's value.
 *
 * @returns {boolean} whether the value ended up in the new vocabulary. A prop
 *   with no value map, or with no initializer, is vacuously safe.
 */
function rewriteAttributeValue(ctx, plan, attribute, name) {
  if (!attribute.initializer) return true;
  const mapExpression = name === 'variant' ? mapVariantExpression
    : name === 'size' ? mapSizeExpression
      : null;
  if (!mapExpression) return true;

  if (ts.isStringLiteral(attribute.initializer)) {
    return mapLiteralValue(ctx, plan, attribute.initializer, MAPPED_PROP_VALUES[name]);
  }
  if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) {
    return mapExpression(ctx, plan, attribute.initializer.expression);
  }
  return true;
}

function rewriteAttributes(ctx, plan, node) {
  const { sourceFile, relativePath, report } = ctx;
  for (const attribute of node.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attribute)) {
      // The object behind a spread is not inspected, so its prop names and
      // values cannot be migrated. Say so instead of migrating the component
      // around it in silence.
      addFlag(report, sourceFile, relativePath, attribute.getStart(sourceFile), 'spread-props',
        'Spread props were retained; verify the object uses the new Button prop names and values.',
        attribute.getText(sourceFile));
      continue;
    }
    if (!ts.isJsxAttribute(attribute) || !ts.isIdentifier(attribute.name)) continue;
    const name = attribute.name.text;

    // Value first: a value with no safe mapping leaves the prop name alone
    // too, so the attribute stays recognizably un-migrated rather than
    // becoming `intent="mystery"`, which no new vocabulary accepts.
    const valueIsSafe = rewriteAttributeValue(ctx, plan, attribute, name);
    if (RENAMED_PROPS.has(name) && valueIsSafe) {
      plan.edits.push({
        start: attribute.name.getStart(sourceFile),
        end: attribute.name.end,
        text: PROP_MAP[name],
        reason: 'map-button-prop',
      });
    }
  }
}

/** Rewrites `ButtonProps['variant']` to `ButtonProps['intent']`. */
function rewriteButtonPropsLookup(ctx, plan, node) {
  const literal = node.indexType.literal;
  const mapped = PROP_MAP[literal.text] || literal.text;
  if (mapped === literal.text) return;

  plan.edits.push({
    start: literal.getStart(ctx.sourceFile) + 1,
    end: literal.end - 1,
    text: mapped,
    reason: 'map-button-type-property',
  });
}

/**
 * Collects the props declared as `ButtonProps['variant']` / `['size']`. A
 * value flowing through such a prop is already constrained to the migrated
 * vocabulary, so passing it on dynamically is safe rather than a flag. It is
 * its own pass because a usage may appear *above* the interface that types it.
 */
function collectSafeDynamicProps(ctx, plan) {
  const sets = { variant: plan.safeDynamicVariantProps, size: plan.safeDynamicSizeProps };

  (function visit(node) {
    if (isButtonPropsLookup(node, plan.buttonPropsLocals)) {
      const target = sets[node.indexType.literal.text];
      const owner = node.parent;
      if (target && ts.isPropertySignature(owner) && owner.type === node) {
        const member = propertyName(owner.name);
        if (member) target.add(member);
      }
    }
    ts.forEachChild(node, visit);
  }(ctx.sourceFile));
}

function isButtonPropsLookup(node, buttonPropsLocals) {
  return ts.isIndexedAccessTypeNode(node)
    && ts.isTypeReferenceNode(node.objectType)
    && ts.isIdentifier(node.objectType.typeName)
    && buttonPropsLocals.has(node.objectType.typeName.text)
    && ts.isLiteralTypeNode(node.indexType)
    && ts.isStringLiteral(node.indexType.literal);
}

function isRenamedAliasReference(node, bindings) {
  return ts.isIdentifier(node)
    && bindings.localRenames.has(node.text)
    && bindings.localRenames.get(node.text) !== node.text
    && isReferenceIdentifier(node);
}

/** Stage 3. Walks the file once, rewriting every Button usage it recognizes. */
function rewriteButtonUsages(ctx, plan) {
  const { sourceFile, report } = ctx;

  (function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const binding = resolveLegacyTag(ctx, plan, node.tagName);
      if (binding) {
        report.buttonComponents += 1;
        if (binding.namespace) renameTag(ctx, plan, node.tagName, binding.local);
        rewriteAttributes(ctx, plan, node);
      }
    } else if (ts.isJsxClosingElement(node)) {
      const binding = resolveLegacyTag(ctx, plan, node.tagName);
      if (binding?.namespace) renameTag(ctx, plan, node.tagName, binding.local);
    } else if (isButtonPropsLookup(node, plan.buttonPropsLocals)) {
      rewriteButtonPropsLookup(ctx, plan, node);
    } else if (isRenamedAliasReference(node, plan.bindings)) {
      const renamed = plan.bindings.localRenames.get(node.text);
      // In `{ LegacyButton }` the identifier is both the key and the value,
      // so it is expanded instead of renamed: renaming it would silently
      // change the object's key.
      const isShorthand = ts.isShorthandPropertyAssignment(node.parent);
      plan.edits.push({
        start: node.getStart(sourceFile),
        end: node.end,
        text: isShorthand ? `${node.text}: ${renamed}` : renamed,
        reason: 'rename-button-import-alias',
      });
    }
    ts.forEachChild(node, visit);
  }(sourceFile));
}

module.exports = { transformButton };

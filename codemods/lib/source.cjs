'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const { GENERATED_FILE_PATTERN, SOURCE_FILE_PATTERN } = require('./config.cjs');

/**
 * Mechanical source handling with no migration policy in it: applying edits,
 * locating offsets, finding files, parsing TypeScript, and reading CSS
 * declarations. Nothing here knows about Buttons or colors.
 */

// --- Edits -----------------------------------------------------------------

/**
 * An edit replaces `[start, end)` in the original text. Transforms only ever
 * produce edits, never rewritten whole files, so formatting, comments, and
 * unrelated code outside the edited ranges survive untouched.
 *
 * @typedef {{ start: number, end: number, text: string, reason: string }} Edit
 */

/**
 * Applies edits back-to-front so earlier offsets stay valid. The overlap check
 * is the main safety net: two transforms claiming the same range would
 * silently corrupt output, so it throws instead.
 */
function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let output = text;
  let previousStart = text.length + 1;
  for (const edit of sorted) {
    if (edit.end > previousStart) {
      throw new Error(`Overlapping codemod edits near offset ${edit.start} (${edit.reason})`);
    }
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
    previousStart = edit.start;
  }
  return output;
}

/**
 * Where an original offset ends up once `edits` are applied, so an offset
 * recorded during a transform (a review flag's position) can be reported
 * against the file as written. An insertion sitting exactly on the offset
 * counts, which puts a flag after a comment inserted above its line.
 */
function mapOffset(edits, position) {
  let delta = 0;
  for (const edit of edits) {
    if (edit.end <= position) delta += edit.text.length - (edit.end - edit.start);
  }
  return position + delta;
}

// --- Text positions --------------------------------------------------------

/**
 * 1-based line number for an offset. `source` is a parsed source file, or raw
 * text for inputs with no AST (CSS).
 */
function lineNumber(source, position) {
  if (typeof source === 'string') return source.slice(0, position).split(/\r\n|\r|\n/).length;
  return source.getLineAndCharacterOfPosition(position).line + 1;
}

/** Newline sequence to use when inserting lines into `text`. */
function newlineOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Extends `end` past the rest of the line when only whitespace and a line
 * break follow, so deleting a statement takes its line with it instead of
 * leaving a stray blank line. Returns `end` when other content shares the line.
 */
function endOfLineAfter(text, end) {
  let index = end;
  while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index += 1;
  if (text.startsWith('\r\n', index)) return index + 2;
  if (text[index] === '\n' || text[index] === '\r') return index + 1;
  return end;
}

// --- Files -----------------------------------------------------------------

/** CSS is handled by text scanning; everything else gets parsed. */
function isCssFile(filePath) {
  return path.extname(filePath).toLowerCase() === '.css';
}

/** Directories that never contain first-party source. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

/** True when the file is generated output rather than hand-written source. */
function isGeneratedFile(filePath) {
  return GENERATED_FILE_PATTERN.test(path.basename(filePath));
}

/**
 * Every migratable source file under `directory`, recursively, as absolute
 * paths. Generated files and dependency/output directories are skipped as
 * derived artifacts; migrating or linting them is noise at best and circular
 * at worst. Sorted, so runs and reports are deterministic.
 */
function walkFiles(directory) {
  if (!fs.existsSync(directory)) throw new Error(`Target directory does not exist: ${directory}`);
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...walkFiles(fullPath));
    } else if (SOURCE_FILE_PATTERN.test(entry.name) && !isGeneratedFile(entry.name)) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

/** Repo-relative, forward-slash path for report and lint output. */
function toRelativePath(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

// --- TypeScript parsing ----------------------------------------------------

const SCRIPT_KINDS = new Map([
  ['.tsx', ts.ScriptKind.TSX],
  ['.jsx', ts.ScriptKind.JSX],
  ['.js', ts.ScriptKind.JSX],
  ['.ts', ts.ScriptKind.TS],
]);

/**
 * Parses a TS/JS source file with parent pointers, since the transforms walk
 * upward from literals and identifiers. A parse error aborts the file instead
 * of producing partial edits, so broken input can never be half-migrated.
 */
function createSourceFile(filePath, text) {
  const scriptKind = SCRIPT_KINDS.get(path.extname(filePath).toLowerCase()) ?? ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
  if (sourceFile.parseDiagnostics.length) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    throw new Error(`${filePath}:${lineNumber(sourceFile, diagnostic.start || 0)}: ${message}`);
  }
  return sourceFile;
}

// --- AST predicates --------------------------------------------------------
// What a node *is*. Never what to rewrite.

/** Static name of a property-like node, or `null` when it is computed. */
function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  return null;
}

/** True when `node` is `ancestor` or sits inside it. */
function isWithin(node, ancestor) {
  let current = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

/** The name a specifier imports from the module (`propertyName` when aliased). */
function getImportedName(specifier) {
  return specifier.propertyName ? specifier.propertyName.text : specifier.name.text;
}

/**
 * True when `name` is re-exported, as in `export { name }`. An export
 * specifier is public API, so renaming the local binding would leave the
 * export dangling; callers decline the rename instead.
 */
function isReExportedLocal(sourceFile, name) {
  return sourceFile.statements.some((statement) => {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier) return false;
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) return false;
    return clause.elements.some((specifier) => (specifier.propertyName
      ? specifier.propertyName.text === name
      : specifier.name.text === name));
  });
}

/**
 * True when the identifier *uses* a binding, rather than declaring one or
 * naming a member; renaming an alias must only touch these occurrences.
 * Export specifiers return `false` because their name is the exported API --
 * `isReExportedLocal` is what declines the rename in that case.
 */
function isReferenceIdentifier(node) {
  const parent = node.parent;
  if ((ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)
      || ts.isJsxClosingElement(parent)) && parent.tagName === node) return true;
  if (ts.isTypeQueryNode(parent) && parent.exprName === node) return true;
  if (ts.isTypeReferenceNode(parent) && parent.typeName === node) return true;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
  if (parent.name === node || parent.propertyName === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  return ts.isExpression(node);
}

function forEachIdentifier(sourceFile, visitor) {
  (function visit(node) {
    if (ts.isIdentifier(node)) visitor(node);
    ts.forEachChild(node, visit);
  }(sourceFile));
}

/**
 * `base`, or `base2`, `base3`, ... -- the first name the file does not already
 * use. `claimed` holds names a caller has reserved but not yet written.
 */
function uniqueIdentifier(sourceFile, base, claimed = []) {
  const used = new Set(claimed);
  forEachIdentifier(sourceFile, (node) => used.add(node.text));
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}${suffix++}`;
  return candidate;
}

/**
 * True when `name` is already bound or referenced for its own sake in the file.
 * Import aliases (`X as name`) and member names (`o.name`, `N.name`) do not
 * count, since introducing `name` as a new import would not shadow them.
 */
function hasIdentifierCollision(sourceFile, name) {
  let collision = false;
  forEachIdentifier(sourceFile, (node) => {
    if (collision || node.text !== name) return;
    const parent = node.parent;
    const isAliasSource = ts.isImportSpecifier(parent) && parent.propertyName === node;
    const isMemberName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
      || (ts.isQualifiedName(parent) && parent.right === node);
    if (!isAliasSource && !isMemberName) collision = true;
  });
  return collision;
}

// --- CSS declarations ------------------------------------------------------
// A deliberately small CSS reader: enough structure to find `property: value`
// declarations inside blocks without pulling in a parser. It tracks comments,
// strings, parens, and brace depth so colors in selectors, at-rule preludes,
// comments, or `url()` values are never touched.

/**
 * Offset of the colon separating property from value, or -1 when the segment
 * has no top-level colon.
 */
function findDeclarationColon(text, start, end) {
  let quote = null;
  let parens = 0;
  for (let index = start; index < end; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
    } else if (text.startsWith('/*', index)) {
      const commentEnd = text.indexOf('*/', index + 2);
      index = commentEnd < 0 ? end : commentEnd + 1;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(') parens += 1;
    else if (char === ')') parens = Math.max(0, parens - 1);
    else if (char === ':' && parens === 0) return index;
  }
  return -1;
}

/**
 * Calls `visit(start, end)` once per declaration-ish segment inside a block.
 * Segments are delimited by `;` and `}` at brace depth > 0, so top-level
 * selectors and at-rule preludes are skipped.
 */
function forEachDeclaration(text, visit) {
  let segmentStart = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let quote = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (text.startsWith('/*', index)) {
      const commentEnd = text.indexOf('*/', index + 2);
      index = commentEnd < 0 ? text.length : commentEnd + 1;
      continue;
    }
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '(') parenDepth += 1;
    else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (parenDepth === 0 && char === '{') {
      braceDepth += 1;
      segmentStart = index + 1;
    } else if (parenDepth === 0 && char === ';' && braceDepth > 0) {
      visit(segmentStart, index);
      segmentStart = index + 1;
    } else if (parenDepth === 0 && char === '}') {
      // Handles a final declaration with no trailing semicolon.
      if (braceDepth > 0) visit(segmentStart, index);
      braceDepth = Math.max(0, braceDepth - 1);
      segmentStart = index + 1;
    }
  }
}

module.exports = {
  applyEdits,
  createSourceFile,
  endOfLineAfter,
  findDeclarationColon,
  forEachDeclaration,
  getImportedName,
  hasIdentifierCollision,
  isCssFile,
  isReExportedLocal,
  isReferenceIdentifier,
  isWithin,
  lineNumber,
  mapOffset,
  newlineOf,
  propertyName,
  toRelativePath,
  uniqueIdentifier,
  walkFiles,
};

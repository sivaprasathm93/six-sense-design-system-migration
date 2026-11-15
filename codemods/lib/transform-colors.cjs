'use strict';

const ts = require('typescript');

const { COLOR_PROPERTIES, COLOR_VARIABLE_PATTERN, CUSTOM_PROPERTY_PATTERN } = require('./config.cjs');
const {
  collectHexes, hasAlphaChannel, normalizeHex, parseHexAt, tokenReference,
} = require('./color.cjs');
const {
  findDeclarationColon, forEachDeclaration, isCssFile, isWithin, lineNumber, propertyName,
} = require('./source.cjs');

/**
 * Hex-color -> token migration, in three separable steps:
 *
 *   1. collect  -- which hex literals are actually colors (context matters)
 *   2. analyze  -- exact token, alpha, or no match
 *   3. toEdits  -- rewrite exact matches only; flag everything else
 *
 * The color lint reuses step 1 alone, which is what makes it impossible for the
 * lint and the migration to disagree about what counts as a hard-coded color.
 *
 * @typedef {{ file: string, line: number, value: string, context: string,
 *   start: number, end: number }} ColorCandidate
 */

/** `backgroundColor` -> `background-color`. */
function toCssProperty(name) {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).toLowerCase();
}

/**
 * Digit counts accepted inside a palette array. `#rgba` is excluded: a
 * 4-character hex is more often a truncated string than a palette entry, and a
 * palette has to read unambiguously as one before `series` is treated as color.
 */
const PALETTE_HEX_LENGTHS = [3, 6, 8];

/** True when every element is a token reference or a single bare hex color. */
function isColorArray(elements) {
  return elements.length > 0 && elements.every((element) => ts.isStringLiteralLike(element)
    && (/^var\(--color-[^)]+\)$/.test(element.text)
      || (collectHexes(element.text, false).length === 1
        && PALETTE_HEX_LENGTHS.includes(parseHexAt(element.text, 0)?.end - 1))));
}

/**
 * Decides whether a string literal holds a color, and labels why. A bare hex
 * string is only a color in context: an inline-style property that takes a
 * color, a variable named like a color holder, or a `series` array that
 * already reads as a palette. An id, a URL fragment, or an unrelated string
 * is left alone.
 *
 * @returns {string | null} a label such as `property:color` or
 *   `variable:chartColors`, or `null` when the literal is not a color.
 */
function colorContextOf(node) {
  let current = node.parent;

  // Nearest enclosing inline-style property, e.g. `{ backgroundColor: '#fff' }`.
  while (current && !ts.isVariableDeclaration(current)) {
    if (ts.isPropertyAssignment(current) && isWithin(node, current.initializer)) {
      const name = propertyName(current.name);
      if (name && COLOR_PROPERTIES.has(toCssProperty(name))) return `property:${name}`;
    }
    current = current.parent;
  }

  if (!current || !ts.isIdentifier(current.name)) return null;
  const variable = current.name.text;
  if (COLOR_VARIABLE_PATTERN.test(variable)) return `variable:${variable}`;
  if (variable === 'series' && ts.isArrayLiteralExpression(current.initializer)
    && isColorArray(current.initializer.elements)) {
    return 'variable:series';
  }
  return null;
}

/**
 * Step 1. Every hex color in a file, with the context that makes it a color.
 *
 * @returns {ColorCandidate[]}
 */
function collectColorCandidates({ filePath, text, sourceFile, relativePath }) {
  const candidates = [];

  const inspectValue = (value, valueStart, context, skipCssSyntax) => {
    for (const hex of collectHexes(value, skipCssSyntax)) {
      const absoluteStart = valueStart + hex.start;
      candidates.push({
        file: relativePath,
        line: lineNumber(sourceFile || text, absoluteStart),
        value: hex.value,
        context,
        start: absoluteStart,
        end: valueStart + hex.end,
      });
    }
  };

  if (isCssFile(filePath)) {
    forEachDeclaration(text, (start, end) => {
      const colon = findDeclarationColon(text, start, end);
      if (colon < 0) return;
      const declared = text.slice(start, colon).replace(/\/\*[\s\S]*?\*\//g, '').trim();
      const property = declared.toLowerCase();
      // Custom properties are case-sensitive and are where a hand-rolled
      // "token" would hide, so they are in scope with their exact name.
      const context = COLOR_PROPERTIES.has(property) ? `property:${property}`
        : CUSTOM_PROPERTY_PATTERN.test(declared) ? `custom-property:${declared}`
          : null;
      if (!context) return;
      inspectValue(text.slice(colon + 1, end), colon + 1, context, true);
    });
    return candidates;
  }

  (function visit(node) {
    if (ts.isStringLiteralLike(node)) {
      const context = colorContextOf(node);
      if (context) {
        const start = node.getStart(sourceFile) + 1; // inside the opening quote
        inspectValue(text.slice(start, node.end - 1), start, context, false);
      }
    }
    ts.forEachChild(node, visit);
  }(sourceFile));

  return candidates;
}

/**
 * Step 2. Classifies candidates against the token map.
 *
 * @returns {(ColorCandidate & { status: 'matched' | 'unmatched' | 'unsupported-alpha' })[]}
 */
function analyzeColorCandidates(candidates, tokenMap) {
  return candidates.map((candidate) => {
    const normalized = normalizeHex(candidate.value);
    const token = normalized && tokenMap.get(normalized);
    if (token) return { ...candidate, normalized, token, status: 'matched' };

    return {
      ...candidate,
      normalized,
      status: hasAlphaChannel(candidate.value) ? 'unsupported-alpha' : 'unmatched',
    };
  });
}

const FLAG_REASONS = {
  'unsupported-alpha': 'No primitive token matches alpha-bearing colors. Left unchanged: pick the intended token, or add one for this value, before clearing this item.',
  unmatched: 'No primitive token exactly matches this color. Left unchanged: pick the intended token, or add one for this value, before clearing this item.',
};

/** A `var(--color-*)` reference anywhere in a string value. */
const TOKEN_REFERENCE_PATTERN = /var\(--color-[^)]+\)/;

/**
 * The statement a literal belongs to. A flag about a whole collection concerns
 * `export const series = [...]`, not the element found first, so its marker
 * belongs above the declaration rather than inside the object or array.
 */
function enclosingStatementStart(node, sourceFile) {
  let current = node;
  while (current.parent && !ts.isSourceFile(current.parent)) current = current.parent;
  return current.getStart(sourceFile);
}

/**
 * JS/TS color variables that already hold token references. The concern below
 * is a standing property of the code, not an artifact of migrating it, so a
 * second run must still find it rather than call the file clean because it no
 * longer contains a hex.
 */
function collectTokenReferences({ filePath, text, sourceFile, relativePath }) {
  if (isCssFile(filePath) || !sourceFile) return [];
  const references = [];

  (function visit(node) {
    if (ts.isStringLiteralLike(node) && TOKEN_REFERENCE_PATTERN.test(node.text)) {
      const context = colorContextOf(node);
      if (context && context.startsWith('variable:')) {
        const position = enclosingStatementStart(node, sourceFile);
        references.push({
          file: relativePath, line: lineNumber(sourceFile, position), position, context,
        });
      }
    }
    ts.forEachChild(node, visit);
  }(sourceFile));

  return references;
}

/**
 * One review item per JS/TS color collection that holds token references.
 *
 * `var(--token)` only resolves where CSS resolves it: a stylesheet, or a style
 * attribute on an element. The same string handed to a canvas 2D context, an
 * SVG attribute set from script, or a charting library that parses colors
 * itself is not a color at all, and the codemod cannot see the consumer.
 *
 * Both halves feed in -- references this run is about to write, and references
 * already in the file -- and yield one item per collection either way.
 */
function flagJsTokenReferences(report, analyses, references) {
  // References first, so their declaration-level position wins the dedupe over
  // a hex offset mid-collection.
  const items = [
    ...references,
    ...analyses
      .filter((item) => item.status === 'matched' && item.context.startsWith('variable:'))
      .map((item) => ({ ...item, position: item.start })),
  ];

  const seen = new Set();
  for (const item of items) {
    const key = `${item.file}|${item.context}`;
    if (seen.has(key)) continue;
    seen.add(key);
    report.flags.push({
      category: 'js-token-reference',
      file: item.file,
      line: item.line,
      position: item.position,
      value: item.context.slice('variable:'.length),
      context: item.context,
      reason: 'Token references here only resolve in CSS or style attributes; confirm no consumer parses these values itself (canvas, chart library, SVG attribute).',
    });
  }
}

/**
 * Step 3. Turns analyzed candidates into edits, flagging anything without an
 * exact token match. Matching is exact only: an unmatched color is reported for
 * a human to map, never approximated to a visually close token.
 *
 * @returns {{ edits: import('./source.cjs').Edit[], candidates: object[] }}
 */
function collectColorEdits({ filePath, text, sourceFile, relativePath, tokenMap, report }) {
  const analyses = analyzeColorCandidates(
    collectColorCandidates({ filePath, text, sourceFile, relativePath }),
    tokenMap,
  );
  const edits = [];

  for (const item of analyses) {
    if (item.status === 'matched') {
      edits.push({
        start: item.start,
        end: item.end,
        text: tokenReference(item.token),
        reason: 'tokenize-color',
      });
      report.colorReplacements += 1;
      continue;
    }
    report.flags.push({
      category: item.status,
      file: item.file,
      line: item.line,
      position: item.start,
      value: item.value,
      context: item.context,
      reason: FLAG_REASONS[item.status],
    });
  }

  flagJsTokenReferences(
    report,
    analyses,
    collectTokenReferences({ filePath, text, sourceFile, relativePath }),
  );
  return { edits, candidates: analyses };
}

module.exports = { analyzeColorCandidates, collectColorCandidates, collectColorEdits };

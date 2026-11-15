'use strict';

const ts = require('typescript');

const { TODO_MARKER } = require('./config.cjs');
const { isCssFile, newlineOf } = require('./source.cjs');

/**
 * Writes each review flag back into the source as a `TODO(ds-migration)`
 * comment above the line it concerns, so an item is visible to whoever opens
 * the file and not only to whoever reads `report/REPORT.md`.
 *
 * The step reads `report.flags` and nothing else: a transform added later is
 * annotated as soon as it records a flag. It only inserts whole comment lines,
 * never rewrites one, and declines where a comment cannot go safely.
 */

/**
 * Marker prefix used to recognise an item already annotated. It excludes the
 * reason on purpose: rewording guidance must not orphan the marker it already
 * wrote and produce a duplicate.
 */
function todoSignature(flag) {
  return `${TODO_MARKER} ${flag.category}${flag.value ? ` \`${flag.value}\`` : ''}:`;
}

/**
 * The comment text. It carries the flag's own reason and nothing inferred: the
 * codemod never guesses a replacement, so a marker states what was left alone
 * and leaves the decision to whoever picks the item up.
 */
function todoBody(flag) {
  return `${todoSignature(flag)} ${flag.reason} See report/REPORT.md.`;
}

function countOccurrences(text, needle) {
  let count = 0;
  for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + needle.length)) {
    count += 1;
  }
  return count;
}

function lineStartOf(text, position) {
  return text.lastIndexOf('\n', position - 1) + 1;
}

function indentOf(text, lineStart) {
  let end = lineStart;
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end += 1;
  return text.slice(lineStart, end);
}

/**
 * Innermost node whose range *including leading trivia* contains `position`.
 * Trivia matters: an insertion point is the start of a line, so it sits in the
 * whitespace before a node, and that node is the one the comment precedes.
 */
function innermostNodeAt(sourceFile, position) {
  let found = sourceFile;
  (function visit(node) {
    if (node.pos <= position && position < node.end) {
      found = node;
      ts.forEachChild(node, visit);
    }
  }(sourceFile));
  return found;
}

/**
 * True where `//` would be JSX text rather than a comment, and so would render
 * on screen. Only direct membership of a children list counts: inside an
 * attribute list a braced comment would instead be a syntax error.
 */
function isJsxChildPosition(sourceFile, position) {
  const node = innermostNodeAt(sourceFile, position);
  const parent = node.parent;
  if (!parent || !(ts.isJsxElement(parent) || ts.isJsxFragment(parent))) return false;
  return parent.children.indexOf(node) >= 0;
}

const LITERAL_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
]);

/** True when `position` is inside a multi-line literal rather than before it. */
function isInsideLiteral(sourceFile, position) {
  const node = innermostNodeAt(sourceFile, position);
  return LITERAL_KINDS.has(node.kind) && node.getStart(sourceFile) < position;
}

/** The CSS equivalent, by the comment and string rules the declaration reader uses. */
function isInsideCssCommentOrString(text, position) {
  let quote = null;
  for (let index = 0; index < position; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      if (end < 0 || end + 2 > position) return true;
      index = end + 1;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
  }
  return quote !== null;
}

function collidesWithEdit(offset, edits) {
  return edits.some((edit) => offset > edit.start && offset < edit.end);
}

/**
 * Comment lines for a file's flags, as insert-only edits against the original text.
 *
 * @param {{ filePath: string, text: string,
 *   sourceFile: import('typescript').SourceFile | null,
 *   report: import('./report.cjs').Report,
 *   edits?: import('./source.cjs').Edit[] }} input `report` holds this file's
 *   flags; `edits` are the migration edits an insertion must not land inside.
 * @returns {import('./source.cjs').Edit[]}
 */
function collectTodoEdits({ filePath, text, sourceFile, report, edits = [] }) {
  const newline = newlineOf(text);
  const css = isCssFile(filePath);
  const groups = new Map();
  // Markers the file already carries, spent one per matching flag so a value
  // flagged twice still gets its second marker.
  const existing = new Map();

  for (const flag of report.flags) {
    if (typeof flag.position !== 'number') continue;

    const signature = todoSignature(flag);
    if (!existing.has(signature)) existing.set(signature, countOccurrences(text, signature));
    const alreadyWritten = existing.get(signature);
    if (alreadyWritten > 0) {
      existing.set(signature, alreadyWritten - 1);
      continue;
    }

    const lineStart = lineStartOf(text, flag.position);
    const unsafe = css
      ? isInsideCssCommentOrString(text, lineStart)
      : isInsideLiteral(sourceFile, lineStart);
    if (unsafe || collidesWithEdit(lineStart, edits)) continue;

    const body = todoBody(flag);
    const comment = css ? `/* ${body} */`
      : isJsxChildPosition(sourceFile, lineStart) ? `{/* ${body} */}`
        : `// ${body}`;

    if (!groups.has(lineStart)) groups.set(lineStart, []);
    // Two flags can share a line, a category and a value -- the same color
    // twice in one declaration. They are one item to act on, so they get one
    // marker rather than two byte-identical comments.
    const comments = groups.get(lineStart);
    if (!comments.includes(comment)) comments.push(comment);
  }

  return [...groups].map(([lineStart, comments]) => ({
    start: lineStart,
    end: lineStart,
    text: comments.map((comment) => `${indentOf(text, lineStart)}${comment}${newline}`).join(''),
    reason: 'annotate-todo',
  }));
}

/**
 * A review marker must never be the reason a file stops compiling: the caller
 * drops its TODO edits when this returns false.
 */
function verifyAnnotated(filePath, code, parse) {
  if (isCssFile(filePath)) return true;
  try {
    parse(filePath, code);
    return true;
  } catch {
    return false;
  }
}

module.exports = { collectTodoEdits, verifyAnnotated };

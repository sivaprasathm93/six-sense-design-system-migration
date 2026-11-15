'use strict';

const { TODO_MARKER } = require('./config.cjs');
const { lineNumber, mapOffset } = require('./source.cjs');

/**
 * The report is the migration's audit trail: counts of what was rewritten and
 * a flag per item a human has to decide on. Nothing is ever guessed silently --
 * anything the transforms cannot map safely becomes a flag here.
 *
 * @typedef {{ buttonComponents: number, buttonPropValues: number,
 *   colorReplacements: number, todoMarkers: number, flags: object[] }} Report
 */

/** @returns {Report} */
function createReport() {
  return {
    buttonComponents: 0, buttonPropValues: 0, colorReplacements: 0, todoMarkers: 0, flags: [],
  };
}

const COUNTERS = ['buttonComponents', 'buttonPropValues', 'colorReplacements', 'todoMarkers'];

/** Adds `source`'s counts and flags into `target`. */
function mergeReport(target, source) {
  for (const counter of COUNTERS) target[counter] += source[counter];
  target.flags.push(...source.flags);
  return target;
}

/**
 * Records a review item. The offset is kept alongside the line number: the
 * line is for the report, the offset is what the annotation step needs to
 * write the matching marker into the source.
 */
function addFlag(report, source, relativePath, position, category, reason, value) {
  report.flags.push({
    category,
    file: relativePath,
    line: lineNumber(source, position),
    position,
    reason,
    ...(value ? { value } : {}),
  });
}

/**
 * Re-points every flag's line at the file as written. Flags are recorded while
 * transforms walk the original text, but the report is read against the file
 * on disk, and anything inserted above a flagged line -- a split import, a
 * review marker -- moved it.
 */
function relocateFlags(report, code, edits) {
  if (!edits.length) return report;
  for (const flag of report.flags) {
    if (typeof flag.position !== 'number') continue;
    flag.line = lineNumber(code, mapOffset(edits, flag.position));
  }
  return report;
}

/**
 * A unified line diff for the dry run. The dry run is the review gate, so it
 * prints the changed region with `context` unchanged lines around it, not the
 * whole file twice.
 */
function renderDiff(relativePath, before, after, context = 2) {
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length
    && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;

  const lead = Math.min(context, prefix);
  const trail = Math.min(context, suffix);
  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
  const newChanged = newLines.slice(prefix, newLines.length - suffix);

  const lines = [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${prefix - lead + 1},${oldChanged.length + lead + trail} +${prefix - lead + 1},${newChanged.length + lead + trail} @@`,
    ...oldLines.slice(prefix - lead, prefix).map((line) => ` ${line}`),
    ...oldChanged.map((line) => `-${line}`),
    ...newChanged.map((line) => `+${line}`),
    ...oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + trail).map((line) => ` ${line}`),
  ];
  return lines.join('\n');
}

function renderFlag(flag) {
  return `- \`${flag.file}:${flag.line}\` **${flag.category}** \`${flag.value || ''}\` (${flag.context || 'component'}): ${flag.reason}`;
}

/** Markdown hard line break: two trailing spaces. */
const LINE_BREAK = '  ';

/** Two-digit zero-padded field of a local date. */
function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * Local date and time with the UTC offset, e.g. `2026-11-15 14:03:27 +05:30`.
 *
 * Local rather than UTC because the reader of a report is usually whoever ran
 * it; the offset is kept so the stamp stays unambiguous in a PR read from
 * another timezone.
 */
function formatTimestamp(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const absolute = Math.abs(offsetMinutes);
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const offset = `${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  return `${day} ${time} ${offset}`;
}

/**
 * Renders report/REPORT.md for a completed run. `generatedAt` is injectable so a test
 * can assert the stamp without depending on the wall clock.
 */
function renderReport(report, command, target, generatedAt = new Date()) {
  const flags = report.flags.length ? report.flags.map(renderFlag).join('\n') : '- None.';
  return `# Migration report

Generated: ${formatTimestamp(generatedAt)}${LINE_BREAK}
Command: \`${command}\`${LINE_BREAK}
Target: \`${target}\`

## Results

- Legacy Button components migrated: ${report.buttonComponents}
- Button prop values mapped: ${report.buttonPropValues}
- Hex colors replaced with primitive tokens: ${report.colorReplacements}
- Items requiring review: ${report.flags.length}
- Review items marked in the code: ${report.todoMarkers}

## Review items

${flags}

## Verification

The codemod is AST-aware for TypeScript/JavaScript JSX, parses CSS declaration
values, preserves source formatting outside targeted ranges, and supports a
no-write dry run. Run \`npm run check\` (tests, token-layer drift, color lint,
typecheck) before merging. Review all items above; the codemod never guesses a
replacement, so every item here was left exactly as it was found and needs a
deliberate decision (map it to an existing token, or add a token for it).

Each review item is also written into the source as a \`${TODO_MARKER}\`
comment above the line it concerns, so \`grep -rn "${TODO_MARKER}"\` is the
open-debt list even when this report is regenerated. The markers are inserted
whole-line and only once per item, so re-running \`--write\` neither stacks
duplicates nor changes any migrated code. Delete a marker when its item is
resolved; \`--no-todos\` skips the step.

Every \`var(--color-*)\` written by this run is declared in
\`apps/web-dashboard/src/styles/tokens.generated.css\`, generated from the same
token file by \`npm run tokens:css\` and imported by \`styles/theme.css\`. An
undeclared custom property would make the whole declaration invalid at
computed-value time, so \`npm run tokens:check\` fails the build on drift.
`;
}

module.exports = {
  addFlag, createReport, mergeReport, relocateFlags, renderDiff, renderReport,
};

#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { run: emitTokenLayer } = require('./emit-token-layer.cjs');
const { collectTodoEdits, verifyAnnotated } = require('./lib/annotate-todos.cjs');
const { DEFAULTS } = require('./lib/config.cjs');
const { parseTokens } = require('./lib/color.cjs');
const {
  createReport, mergeReport, relocateFlags, renderDiff, renderReport,
} = require('./lib/report.cjs');
const { applyEdits, createSourceFile, isCssFile, toRelativePath, walkFiles } = require('./lib/source.cjs');
const { transformButton } = require('./lib/transform-button.cjs');
const { collectColorCandidates, collectColorEdits } = require('./lib/transform-colors.cjs');

/**
 * Design-system migration codemod.
 *
 * Replaces legacy `@old/ui` Buttons with `@acme/ds` Buttons and maps exactly
 * matching hard-coded hex colors to primitive tokens. Defaults to a dry run.
 *
 * `--write` also regenerates the token layer the new `var(--color-*)`
 * references resolve against, so one command leaves a working app.
 *
 *   node codemods/migrate-design-system.cjs [--dry-run | --write] [--no-todos]
 *     [--root <dir>] [--target <dir>] [--tokens <file>] [--report <file>]
 *     [--token-layer <file>]
 *
 * This file is the program: the public API, the command line, and the run loop.
 * The pieces live in `lib/`:
 *
 *   lib/config.cjs             what may be rewritten (packages, prop and value maps)
 *   lib/transform-button.cjs   Button migration, in four documented stages
 *   lib/transform-colors.cjs   hex -> token migration and color detection
 *   lib/annotate-todos.cjs     review flags -> TODO comments in the source
 *   lib/color.cjs              hex lexing, token map (exact matches only)
 *   lib/report.cjs             counts, review flags, report/REPORT.md rendering
 *   lib/source.cjs             edits, offsets, file walking, TS parsing, CSS reading
 */

const SCRIPT = 'node codemods/migrate-design-system.cjs';

// --- Public API ------------------------------------------------------------

/** CSS has no AST; TS/JS does. A parse failure aborts the file. */
function parseIfPossible(filePath, text) {
  return isCssFile(filePath) ? null : createSourceFile(filePath, text);
}

/**
 * Migrates one file's contents, in three steps: migrate Buttons, migrate
 * colors, then annotate whatever the first two declined to guess at.
 *
 * Every step returns edits against the original text and they are applied
 * together, which is what keeps unrelated formatting, comments, and components
 * untouched.
 *
 * @param {Map<string, string>} tokenMap normalized hex -> token name.
 * @param {{ todos?: boolean }} [options] `todos: false` reports review items
 *   without writing markers into the source.
 * @returns {{ code: string, report: import('./lib/report.cjs').Report, candidates: object[] }}
 */
function transformSource(filePath, text, relativePath, tokenMap, options = {}) {
  const report = createReport();
  const sourceFile = parseIfPossible(filePath, text);
  const ctx = { sourceFile, text, relativePath, report };

  const buttonEdits = sourceFile ? transformButton(ctx) : [];
  const colors = collectColorEdits({ filePath, text, sourceFile, relativePath, tokenMap, report });
  const migrationEdits = [...buttonEdits, ...colors.edits];

  let todoEdits = options.todos === false ? []
    : collectTodoEdits({ filePath, text, sourceFile, report, edits: migrationEdits });
  let code = applyEdits(text, [...migrationEdits, ...todoEdits]);

  // Keep the code, drop the comments: report/REPORT.md still carries the item.
  if (todoEdits.length && !verifyAnnotated(filePath, code, createSourceFile)) {
    todoEdits = [];
    code = applyEdits(text, migrationEdits);
  }
  // One edit can carry several markers when flags share a line.
  report.todoMarkers += todoEdits.reduce((total, edit) => total + (edit.text.match(/\n/g) || []).length, 0);
  relocateFlags(report, code, [...migrationEdits, ...todoEdits]);

  return { code, report, candidates: colors.candidates };
}

/**
 * Hex colors in a file, without migrating anything. This is the detection half
 * of the color migration, reused by `lint-colors.cjs`.
 *
 * @returns {import('./lib/transform-colors.cjs').ColorCandidate[]}
 */
function findColorCandidates(filePath, text, relativePath) {
  return collectColorCandidates({
    filePath,
    text,
    sourceFile: parseIfPossible(filePath, text),
    relativePath,
  });
}

// --- Command line ----------------------------------------------------------

/** Options that take a value, and where the value lands. */
const VALUE_OPTIONS = {
  '--root': (options, value) => { options.root = path.resolve(value); },
  '--target': (options, value) => { options.target = value; },
  '--tokens': (options, value) => { options.tokens = value; },
  '--report': (options, value) => { options.report = value; },
  '--token-layer': (options, value) => { options.tokenLayer = value; },
};

const MODE_OPTIONS = { '--dry-run': 'dry-run', '--write': 'write' };

/** Options that are a bare switch. */
const BOOLEAN_OPTIONS = { '--no-todos': (options) => { options.todos = false; } };

/**
 * Parses the arguments after the script name. An unknown option or a missing
 * value throws, so a typo never silently migrates the default target.
 */
function parseArgs(argv) {
  const options = {
    mode: 'dry-run',
    root: path.resolve(__dirname, '..'),
    target: DEFAULTS.target,
    todos: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (MODE_OPTIONS[flag]) {
      options.mode = MODE_OPTIONS[flag];
    } else if (BOOLEAN_OPTIONS[flag]) {
      BOOLEAN_OPTIONS[flag](options);
    } else if (VALUE_OPTIONS[flag]) {
      if (!argv[index + 1]) throw new Error(`Missing value after ${flag}`);
      VALUE_OPTIONS[flag](options, argv[++index]);
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  return options;
}

// --- Run loop --------------------------------------------------------------

/** Migrates every file under the target in memory, writing nothing. */
function collectChanges(options) {
  const tokenMap = parseTokens(path.resolve(options.root, options.tokens || DEFAULTS.tokens));
  const files = walkFiles(path.resolve(options.root, options.target));
  const report = createReport();
  const changes = [];

  for (const file of files) {
    const before = fs.readFileSync(file, 'utf8');
    const relativePath = toRelativePath(options.root, file);
    const transformed = transformSource(file, before, relativePath, tokenMap, { todos: options.todos !== false });
    mergeReport(report, transformed.report);
    if (transformed.code !== before) {
      changes.push({ file, relativePath, before, after: transformed.code });
    }
  }
  return { report, changes };
}

/** Resolved path of the generated token layer for this run. */
function tokenLayerPath(options) {
  return path.resolve(options.root, options.tokenLayer || DEFAULTS.tokenLayer);
}

/**
 * Emitting the token layer is part of migrating, not a step to remember
 * afterwards: every `var(--color-*)` this run writes is invalid at
 * computed-value time until something declares it, and a forgotten
 * `npm run tokens:css` fails silently in the browser rather than in CI.
 */
function writeTokenLayer(options, logger) {
  return emitTokenLayer({
    root: options.root,
    tokens: options.tokens,
    output: options.tokenLayer,
  }, logger);
}

/** The same emitter in its read-only mode: 0 when the committed layer is current. */
function writeTokenLayerCheck(options, logger) {
  return emitTokenLayer({
    root: options.root,
    tokens: options.tokens,
    output: options.tokenLayer,
    check: true,
  }, logger);
}

function writeChanges(options, report, changes, command, logger) {
  for (const change of changes) fs.writeFileSync(change.file, change.after);
  writeTokenLayer(options, logger);

  const reportPath = path.resolve(options.root, options.report || DEFAULTS.report);
  const reportExists = fs.existsSync(reportPath);
  // A re-run with nothing left to migrate must not churn the committed report.
  // Adding markers does not count: on an already-migrated tree that is the
  // only change left, and reporting it would overwrite the record of the real
  // migration with a row of zeroes.
  const migrated = report.buttonComponents + report.buttonPropValues + report.colorReplacements;
  const writeReport = migrated > 0 || !reportExists;
  if (writeReport) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, renderReport(report, command, options.target));
  }

  logger.log(`Updated ${changes.length} file(s); ${writeReport ? 'wrote' : 'kept'} ${toRelativePath(options.root, reportPath)}.`);
}

function previewChanges(options, report, changes, command, logger) {
  for (const change of changes) {
    logger.log(renderDiff(change.relativePath, change.before, change.after));
  }
  // The layer is checked, never written, so the dry run stays read-only while
  // still saying whether `--write` would regenerate it.
  const silent = { log() {}, error() {} };
  const layerCurrent = writeTokenLayerCheck(options, silent) === 0;
  const layer = toRelativePath(options.root, tokenLayerPath(options));

  logger.log(`\nDry run: ${changes.length} file(s) would change. ${report.buttonComponents} Button(s), ${report.colorReplacements} color(s) mapped, ${report.flags.length} review item(s), ${report.todoMarkers} marker(s) to add. Token layer ${layerCurrent ? 'already current' : 'would be written'}: ${layer}. No files written.`);
  logger.log(renderReport(report, command, options.target));
}

/**
 * Runs the migration. Dry run is the default: `--write` is meant to follow a
 * dry run's preview and report. `logger` is injectable for tests.
 */
function run(options, logger = console) {
  const { report, changes } = collectChanges(options);
  const command = [
    SCRIPT,
    options.mode === 'write' ? '--write' : '--dry-run',
    ...(options.todos === false ? ['--no-todos'] : []),
  ].join(' ');

  if (options.mode === 'write') writeChanges(options, report, changes, command, logger);
  else previewChanges(options, report, changes, command, logger);

  return report;
}

if (require.main === module) {
  try {
    run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  findColorCandidates, parseTokens, run, transformSource, walkFiles,
};

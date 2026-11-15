'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { runLint } = require('../lint-colors.cjs');
const { run: emitTokenLayer } = require('../emit-token-layer.cjs');
const { verifyAnnotated } = require('../lib/annotate-todos.cjs');
const { createReport, renderDiff, renderReport } = require('../lib/report.cjs');
const { createSourceFile } = require('../lib/source.cjs');
const {
  findColorCandidates,
  parseTokens,
  transformSource,
  walkFiles,
} = require('../migrate-design-system.cjs');

const root = path.resolve(__dirname, '../..');
const fixtureRoot = path.join(__dirname, 'fixtures');
const scriptPath = path.join(root, 'codemods/migrate-design-system.cjs');
const tokensPath = path.join(root, 'tokens/primitive-tokens.json');
const tokens = parseTokens(tokensPath);

function fixture(name) {
  return fs.readFileSync(path.join(fixtureRoot, name), 'utf8');
}

function transform(fileName, source) {
  return transformSource(fileName, source, fileName, tokens);
}

/** Migration output without the review markers, so output fixtures stay readable. */
function transformWithoutTodos(fileName, source) {
  return transformSource(fileName, source, fileName, tokens, { todos: false });
}

function flagsOf(report, category) {
  return report.flags.filter((flag) => flag.category === category);
}

test('canonicalizes a legacy Button alias, splits the legacy import, and updates type and JSX references', () => {
  const transformed = transform('button.tsx', fixture('button.input.tsx'));

  assert.equal(transformed.code, fixture('button.output.tsx'));
  assert.equal(transformed.report.buttonComponents, 1);
  assert.equal(transformed.report.buttonPropValues, 1);
  assert.deepEqual(transformed.report.flags, []);
});

test('retains the old local alias if the canonical Button name would collide', () => {
  const input = `import { Button as LegacyButton } from '@old/ui';\nconst Button = () => null;\nexport const Item = () => <LegacyButton variant="primary" />;\n`;
  const transformed = transform('collision.tsx', input);

  assert.match(transformed.code, /import \{ Button as LegacyButton \} from '@acme\/ds';/);
  assert.match(transformed.code, /<LegacyButton intent="brand" \/>/);
  assert.deepEqual(transformed.report.flags, []);
});

test('reports an import collision and leaves the legacy import unchanged', () => {
  const input = `import { Badge as Button } from '@acme/ds';\nimport { Button } from '@old/ui';\nexport const Item = () => <Button variant="primary" />;\n`;
  const transformed = transform('import-collision.tsx', input);

  // Only a review marker is added; every original line survives verbatim.
  assert.equal(transformed.code.replace(/^\/\/ TODO\(ds-migration\).*\n/gm, ''), input);
  assert.match(transformed.code, /^\/\/ TODO\(ds-migration\) import-collision `Button`:/m);
  assert.equal(transformed.report.buttonComponents, 0);
  const collisions = flagsOf(transformed.report, 'import-collision');
  assert.equal(collisions.length, 1);
  // Line 2 in the input; the marker inserted above it moves it to 3, and the
  // report has to name the line as written, not as parsed.
  assert.equal(collisions[0].line, 3);
  assert.equal(transformed.code.split('\n')[2], `import { Button } from '@old/ui';`);
  assert.equal(collisions[0].value, 'Button');
});

test('migrates a namespaced Button to the canonical name while retaining other namespace components', () => {
  const input = `import * as UI from '@old/ui';\nexport const Item = () => <UI.Card><UI.Button variant="danger" /></UI.Card>;\n`;
  const transformed = transform('namespace.tsx', input);

  assert.match(transformed.code, /import \{ Button \} from '@acme\/ds';/);
  assert.match(transformed.code, /<UI\.Card><Button intent="critical" \/><\/UI\.Card>/);
  assert.match(transformed.code, /import \* as UI from '@old\/ui';/);
  assert.equal(transformed.report.buttonComponents, 1);
});

test('rewrites both tags of a namespaced Button element and imports it once per file', () => {
  const input = `import * as UI from '@old/ui';\nexport const Item = () => <><UI.Button variant="primary">Go</UI.Button><UI.Button variant="danger" /></>;\n`;
  const transformed = transform('namespace-pair.tsx', input);

  assert.match(transformed.code, /<Button intent="brand">Go<\/Button><Button intent="critical" \/>/);
  assert.equal((transformed.code.match(/@acme\/ds/g) || []).length, 1);
  assert.equal(transformed.report.buttonComponents, 2);
});

test('reuses an existing canonical Button import for a namespaced Button', () => {
  const input = `import { Button } from '@acme/ds';\nimport * as UI from '@old/ui';\nexport const Item = () => <><Button intent="brand" /><UI.Button variant="danger" /></>;\n`;
  const transformed = transform('namespace-reuse.tsx', input);

  assert.match(transformed.code, /^import \{ Button \} from '@acme\/ds';$/m);
  assert.match(transformed.code, /<Button intent="brand" \/><Button intent="critical" \/>/);
  assert.equal((transformed.code.match(/\bButton\b/g) || []).length, 3);
});

test('falls back to an aliased import when the canonical Button name is taken', () => {
  const input = `import * as UI from '@old/ui';\nconst Button = () => null;\nexport const Item = () => <UI.Button variant="primary" />;\n`;
  const transformed = transform('namespace-collision.tsx', input);

  assert.match(transformed.code, /import \{ Button as AcmeButton \} from '@acme\/ds';/);
  assert.match(transformed.code, /<AcmeButton intent="brand" \/>/);
  assert.match(transformed.code, /^const Button = \(\) => null;$/m);
});

test('merges migrated imports into an existing design-system import', () => {
  const input = `import { Badge } from '@acme/ds';\nimport { Button } from '@old/ui';\nexport const Item = () => <Button variant="primary" />;\n`;
  const transformed = transform('merge.tsx', input);

  assert.match(transformed.code, /import \{ Badge, Button \} from '@acme\/ds';/);
  assert.doesNotMatch(transformed.code, /@old\/ui/);
  assert.equal((transformed.code.match(/@acme\/ds/g) || []).length, 1);
});

test('leaves ButtonProps on the legacy package when Button itself is not imported', () => {
  const input = `import { ButtonProps } from '@old/ui';\nexport type Tone = ButtonProps['variant'];\n`;
  const transformed = transform('props-only.tsx', input);

  assert.equal(transformed.code, input);
  assert.deepEqual(transformed.report.flags, []);
});

test('preserves the quote and semicolon style of the import it rewrites', () => {
  const input = `import { Button as Legacy, Card } from "@old/ui"\nexport const Item = () => <Card><Legacy variant="secondary" /></Card>\n`;
  const transformed = transform('style.tsx', input);

  assert.match(transformed.code, /^import \{ Card \} from "@old\/ui"$/m);
  assert.match(transformed.code, /^import \{ Button \} from "@acme\/ds"$/m);
  assert.equal(transformed.report.buttonComponents, 1);
});

test('migrates .jsx sources and renames shorthand props', () => {
  const input = `import { Button } from '@old/ui';\nexport const Item = () => <Button variant="primary" block />;\n`;
  const transformed = transform('Toolbar.jsx', input);

  assert.match(transformed.code, /import \{ Button \} from '@acme\/ds';/);
  assert.match(transformed.code, /<Button intent="brand" fullWidth \/>/);
  assert.deepEqual(transformed.report.flags, []);
});

test('maps every branch of a conditional variant expression', () => {
  const input = `import { Button } from '@old/ui';\nexport const Item = ({ on }: { on: boolean }) => <Button variant={on ? 'primary' : 'danger'} />;\n`;
  const transformed = transform('conditional.tsx', input);

  assert.match(transformed.code, /intent=\{on \? 'brand' : 'critical'\}/);
  assert.equal(transformed.report.buttonPropValues, 2);
  assert.deepEqual(transformed.report.flags, []);
});

test('leaves the prop name alone when its literal value has no mapping', () => {
  const input = `import { Button } from '@old/ui';\nexport const Item = () => <Button variant="mystery" size="xl" />;\n`;
  const transformed = transform('unknown.tsx', input);

  // Renaming to `intent="mystery"` would look migrated while being
  // unassignable to the new union; the attribute stays visibly un-migrated.
  assert.match(transformed.code, /variant="mystery"/);
  assert.doesNotMatch(transformed.code, /intent=/);
  assert.match(transformed.code, /size="xl"/);
  assert.equal(transformed.report.buttonPropValues, 0);
  assert.deepEqual(flagsOf(transformed.report, 'unknown-variant').map((flag) => flag.value), ['mystery']);
  assert.deepEqual(flagsOf(transformed.report, 'unknown-size').map((flag) => flag.value), ['xl']);
});

test('keeps a re-exported alias so the export does not dangle', () => {
  const input = `import { Button as LegacyButton } from '@old/ui';\nexport { LegacyButton };\nexport const Item = () => <LegacyButton variant="primary" />;\n`;
  const transformed = transform('reexport.tsx', input);

  assert.match(transformed.code, /import \{ Button as LegacyButton \} from '@acme\/ds';/);
  assert.match(transformed.code, /^export \{ LegacyButton \};$/m);
  assert.match(transformed.code, /<LegacyButton intent="brand" \/>/);
});

test('expands a shorthand property instead of renaming the object key', () => {
  const input = `import { Button as LegacyButton } from '@old/ui';\nexport const registry = { LegacyButton };\nexport const Item = () => <LegacyButton variant="primary" />;\n`;
  const transformed = transform('shorthand.tsx', input);

  assert.match(transformed.code, /\{ LegacyButton: Button \}/);
  assert.match(transformed.code, /import \{ Button \} from '@acme\/ds';/);
});

test('keeps a type-only import type-only', () => {
  const input = `import type { Button, ButtonProps } from '@old/ui';\nexport type Tone = ButtonProps['variant'];\nexport type B = typeof Button;\n`;
  const transformed = transform('type-only.tsx', input);

  assert.match(transformed.code, /^import type \{ Button, ButtonProps \} from '@acme\/ds';$/m);
  assert.match(transformed.code, /ButtonProps\['intent'\]/);
});

test('imports the Button once when two namespaces alias the same legacy package', () => {
  const input = `import * as UI from '@old/ui';\nimport * as Legacy from '@old/ui';\nexport const Item = () => <><UI.Button variant="primary" /><Legacy.Button variant="danger" /></>;\n`;
  const transformed = transform('two-namespaces.tsx', input);

  assert.match(transformed.code, /import \{ Button \} from '@acme\/ds';/);
  assert.equal((transformed.code.match(/@acme\/ds/g) || []).length, 1);
  assert.doesNotMatch(transformed.code, /\{ Button, Button \}/);
  assert.match(transformed.code, /<Button intent="brand" \/><Button intent="critical" \/>/);
});

test('removes an emptied legacy import line instead of leaving it blank', () => {
  const merged = transform('blank-merge.tsx', `import * as React from 'react';\nimport { Badge } from '@acme/ds';\nimport { Button } from '@old/ui';\n\nexport const R = () => <Button variant="primary" />;\n`);
  assert.equal(merged.code, `import * as React from 'react';\nimport { Badge, Button } from '@acme/ds';\n\nexport const R = () => <Button intent="brand" />;\n`);

  const split = transform('blank-split.tsx', `import { Button } from '@old/ui';\nimport { Card } from '@old/ui';\nexport const I = () => <Card><Button variant="primary" /></Card>;\n`);
  assert.equal(split.code, `import { Card } from '@old/ui';\nimport { Button } from '@acme/ds';\nexport const I = () => <Card><Button intent="brand" /></Card>;\n`);
});

test('flags spread props on a migrated Button instead of migrating around them', () => {
  const input = `import { Button } from '@old/ui';\nexport const Item = (props: any) => <Button {...props} variant="primary" />;\n`;
  const transformed = transform('spread.tsx', input);

  assert.match(transformed.code, /<Button \{\.\.\.props\} intent="brand" \/>/);
  assert.deepEqual(flagsOf(transformed.report, 'spread-props').map((flag) => flag.value), ['{...props}']);
});

test('treats a prop typed by ButtonProps as safe even when it is used before its declaration', () => {
  const input = `import { Button, ButtonProps } from '@old/ui';\nexport const Item = ({ tone, scale }: Props) => <Button variant={tone} size={scale} />;\ninterface Props { tone?: ButtonProps['variant']; scale?: ButtonProps['size'] }\n`;
  const transformed = transform('order.tsx', input);

  assert.match(transformed.code, /intent=\{tone\} size=\{scale\}/);
  assert.deepEqual(transformed.report.flags, []);
});

test('reports dynamic variant and size expressions instead of rewriting their values', () => {
  const input = `import { Button } from '@old/ui';\nexport const Item = ({ tone, scale }: { tone: string; scale: string }) => <Button variant={tone} size={scale} />;\n`;
  const transformed = transform('dynamic.tsx', input);

  assert.match(transformed.code, /intent=\{tone\} size=\{scale\}/);
  assert.equal(transformed.report.buttonPropValues, 0);
  assert.deepEqual(flagsOf(transformed.report, 'dynamic-variant').map((flag) => flag.value), ['tone']);
  assert.deepEqual(flagsOf(transformed.report, 'dynamic-size').map((flag) => flag.value), ['scale']);
});

test('replaces only contextual color values and preserves identifiers and non-token colors', () => {
  const tsResult = transformWithoutTodos('colors.ts', fixture('colors.input.ts'));
  const cssResult = transformWithoutTodos('theme.css', fixture('theme.input.css'));

  assert.equal(tsResult.code, fixture('colors.output.ts'));
  assert.equal(cssResult.code, fixture('theme.output.css'));
  assert.equal(flagsOf(tsResult.report, 'unmatched').length, 2);
  assert.deepEqual(cssResult.report.flags, []);
});

test('migrates and reports hex colors declared as CSS custom properties', () => {
  const transformed = transform('vars.css', `:root { --brand: #1a73e8; --spacing: 8px; }\n`);

  assert.match(transformed.code, /--brand: var\(--color-blue-500\);/);
  assert.match(transformed.code, /--spacing: 8px;/);
  const candidates = findColorCandidates('vars.css', `:root { --brand: #FF6D00; }\n`, 'vars.css');
  assert.deepEqual(candidates.map((candidate) => candidate.context), ['custom-property:--brand']);
});

test('flags token references written into JavaScript color constants', () => {
  const transformed = transform('chart.ts', `export const chartColors = { primary: '#1a73e8' };\n`);

  assert.match(transformed.code, /var\(--color-blue-500\)/);
  const flags = flagsOf(transformed.report, 'js-token-reference');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].value, 'chartColors');
});

test('marks every review item in the code next to the line it concerns', () => {
  const transformed = transform('colors.ts', fixture('colors.input.ts'));
  const lines = transformed.code.split(/\r?\n/);

  assert.equal(transformed.report.todoMarkers, transformed.report.flags.length);
  for (const flag of transformed.report.flags) {
    // The reported line is the flagged code itself, not one of the markers
    // inserted above it, and the marker for this item sits directly above.
    const code = lines[flag.line - 1];
    assert.doesNotMatch(code, /TODO\(ds-migration\)/, `flag points at a marker: ${code}`);
    const above = lines.slice(0, flag.line - 1).join('\n');
    assert.ok(
      above.includes(`TODO(ds-migration) ${flag.category} \`${flag.value}\`:`),
      `no marker above ${flag.category} ${flag.value} on line ${flag.line}`,
    );
  }
});

test('re-running adds no second marker for an item already marked', () => {
  const once = transform('colors.ts', fixture('colors.input.ts')).code;
  const twice = transform('colors.ts', once);

  assert.equal(twice.code, once);
  assert.equal(twice.report.todoMarkers, 0);
  // The items are still reported; only the markers are not duplicated.
  assert.ok(twice.report.flags.length > 0);
});

test('marks a flag inside JSX children with a brace comment so it is not rendered', () => {
  const input = `import { Button } from '@old/ui';\nexport const Item = ({ tone }: { tone: string }) => (\n  <div>\n    <Button variant={tone} />\n  </div>\n);\n`;
  const transformed = transform('jsx-child.tsx', input);

  assert.match(transformed.code, /^ {4}\{\/\* TODO\(ds-migration\) dynamic-variant `tone`:.*\*\/\}$/m);
  // Still valid TSX: a `//` comment there would have been rendered as text.
  assert.doesNotThrow(() => createSourceFile('jsx-child.tsx', transformed.code));
});

test('marks a flag inside a JSX attribute list with a line comment', () => {
  const input = `import { Button } from '@old/ui';\nexport const Item = (props: any) => (\n  <div>\n    <Button\n      {...props}\n      variant="primary"\n    />\n  </div>\n);\n`;
  const transformed = transform('jsx-attribute.tsx', input);

  // A brace comment between attributes would be a syntax error.
  assert.match(transformed.code, /^ {6}\/\/ TODO\(ds-migration\) spread-props `\{\.\.\.props\}`:/m);
  assert.doesNotThrow(() => createSourceFile('jsx-attribute.tsx', transformed.code));
});

test('declines to mark an insertion point inside a template literal and still reports it', () => {
  const input = 'export const chartColors = { brand: `\n#FF6D00` };\n';
  const transformed = transform('template.ts', input);

  assert.equal(transformed.code, input);
  assert.equal(transformed.report.todoMarkers, 0);
  assert.deepEqual(flagsOf(transformed.report, 'unmatched').map((flag) => flag.value), ['#FF6D00']);
});

test('--no-todos reports review items without writing markers', () => {
  const input = fixture('colors.input.ts');
  const bare = transformSource('colors.ts', input, 'colors.ts', tokens, { todos: false });

  assert.doesNotMatch(bare.code, /TODO\(ds-migration\)/);
  assert.equal(bare.report.todoMarkers, 0);
  assert.equal(bare.report.flags.length, transform('colors.ts', input).report.flags.length);
});

test('a marker that would not parse is dropped rather than committed', () => {
  assert.equal(verifyAnnotated('x.tsx', 'export const a = 1;\n', createSourceFile), true);
  assert.equal(verifyAnnotated('x.tsx', 'export const <;\n', createSourceFile), false);
  // CSS has no parser to check against, so it is accepted on its own terms.
  assert.equal(verifyAnnotated('x.css', 'a { b: }', createSourceFile), true);
});

test('generated files are excluded from the migration and the lint', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-generated-'));
  const target = path.join(temporaryRoot, 'src');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'tokens.generated.css'), ':root { --color-blue-500: #1a73e8; }\n');

  assert.deepEqual(walkFiles(target), []);

  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('the token layer declares every primitive token and detects drift', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-token-layer-'));
  const output = path.join(temporaryRoot, 'tokens.generated.css');
  const quietLogger = { log() {}, warn() {}, error() {} };
  const options = { root: root, tokens: tokensPath, output, check: false };

  assert.equal(emitTokenLayer(options, quietLogger), 0);
  const contents = fs.readFileSync(output, 'utf8');
  for (const [hex, name] of tokens) assert.match(contents, new RegExp(`--color-${name}: ${hex};`));
  assert.equal(emitTokenLayer({ ...options, check: true }, quietLogger), 0);

  fs.writeFileSync(output, ':root { --color-blue-500: #000000; }\n');
  assert.equal(emitTokenLayer({ ...options, check: true }, quietLogger), 1);

  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('every token referenced by the migrated app is declared in the token layer', () => {
  const layer = fs.readFileSync(path.join(root, 'apps/web-dashboard/src/styles/tokens.generated.css'), 'utf8');
  const declared = new Set([...layer.matchAll(/(--color-[\w-]+):/g)].map((match) => match[1]));
  const referenced = new Set();
  for (const file of walkFiles(path.join(root, 'apps/web-dashboard/src'))) {
    const contents = fs.readFileSync(file, 'utf8');
    for (const match of contents.matchAll(/var\((--color-[\w-]+)/g)) referenced.add(match[1]);
  }

  assert.ok(referenced.size > 0);
  assert.deepEqual([...referenced].filter((token) => !declared.has(token)), []);
});

test('flags alpha-bearing colors as unsupported and leaves the value untouched', () => {
  const input = `export const chartColors = { brand: '#1a73e8cc' };\n`;
  const transformed = transform('alpha.ts', input);

  assert.equal(transformed.code.replace(/^\/\/ TODO\(ds-migration\).*\n/gm, ''), input);
  assert.equal(transformed.report.colorReplacements, 0);
  const alphaFlags = flagsOf(transformed.report, 'unsupported-alpha');
  assert.equal(alphaFlags.length, 1);
  assert.equal(alphaFlags[0].context, 'variable:chartColors');
  assert.equal(alphaFlags[0].suggestion, undefined);
  assert.match(transformed.code, /TODO\(ds-migration\) unsupported-alpha `#1a73e8cc`: No primitive token matches alpha-bearing colors\./);
  assert.doesNotMatch(transformed.code, /[Nn]earest/);
});

test('rejects a token file that is not an exact hex color map', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-tokens-'));
  const write = (name, contents) => {
    const file = path.join(temporaryRoot, name);
    fs.writeFileSync(file, contents);
    return file;
  };

  assert.throws(() => parseTokens(write('missing.json', '{"colors":{}}')), /Expected a "color" token object/);
  assert.throws(() => parseTokens(write('array.json', '{"color":[]}')), /Expected a "color" token object/);
  assert.throws(() => parseTokens(write('invalid.json', '{"color":{"brand":"nope"}}')), /Invalid color token "brand"/);

  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('surfaces a parse error with the file and line instead of emitting partial edits', () => {
  assert.throws(
    () => transform('broken.tsx', 'export const Item = () => <div;\n'),
    /^Error: broken\.tsx:1: /,
  );
});

test('dry run writes nothing and a second write run is a no-op', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-migration-'));
  const target = path.join(temporaryRoot, 'apps/web-dashboard/src');
  const fixturePath = path.join(target, 'Sample.tsx');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.join(temporaryRoot, 'tokens'), { recursive: true });
  fs.copyFileSync(tokensPath, path.join(temporaryRoot, 'tokens/primitive-tokens.json'));
  fs.writeFileSync(fixturePath, fixture('button.input.tsx'));

  const run = (mode) => spawnSync(process.execPath, [scriptPath, mode, '--root', temporaryRoot], { encoding: 'utf8' });
  const layerPath = path.join(target, 'styles/tokens.generated.css');
  const before = fs.readFileSync(fixturePath, 'utf8');
  const dryRun = run('--dry-run');
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(fs.readFileSync(fixturePath, 'utf8'), before);
  assert.match(dryRun.stdout, /No files written/);
  assert.match(dryRun.stdout, /Token layer would be written: /);
  assert.equal(fs.existsSync(layerPath), false);
  // The preview is a line diff, not both whole files.
  assert.match(dryRun.stdout, /^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
  assert.match(dryRun.stdout, /^-import \{ Button as LegacyButton, ButtonProps, Card \} from '@old\/ui';$/m);
  assert.doesNotMatch(dryRun.stdout, /^ {0,1}- import/m);

  const firstWrite = run('--write');
  assert.equal(firstWrite.status, 0, firstWrite.stderr);
  const once = fs.readFileSync(fixturePath, 'utf8');
  assert.equal(once, fixture('button.output.tsx'));
  const reportPath = path.join(temporaryRoot, 'report', 'REPORT.md');
  const reportOnce = fs.readFileSync(reportPath, 'utf8');
  assert.match(reportOnce, /Legacy Button components migrated: 1/);
  // A migrated app whose tokens do not resolve is not migrated, so `--write`
  // emits the layer itself instead of leaving it to a remembered command.
  const layerOnce = fs.readFileSync(layerPath, 'utf8');
  assert.match(layerOnce, /^ {2}--color-blue-500: #1a73e8;$/m);

  const secondWrite = run('--write');
  assert.equal(secondWrite.status, 0, secondWrite.stderr);
  assert.equal(fs.readFileSync(fixturePath, 'utf8'), once);
  assert.equal(fs.readFileSync(reportPath, 'utf8'), reportOnce);
  assert.equal(fs.readFileSync(layerPath, 'utf8'), layerOnce);

  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('exits non-zero on an unusable command line instead of migrating with defaults', () => {
  const cli = (...args) => spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });

  const unknown = cli('--bogus');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option: --bogus/);

  const missingValue = cli('--root');
  assert.equal(missingValue.status, 1);
  assert.match(missingValue.stderr, /Missing value after --root/);
});

test('color lint accepts capped documented exceptions and rejects new colors', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-color-lint-'));
  const target = path.join(temporaryRoot, 'apps/web-dashboard/src');
  const sourcePath = path.join(target, 'theme.ts');
  const allowlistPath = path.join(temporaryRoot, 'exceptions.json');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(sourcePath, `export const chartColors = { old: '#ff0000', new: '#123456' };\n`);
  fs.writeFileSync(allowlistPath, JSON.stringify([{
    file: 'apps/web-dashboard/src/theme.ts',
    value: '#ff0000',
    context: 'variable:chartColors',
    maxOccurrences: 1,
  }]));

  const quietLogger = { log() {}, warn() {}, error() {} };
  assert.equal(runLint(temporaryRoot, 'apps/web-dashboard/src', allowlistPath, quietLogger), 1);
  fs.writeFileSync(sourcePath, `export const chartColors = { old: '#ff0000' };\n`);
  assert.equal(runLint(temporaryRoot, 'apps/web-dashboard/src', allowlistPath, quietLogger), 0);

  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('renders a bounded line diff rather than the whole file', () => {
  const before = `a\nb\ncolor: #fff;\ny\nz\n`;
  const after = `a\nb\ncolor: var(--color-white);\ny\nz\n`;
  const diff = renderDiff('x.css', before, after, 1);

  assert.equal(diff, [
    '--- a/x.css',
    '+++ b/x.css',
    '@@ -2,3 +2,3 @@',
    ' b',
    '-color: #fff;',
    '+color: var(--color-white);',
    ' y',
  ].join('\n'));
});

test('stamps the report with the local date, time and UTC offset of the run', () => {
  const command = 'node codemods/migrate-design-system.cjs --write';
  const rendered = renderReport(createReport(), command, 'apps/web-dashboard/src', new Date(2026, 10, 15, 9, 5, 3));

  assert.match(rendered, /^Generated: 2026-11-15 09:05:03 [+-]\d{2}:\d{2} {2}$/m);
  assert.ok(rendered.indexOf('Generated:') < rendered.indexOf('Command:'));
});

test('color lint rejects a stale exception that no longer matches anything', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-color-stale-'));
  const target = path.join(temporaryRoot, 'apps/web-dashboard/src');
  const allowlistPath = path.join(temporaryRoot, 'exceptions.json');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'theme.ts'), `export const chartColors = { ok: 'var(--color-white)' };\n`);
  fs.writeFileSync(allowlistPath, JSON.stringify([{
    file: 'apps/web-dashboard/src/theme.ts',
    value: '#ff0000',
    context: 'variable:chartColors',
    maxOccurrences: 1,
    reason: 'already fixed',
  }]));

  const messages = [];
  const logger = { log() {}, warn() {}, error(message) { messages.push(message); } };
  assert.equal(runLint(temporaryRoot, 'apps/web-dashboard/src', allowlistPath, logger), 1);
  assert.ok(messages.some((message) => /Stale color exception/.test(message)));

  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('color lint rejects an exception that exceeds its documented occurrence cap', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-color-cap-'));
  const target = path.join(temporaryRoot, 'apps/web-dashboard/src');
  const sourcePath = path.join(target, 'theme.ts');
  const allowlistPath = path.join(temporaryRoot, 'exceptions.json');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(sourcePath, `export const chartColors = { a: '#ff0000', b: '#ff0000' };\n`);
  fs.writeFileSync(allowlistPath, JSON.stringify([{
    file: 'apps/web-dashboard/src/theme.ts',
    value: '#ff0000',
    context: 'variable:chartColors',
    maxOccurrences: 1,
  }]));

  const quietLogger = { log() {}, warn() {}, error() {} };
  assert.equal(runLint(temporaryRoot, 'apps/web-dashboard/src', allowlistPath, quietLogger), 1);

  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

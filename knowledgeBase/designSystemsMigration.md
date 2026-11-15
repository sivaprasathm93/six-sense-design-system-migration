# Design-system migration: implementation record

## Overview

This repository now contains a repeatable migration tool for moving the
`web-dashboard` app from legacy `@old/ui` Buttons and hard-coded hex colors to
`@acme/ds` Buttons and primitive color tokens. The migration is deliberately
conservative: Card and Modal remain on `@old/ui`, only exact token matches are
replaced, and values without a safe mapping are reported rather than guessed.

The implementation uses the TypeScript compiler API already available in the
project and Node.js built-ins. It does not depend on textual search-and-replace
for source transformations.

## Changes to the app

### Button migration

Thirteen legacy Button JSX elements were migrated across six files:

| File | Changes |
|---|---|
| [Banner.tsx](../apps/web-dashboard/src/components/Banner.tsx) | Replaced `UI.Button` from the namespace import with a new canonical `Button` import; kept `UI.Card` on the legacy package. |
| [ConfirmDialog.tsx](../apps/web-dashboard/src/components/ConfirmDialog.tsx) | Migrated the two Buttons, including the conditional variant. Updated `ButtonProps['variant']` to `ButtonProps['intent']` so the typed `tone` value follows the new API. |
| [Toolbar.jsx](../apps/web-dashboard/src/components/Toolbar.jsx) | Moved the Button import and mapped its variant and size. The documentation comment was left alone. |
| [Home.tsx](../apps/web-dashboard/src/pages/Home.tsx) | Split the mixed Button/Card import; migrated four Buttons, including shorthand props and single-quoted attributes. Card remains legacy. |
| [Reports.tsx](../apps/web-dashboard/src/pages/Reports.tsx) | Moved the Button into the existing `@acme/ds` import alongside Badge. |
| [Settings.tsx](../apps/web-dashboard/src/pages/Settings.tsx) | Renamed the old `LegacyButton` local alias to `Button` while moving it to `@acme/ds`; Modal remains from `@old/ui`. The pass-through props now derive from the migrated Button. |

The automated API mappings are:

| Legacy API | New API |
|---|---|
| `variant="primary"` | `intent="brand"` |
| `variant="secondary"` | `intent="neutral"` |
| `variant="danger"` | `intent="critical"` |
| `size="sm"` / `"md"` / `"lg"` | `size="small"` / `"medium"` / `"large"` |
| `block` | `fullWidth` |

In total, the tool migrated 13 Button elements and mapped 18 literal
variant/size values. It handles named and aliased imports, changes an old alias
to the canonical local name `Button` when that name is available, and retains
the alias on a binding collision. It splits mixed imports, merges new imports
into an existing `@acme/ds` import when possible, and rewrites
namespace-qualified Button JSX using a collision-safe alias. The tool does not
change unrelated local components named `Button`.

### Color migration

Nineteen exact token matches were changed to CSS custom properties in:

- [theme.css](../apps/web-dashboard/src/styles/theme.css): CSS declaration
  values in color-bearing properties, including colors inside gradients.
- [chartColors.ts](../apps/web-dashboard/src/styles/chartColors.ts): values
  inside the `chartColors` object and color `series`, plus the color embedded
  in `cardBorder`.
- [Legend.tsx](../apps/web-dashboard/src/components/Legend.tsx): values in
  inline color-related style properties.

Values use the format `var(--color-<token-name>)`. Those custom properties are
declared by the generated token layer
[tokens.generated.css](../apps/web-dashboard/src/styles/tokens.generated.css),
emitted from the same token file and imported at the top of `theme.css`;
without it every rewritten declaration would be invalid at computed-value
time. `npm run migrate` regenerates that layer as part of applying the
migration, so the references it writes always resolve; `npm run tokens:css`
regenerates it on its own after a change to the token file. `npm run tokens:check` fails the build if the committed
layer drifts from the token file. Because a `var()` reference only resolves
where CSS resolves it, each JS/TS color collection that received token
references is also reported as a `js-token-reference` review item, so a
consumer that parses colors itself (canvas, chart library, SVG attribute) is
checked by a human.

Token names are loaded
directly from [primitive-tokens.json](../tokens/primitive-tokens.json). Matching
is case-insensitive; three-digit hex values are expanded before comparison.
The CSS scanner only examines recognized color-bearing declarations and skips
comments, quoted strings, selectors, and `url(...)` fragments. TS/TSX/JSX
strings are only considered in color-related style properties or identified
color collections/variables, so unrelated IDs and route fragments are kept.

Three values remain for review because no exact primitive token exists or the
value includes alpha:

| Location | Value | Status |
|---|---|---|
| `styles/chartColors.ts`, `series` | `#FF6D00` | No exact token |
| `styles/theme.css`, `color` | `#1a73e8cc` | Alpha-bearing; no matching token |
| `styles/theme.css`, `background` | `#FF6D00` | No exact token |

Each was left exactly as found and carries a `TODO(ds-migration)` marker; the
codemod proposes no substitute, because choosing one is a design decision. These
three occurrences are listed in [color-exceptions.json](../codemods/color-exceptions.json)
with exact file, value, context, reason, and a one-occurrence cap. Non-color
hashes such as the `#bad` selector, `data-target`, and `anchorId` remain
unchanged.

[REPORT.md](../report/REPORT.md) lists eight review items in total: these three
unmatched/alpha colors, three `js-token-reference` notices for the color
collections in `chartColors.ts`, and two `spread-props` notices for the
`{...props}` / `{...extra}` Buttons in `Settings.tsx`, whose spread objects the
codemod cannot inspect. Both spreads are typed as
`React.ComponentProps<typeof Button>`, so they follow the migrated component's
prop types; the flags record that a human confirmed it.

All eight are also marked in the source as `TODO(ds-migration)` comments above
the lines they concern, so the debt is visible to whoever opens the file rather
than only to whoever reads the report. `grep -rn "TODO(ds-migration)" apps` is
the open-debt list; a marker is removed by resolving its item.

## Tooling added

### Migration command

[migrate-design-system.cjs](../codemods/migrate-design-system.cjs) is the CLI
and the transform API. Commands, options, and module layout are documented in
[README.md](../README.md); the decisions behind them are:

1. **TypeScript AST, not text.** Imports, JSX tags and attributes, and indexed
   `ButtonProps` properties are identified structurally. Edits target only
   their own source spans, so unrelated comments and formatting survive;
   imports are reconstructed only to split or merge, retaining quote and
   semicolon style.
2. **Only known values are mapped.** Literals and both branches of a
   conditional are translated. Unknown literals and untyped dynamic
   expressions stay as they are and are recorded with file and line. A value
   typed as the migrated `ButtonProps['variant']` is already constrained to the
   new vocabulary, so it is treated as safe.
3. **Colors are matched exactly or not at all.** Candidates are classified by
   context, normalized, and compared to the token map. Unmatched and
   alpha-bearing values are reported and marked as open items with no proposed
   replacement, so nobody applies an unapproved color by following a hint.
4. **Review items are written into the source** as `TODO(ds-migration)`
   comments. The step reads only the recorded flags, so it covers categories
   added later without changes.
5. **Edits apply end-to-start**, keeping offsets valid and avoiding any
   reformatting of unrelated source. Reported line numbers are then mapped
   through the applied edits, so they refer to the file as written.

### Color enforcement

[lint-colors.cjs](../codemods/lint-colors.cjs) reuses the codemod's own color
detector, so the lint and the migration cannot disagree about what counts as a
hard-coded color. It fails on newly introduced ones, including hex values
declared as CSS custom properties, and skips generated files.

[color-exceptions.json](../codemods/color-exceptions.json) is what lets that
lint be switched on while three unmigratable colors remain. It is scoped debt,
not a bypass: an entry matches only an exact file, value, and context, its
`maxOccurrences` cap stops the color spreading by copy-paste, and an entry
matching nothing fails the check so an exception cannot outlive the code it
excuses. Resolving one means choosing a real token with design, updating the
source, and deleting both the entry and its `TODO(ds-migration)` marker.

### Fixture tests

The test runner and fixtures are under [codemods/test](../codemods/test).
The suite covers:

- named/aliased and namespace imports, mixed imports, import merging, and
  Button prop/type mappings;
- import-shape preservation: type-only imports stay type-only, a re-exported
  alias is left alone instead of dangling, a shorthand property is expanded
  rather than re-keyed, two namespace aliases import the Button once, and an
  emptied legacy import takes its line with it;
- CSS and TypeScript color replacements, custom-property declarations,
  shorthand/case normalization, false-positive protection, and unmatched-color
  reporting;
- token-layer generation, drift detection, and the invariant that every
  `var(--color-*)` referenced by the app is declared;
- unknown values being reported rather than guessed, with the prop name left
  un-migrated, plus spread-prop and dynamic-value reporting;
- marker placement against the reported line, idempotence on re-run, JSX
  comment syntax, the refusal to annotate inside a template literal,
  `--no-todos`, and the parse-failure fallback;
- dry-run no-write behavior, the bounded line-diff preview, and write-mode
  idempotency including report stability on a second run; and
- enforcement of capped exceptions, rejection of a new hard-coded color, and
  rejection of a stale exception.

## Verification

The baseline `npm run typecheck` passed before applying the migration.
`npm run check` now passes all 43 tests, the token-layer check, color lint
(with the three documented exceptions), and the typecheck. Re-running the
migration from the pre-migration sources reproduces the committed app files
exactly, and the post-migration dry run reports zero files to change.

## Known limitations

Scope boundaries worth stating, since each shapes how far the report can be
trusted: only `#rrggbb` notation is recognized, so `rgba()`/`hsl()`/named
colors are neither migrated nor flagged; color context is a heuristic with good
precision but unmeasured recall; one unparseable file aborts the whole run;
prop-type changes are not propagated across files; and a runtime default
difference between the two packages would change appearance with no flag.
[Known limitations](#known-limitations) describe the relevant boundaries for
interpreting these results.

## Supporting documentation

- [PLAN.md](../PLAN.md) -- codemod sequence and the ten-app, eight-team rollout.
- [README.md](../README.md) -- commands, review markers, color enforcement.
- [.claude.md](../.claude.md) -- repository editing constraints.

# Migration report

Generated: 2026-11-15 13:35:46 +05:30  
Command: `node codemods/migrate-design-system.cjs --write`  
Target: `apps/web-dashboard/src`

## Results

- Legacy Button components migrated: 13
- Button prop values mapped: 18
- Hex colors replaced with primitive tokens: 19
- Items requiring review: 8
- Review items marked in the code: 8

## Review items

- `apps/web-dashboard/src/pages/Settings.tsx:12` **spread-props** `{...props}` (component): Spread props were retained; verify the object uses the new Button prop names and values.
- `apps/web-dashboard/src/pages/Settings.tsx:16` **spread-props** `{...extra}` (component): Spread props were retained; verify the object uses the new Button prop names and values.
- `apps/web-dashboard/src/styles/chartColors.ts:11` **unmatched** `#FF6D00` (variable:series): No primitive token exactly matches this color. Left unchanged: pick the intended token, or add one for this value, before clearing this item.
- `apps/web-dashboard/src/styles/chartColors.ts:3` **js-token-reference** `chartColors` (variable:chartColors): Token references here only resolve in CSS or style attributes; confirm no consumer parses these values itself (canvas, chart library, SVG attribute).
- `apps/web-dashboard/src/styles/chartColors.ts:11` **js-token-reference** `series` (variable:series): Token references here only resolve in CSS or style attributes; confirm no consumer parses these values itself (canvas, chart library, SVG attribute).
- `apps/web-dashboard/src/styles/chartColors.ts:14` **js-token-reference** `cardBorder` (variable:cardBorder): Token references here only resolve in CSS or style attributes; confirm no consumer parses these values itself (canvas, chart library, SVG attribute).
- `apps/web-dashboard/src/styles/theme.css:23` **unsupported-alpha** `#1a73e8cc` (property:color): No primitive token matches alpha-bearing colors. Left unchanged: pick the intended token, or add one for this value, before clearing this item.
- `apps/web-dashboard/src/styles/theme.css:23` **unmatched** `#FF6D00` (property:background): No primitive token exactly matches this color. Left unchanged: pick the intended token, or add one for this value, before clearing this item.

## Verification

The codemod is AST-aware for TypeScript/JavaScript JSX, parses CSS declaration
values, preserves source formatting outside targeted ranges, and supports a
no-write dry run. Run `npm run check` (tests, token-layer drift, color lint,
typecheck) before merging. Review all items above; the codemod never guesses a
replacement, so every item here was left exactly as it was found and needs a
deliberate decision (map it to an existing token, or add a token for it).

Each review item is also written into the source as a `TODO(ds-migration)`
comment above the line it concerns, so `grep -rn "TODO(ds-migration)"` is the
open-debt list even when this report is regenerated. The markers are inserted
whole-line and only once per item, so re-running `--write` neither stacks
duplicates nor changes any migrated code. Delete a marker when its item is
resolved; `--no-todos` skips the step.

Every `var(--color-*)` written by this run is declared in
`apps/web-dashboard/src/styles/tokens.generated.css`, generated from the same
token file by `npm run tokens:css` and imported by `styles/theme.css`. An
undeclared custom property would make the whole declaration invalid at
computed-value time, so `npm run tokens:check` fails the build on drift.

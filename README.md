# Design-system migration

This project contains a codemod for migrating the `web-dashboard` app from
legacy `@old/ui` Buttons and hard-coded hex colors to `@acme/ds` and primitive
color tokens.

## Run the migration

Requirements: Node.js 18 or newer.

From the project root:

```powershell
npm install
npm run migrate:dry-run
npm run migrate
npm run check
```

Review the dry-run preview before applying changes. `npm run migrate` writes
the migration to `apps/web-dashboard/src`, regenerates the CSS token layer the
new `var(--color-*)` references resolve against, and updates the report.

## Commands

| Command | Purpose |
|---|---|
| `npm run migrate:dry-run` | Preview proposed changes and review items; writes nothing. |
| `npm run migrate` | Apply the migration, regenerate the token layer, and generate the report. |
| `npm run tokens:css` | Regenerate the CSS token layer on its own, after changing `tokens/primitive-tokens.json`. |
| `npm run check` | Run migration tests, token check, color lint, and typecheck. |
| `npm test` | Run the codemod tests. |
| `npm run tokens:check` | Check that the generated token CSS matches the token source. |
| `npm run lint:colors` | Check for unapproved hard-coded colors. |
| `npm run typecheck` | Typecheck the app. |

## Where to review results

- The dry-run preview is printed in the terminal.
- [`REPORT.md`](report/REPORT.md) contains the final migration counts and items
  requiring review, stamped with the date and time of the run that produced it.
- `TODO(ds-migration)` comments in `apps/web-dashboard/src` mark review items
  at their source locations.
- `apps/web-dashboard/src/styles/tokens.generated.css` is the generated token
  stylesheet imported by the app.

For implementation details, migration decisions, and future reuse, see the
[knowledge base](knowledgeBase/).

# Migration exercise: web-dashboard

Acme's `web-dashboard` app uses a legacy component library (`@old/ui`) and hard-coded hex colours.
The company is moving to a new design system (`@acme/ds`) and design tokens.

Read the candidate brief (DOCX) for the three tasks, rules and deliverables.

## What is in this repo

- `apps/web-dashboard/src` - the app to migrate (TSX, JSX, TS and CSS)
- `stubs/` - minimal type stubs for `react`, `@old/ui` and `@acme/ds` so the app type-checks offline
- `tokens/primitive-tokens.json` - primitive colour tokens (hex to name)

## Checks

```
npm install
npm run typecheck     # must pass before AND after your migration
```

Do not edit `stubs/` or `tokens/`. Put your tooling in a new top-level folder (for example `codemods/`).

# Design-system migration plan

## Codemod sequence and decision rationale

**Guardrails:** Use `tokens/primitive-tokens.json` as the only color mapping
source; do not edit `stubs/` or `tokens/`. Keep Card and Modal on `@old/ui`.
Baseline and final `npm run typecheck` must pass. Leave uncertain cases
unchanged and report them.

| Step | Action | Why this decision |
|---|---|---|
| 1. Baseline/inventory | Typecheck first. Inventory imports, JSX, props, colors, owners, and validation commands. Parse TS/JSX with the TypeScript compiler API and scan CSS declaration values; record locations and classifications. | Establishes a known baseline and measures scope accurately, including aliases and namespace imports that text replacement cannot safely transform. |
| 2. Button transform | Use the TypeScript compiler API with targeted source-range edits. Map variants `primary/secondary/danger` → `brand/neutral/critical`, sizes `sm/md/lg` → `small/medium/large`, and `block` → `fullWidth`. Split mixed imports; use the canonical local name `Button` when it is available, otherwise retain the alias; preserve quotes and formatting. | AST edits avoid changing comments or the local `Button`. Canonical naming removes misleading legacy labels, while retaining an alias on collision avoids shadowing; narrow import splitting keeps Card/Modal untouched. |
| 3. Uncertain Button cases | Transform only known literals and safe booleans. Keep dynamic/unknown values unchanged; report location and reason. Check related type references (e.g. `ButtonProps['variant']`) and flag unsafe cases. | Expressions have no guaranteed mapping. A visible exception is safer than guessed runtime behavior or a misleading successful typecheck. |
| 4. Color transform | Normalize case and expand `#rgb` before exact token matching. Parse CSS declaration values; in TS/TSX, restrict edits to color-bearing style properties or identified color collections. Replace matches with `var(--color-name)`. Report unmatched values with a perceptual-nearest-token suggestion, never auto-apply it. | Exact mapping is repeatable; context avoids changing selectors, comments, IDs, fragments, and arbitrary strings. Suggestions aid humans without disguising an unapproved color change. |
| 5. Safety and enforcement | Dry run prints diffs/report without writes. Fixture-test mixed/aliased/namespace imports, dynamic props, colors, false positives and unmatched values; assert a second run is a no-op. Add lint/CI checks for in-scope colors with narrow exclusions. | Dry run and fixtures make behavior reviewable; idempotency prevents edit accumulation. Enforcement prevents new debt after migration. |

Use the starter's edge cases as fixtures: mixed Button/Card imports, alias and
namespace imports, conditional/dynamic variants, local `Button`, shorthand and
case differences, unmatched orange, alpha hex, comments, selectors and
fragment hashes. Do not broaden replacements to make these cases pass.

## Ten-app rollout: six Nx apps, four separate repos, eight teams

The constraint that shapes everything below: no feature freeze, and eight teams
with independent deadlines. So the unit of work is one app owned by one team,
the tool is a pinned dependency rather than a shared branch, and no step in the
sequence requires two teams to merge in the same week.

### 1. Finding what is used where, and ordering the apps

Run the codemod in its read-only modes across all ten apps before changing
anything: `--dry-run` produces per-app counts and the full review-item list
without writing, and the color lint's detection half (`findColorCandidates`)
produces per-file color candidates. Both already exist, so the inventory is a
by-product of the tool rather than a separate script that can disagree with it.

Emit one inventory row per app: owning team, legacy Button import sites,
namespace/alias import sites, review items by category (dynamic variant, spread
props, unmatched color, alpha color), hex candidates, test coverage, release
cadence. For the six Nx apps, `nx graph` and `nx show projects --affected`
supply the dependency edges and the shared-library fan-out; the four standalone
repos get the same scanner over a shallow clone.

Order by **review items ascending, not usage count**. An auto-migrated call site
costs review minutes; a flagged one costs a design decision, and the flagged
count is what actually consumes a team's week. Tie-break on blast radius (an app
behind a feature flag before the one on the marketing site) and on release
cadence (a team shipping daily absorbs a revert more cheaply than a team
shipping monthly). Pilot on the app with the highest auto-migration ratio and
the lowest traffic: it exercises the tool end to end while keeping any tool bug
cheap.

### 2. How the tooling reaches each repo, and how PRs are split and sized

**Distribution.** `codemods/` plus `tokens/` is already self-contained — a CLI,
a token file, no app-specific logic — so publish it as a versioned internal
package, `@acme/ds-migrate`, and have every repo invoke it as
`npx @acme/ds-migrate@1.4.2 --write`. No vendored copies and no shared branch:
an exact version in the PR body and in the report header makes a PR reproducible
months later, and shipping the token file inside the package means all ten apps
map against byte-identical input. The Nx apps call the same binary through a
target so `nx affected` bounds CI; the four standalone repos call it from their
own CI. A tool fix is a version bump, never a rebase across ten repos.

**Splitting.** Four PR kinds, always separate, because they need different
reviewers and carry different risk:

1. **Tooling/CI PR** — adds the pinned dependency and the enforcement gates. Platform-team reviewed, once per repo.
2. **Token-layer PR** — the generated `tokens.generated.css` plus the stylesheet `@import` that makes it resolve. Purely additive, so it lands early and independently.
3. **Mechanical rewrite PR** — generated output only, zero judgement calls, with the dry-run diff and report attached. Reviewable as "the tool did this".
4. **Review-item PRs** — one per cluster of flagged items (all dynamic variants in one app, all unmatched colors in one app). These are design decisions, sized for the owning team.

**Ordering inside an app is load-bearing**: the token layer must land before the
rewrite. If the rewrite goes first, every `var(--color-*)` it writes is an
undeclared custom property, which makes the whole declaration invalid at
computed-value time — transparent backgrounds, missing borders, dropped
gradients — while typecheck, unit tests and the color lint all stay green. That
failure happened in this repo, which is why the import is now covered by a test.

**Sizing.** One team's ownership per PR, and roughly 300 changed lines or 15
files as the ceiling; past that, split by directory. The mechanical PR may run
larger when it is genuinely uniform, because review cost scales with the number
of *distinct kinds* of change rather than with lines — but it must contain no
flagged item at all, or reviewers start spot-checking the generated half too.

### 3. Verifying each change before it merges, and rolling back

Every app PR carries the recorded baseline typecheck, the dry-run diff and
report, the pinned tool version, and `npm run check` green (fixtures,
token-layer drift, color lint, typecheck). Two signals matter more than the rest:

- **A second `--write` run changes zero files.** Idempotence proves the tool reached a fixed point rather than a state it will keep editing, and it is cheap to assert in CI.
- **A visual check on the color half.** Tokens are a rendering change no typechecker can see, so the pilot app gets screenshot/Storybook diffs, and each gate added in its wake carries forward to the nine remaining apps.

**Rollback.** Each app PR is one squash commit touching one app, so a revert is
one command with a blast radius of one team. The token-layer PR is additive and
deliberately *not* reverted: reverting a rewrite while the layer stays is always
safe, the reverse is not. Tool defects never roll back merged app PRs — they
roll forward as a new pinned version, with a fixture reproducing the defect
added first, so the same bug cannot reach the apps still queued.

### 4. Measuring progress, the long tail, and stopping new legacy usage

The report is already machine-readable counts, so aggregate it per app into one
burn-down: candidates, auto-migrated, review items open/resolved, and post-merge
legacy Button imports and in-scope hex colors. Track it per team rather than
globally — a global number hides the one team that has not started.

**The long tail is the flagged list**, not the mechanical work: dynamic variants,
spread props, unmatched and alpha colors. Each item gets a named owner and a due
date on the owning team's board. Unmatched colors stay capped the way
`color-exceptions.json` already caps them — by file, value, context and
occurrence count — with an expiry date added, so an exception cannot quietly
become policy, and a stale entry that no longer matches anything fails the lint.

**Stopping new usage** happens in the tooling PR, before any rewrite lands:
`no-restricted-imports` on the legacy Button plus the color lint, both scoped to
changed lines at first (so an unmigrated app can still ship) and promoted to
whole-repo errors the moment that app hits zero. A ratchet, not a freeze — which
is what makes this work without one.

### 5. Where AI assistance helps, and where it does not

**Use it for** triaging the flagged list (grouping items, explaining what a
dynamic call site actually resolves to so a human can decide), turning real
diffs into fixtures, drafting PR descriptions and per-team comms, and reviewing
the codemod itself — the mechanical bugs in this repo's own tool were found
that way.

**Do not use it for** choosing a token for an unmatched color, inferring the
intent behind a dynamic variant, approving a PR, or hand-editing generated
output. Those are exactly the cases the codemod declines on purpose, and a
plausible guess there is indistinguishable from a correct one at review time,
while a wrong token is a silent visual regression that no gate in this plan
catches. Determinism and human review own correctness; AI assistance is
disclosed in the PR description, and anything it suggests is verified against
the source, the fixtures, the lint and the typecheck.

## Exercise scope

For the 6-8 hour exercise, prioritize baseline, conservative transforms,
fixtures, dry-run/report, lint and the starter app's typecheck; reserve time for
exception review and `report/REPORT.md`. Done means baseline and final typecheck
pass, the dry run writes nothing, a second run is a no-op, and
ambiguous/unmatched values are reported without guessing.

# Gate and agents

How Fluid's control plane (`platform/`) gates fork changes and runs its agents. Spec sections 4.3, 6, 7, 8, 9, and 11.

## Workflows

All agent work runs in Workflows, declared in `platform/cloudflare.config.ts` and called through `ctx.exports`. Every run writes its timeline to a `Runs` Durable Object (`GET /api/runs/:runId`), and fork status changes go to the `Fleet` Durable Object, which streams them over `GET /api/fleet/stream`.

| Workflow | Name | One instance per | What it does |
| --- | --- | --- | --- |
| `GateWorkflow` | `fluid-gate` | push (repo, branch, commit) | Runs tiers 1 to 3 against the pushed commit. On a pass `main` fast-forwards to that commit (see "Main only fast-forwards"); on a fail `main` is untouched and a repair starts. `repair/*` branches are only checked, unless the user applies one. |
| `CustomizeWorkflow` | `fluid-customize` | user request | Plans the change (a recipe or the agent model), checks its imports and loads it in an isolate (a model-written change gets up to 2 repairs, see "Customization checks and repairs"), writes `.intent/<id>.json`, has the suggester propose tier 3 tests, waits for the user's decisions, commits on `work/<slug>` with an `Intent-Id:` trailer, records the gate link, pushes, starts the gate, and waits for the gate's (and any repair's) event. |
| `RepairWorkflow` | `fluid-repair` | failed gate | Opens `repair/<short-sha>` with `.repair/<short-sha>.md`, a repair intent record (`relies_on` lists the records it used), and a fix when a rule applies (restore tau, revert a customization that broke the clinical or research floor). It checks the fix in check mode and never merges it; the user applies it. |
| `ReleaseWorkflow` | `fluid-release` | release | Starts one upgrade per fork that still needs the tag, in batches of 20 with a 1 second pause between batches. |
| `UpgradeWorkflow` | `fluid-upgrade` | (tag, fork) | Creates `upgrade/<tag>`, merges the stock tag (the merge agent resolves conflicts), and runs the gate at the new tag. It then fast-forwards `main` if `auto_upgrade` is set, or records a pending upgrade for one-tap approval. On a fail the fork stays pinned and a repair opens. |
| `SeedFleetWorkflow` and `SeedForkWorkflow` | `fluid-seed-fleet`, `fluid-seed-fork` | seed batch, seeded fork | Builds the synthetic demo fleet (see "Demo fleet"). |
| `HarvestWorkflow` | `fluid-harvest` | harvest run | Reads intent records from forks that opted in, clusters them, labels the clusters with the model, and drafts the eligible ones as `harvest/<slug>` branches in `stock`. Each run replaces earlier drafts. |

If a step fails after all its retries, the run is marked `failed` with the error and the instance ends as errored. A run is never left showing `running`.

## Gate integrity

- **Floor source.** Tiers 1 and 2 always come from `stock` at the tag pinned in the fork's `fluid.toml` at the pushed commit. Copies of `tests/` inside a fork are never loaded.
- **Published pins only.** `stock_tag` must be a `vMAJOR.MINOR.PATCH` tag that exists in `stock` and is a recorded release (in the fleet's stock tags or with `releases/<tag>.json`). It is resolved only as a tag (`ls-refs refs/tags/`, peeled), never as a branch or SHA. Anything else fails tier 1 as `stock-tag-published`.
- **Pin monotonicity.** In merge mode (anything that can reach `main`: work branches, upgrades, applied repairs) the pin must be at least `main`'s pinned tag and at least the latest safety release. Otherwise tier 1 fails with probe `pin-monotonic` (`stock_tag gte <floor>`), next to whatever the suites found. Check mode (repair checks, the admin suite) only reports.
- **Runner isolation.** Stock's `tests/runner.ts` runs in its own Worker Loader isolate (`stock-runner:<stock sha>`). That isolate is built only from stock's runner, `app/toml.ts`, and `app/types.ts` at the pinned tag. It has no env and no network. It reaches the fork only through an `ask` callback passed over RPC. The fork runs in a separate isolate with a fresh variant per gate run (`<repo>:<sha>:gate-<nonce>`), never the production isolate, so no module state carries over between production and gates. The fork serializes its card to a JSON string itself and the platform parses it (at most 256 KB), so the gate and production only see plain data.
- **Fork errors and infrastructure errors.** Only problems the fork caused fail a tier: a missing ref, an unusable pin, code that does not build (`ForkCodeError`: transform errors, invalid JSON, no `app/index.ts`), and an invalid tier 3 manifest. Any other error (Artifacts or the loader unavailable, the stock suite failing to run) is thrown, so the workflow step retries it and no repair opens for an infrastructure problem.
- **Time limits.** Each fork call from the platform is limited to 10 seconds, and each sample in the runner to 5 seconds.
- **Tier 3.** Tier 3 is the fork's `tests/user/manifest.json`, always run as tier `user`. It is validated before it runs (the runner's rules, unique ids, positive integer samples). Sample counts are capped at 10 (manifest and per probe) and the list at 20 probes; the tier notes any probes left out. A probe with `"disabled": true` is skipped, and the gate logs it with its `disabledReason` in the run steps and the tier summary.
- **Test ids.** Suggested tests are named `t-<intentId>-<name>` (near-invariant copies `near-<intentId>-<probe>`). Adding accepted tests never replaces a probe that belongs to another intent or that the user wrote; a retried commit may replace its own intent's probes.
- **Model access.** Fork isolates have no model access by default. Only the `:llm` variant, which `POST /api/ask` uses when `useModel` is set, gets the `LLM` capability. `LlmHost` limits model calls to 20 per minute per repo and 200 per minute across the platform.
- **Gateway backstop.** The `fluid` AI Gateway itself allows at most 300 requests per minute (fixed window), set with `cf ai-gateway gateways update fluid --rate-limiting-limit 300 --rate-limiting-interval 60 --rate-limiting-technique fixed`. The update is a full PUT, so it repeats every current setting unchanged (`workers_ai_billing_mode` stays `postpaid`, `byok_only` stays false, no spend limits); rate limiting is not billed. It caps every model caller together, including the platform's own agents, if a code path ever skips the per-repo and global budgets.
- **Repairs.** Repair branches are never merged automatically. Applying one (`POST /api/forks/:repo/repairs/:sha/apply`, or the Apply button) gates it in merge mode, and `main` fast-forwards to it only if every tier passes.

## Customization checks and repairs

Nothing is committed until the planned change passes these checks, so a failed customization never leaves a branch behind (`platform/src/agents/attempts.ts`, `platform/src/agents/imports.ts`, `validateCandidate` in `platform/src/workflows/customize.ts`):

1. **File rules.** At most 3 files, only under `app/`, `intent/`, `policies/`, `connectors/`, or exactly `ui/preferences.json`; each file parses, and `ui/preferences.json` matches its schema.
2. **Static imports.** Every import in a changed runtime file must resolve to a file in the fork's tree or in the change, under the name the module map uses (`foo.ts` is loaded as `foo.js`, JSON keeps its name). Bare package specifiers are rejected. This catches a plan such as a wrapper of `app/cards.ts` that imports a `./cards.base.js` it never wrote, before any isolate loads.
3. **Load and smoke test.** The fork is loaded with the change overlaid in a throwaway isolate variant and must answer one question with the card contract.

For a model-written change, any failure in these steps (or a plan that is not valid JSON) goes back to the model with the exact error, at most 2 times. A recipe runs once. If the change still fails, the run ends as `failed` with a plain explanation in `error` and a "Nothing committed" step: what was attempted, why it could not be loaded (first line of the error, no stack, tokens redacted), and what to try. A recipe that cannot apply (the REDCap connector already exists, a fifth tab) ends the same way.

The planner prompt states that look and layout (fonts, density, colors, tabs, charts, dashboards) never go into answer card code, that card JSON stays the stock contract, and that such requests write only `ui/preferences.json`.

## UI preferences

`ui/preferences.json` is a declarative, fork-owned file that changes how the control plane looks for the fork's owner (schema in `platform/src/ui/preferences.ts`, described in `docs/UI.md`). It is never runtime code: the loader ignores it and no fork code runs in the browser.

- **Recipe.** Requests about fonts, density, accent colors, or a tab with charts or a dashboard match the `ui` recipe (`platform/src/agents/ui-recipe.ts`), checked after the REDCap and tau recipes. It maps the request onto the closest allowlisted values, merges them into the current file (a tab with the same title is replaced; a fifth tab is refused), and records each mapping in the run, the diff note, and the intent record's `mapped` field. For example, "Always use palatino lino type kind of fonts and add a tab with charts" maps "palatino lino type kind of fonts" to the `palatino` stack and "a tab with charts" to a tab titled "Charts" with the default set of all 6 widgets. Named widgets ("override rate and confidence") narrow the set, and "called X" names the tab.
- **Intent and tests.** The build-time intent lists `ui/preferences.json` and the record, with no modes affected. The suggester proposes one tier 3 probe of kind `config` with `file: "ui/preferences.json"`, asserting each preference (`font equals palatino`, `tabs some title equals Charts`).
- **Tier 3 on the platform.** Stock's runner reads config probes as TOML only, so stock is unchanged: the gate splits config probes whose `file` is `ui/preferences.json` out of the tier 3 manifest, evaluates them on the platform against the parsed file with the runner's assertion semantics (`platform/src/gate/ui-check.ts`, checked against the runner in `test/ui-gate.test.ts`), and merges the results into the user tier.
- **Tier 1 platform invariant.** When the pushed commit has `ui/preferences.json`, tier 1 gains probe `ui-preferences-valid`. An invalid file (bad JSON, a value off the allowlist, an unknown key, too many tabs or widgets) fails it with `op: "schema"`, the file, and the schema errors, next to whatever the stock suites found.

## Main only fast-forwards

`main` moves only to a commit a gate passed, and only by fast-forward (`git push` without force, so the remote refuses it if `main` moved meanwhile):

- **Work branches.** If `main` moved after the branch was cut, the gate merges `main` into the branch, pushes that merge commit to the branch (never to `main`), and starts a gate for it. That gate runs at the pin the merged `fluid.toml` names and fast-forwards `main` if it passes. A conflict ends the run as failed with the conflicting files; nothing merges.
- **Upgrades.** With `auto_upgrade`, the upgrade fast-forwards `main` to the gated `upgrade/<tag>` commit. If `main` moved, it merges `main` into `upgrade/<tag>` and gates again (at most 2 extra rounds).
- **One-tap approval.** A passed upgrade without `auto_upgrade` is stored as the fork's `pendingUpgrade` (`{tag, commit, runId}`), apart from `lastRun`, which later runs overwrite. `POST /api/forks/:repo/upgrade` fast-forwards `main` to that commit and refuses with 409 when `main` is no longer an ancestor of it.
- **Customizations.** Before committing, the customization checks the planned files against `main`'s current files. A recipe (REDCap, tau) is applied again on the current files; a model plan whose files changed on `main` is refused with "run the request again". A retried commit step reuses a pushed commit whose `Intent-Id` matches instead of committing again.

## Safety fallback

Spec 7's grace period is enforced. When the newest safety release whose grace period has ended is newer than a fork's pinned tag, and the fork has no passed upgrade to it waiting for approval, `POST /api/ask` on the fork's `main` is answered by `stock` at that release. The card carries the signal `safety_fallback:stock` and a framing line, the UI shows it as a notice, and the ledger records the signal. Asking a named branch is not redirected. As a backstop, the platform never serves a card (or alternative) in clinical mode with a computed dose: it refuses the fork's answer, answers with `stock` at the fork's pin, and marks the card `safety_guard:clinical_dose`.

## Harvest is opt-in

Stock's `fluid.toml` ships `harvest_opt_in = false`, new forks write both preferences explicitly (default false), and a missing `harvest_opt_in` reads as false. The harvester reads only forks that set it to true; seeded forks opt in explicitly in their `fluid.toml`. A cluster is never drafted when any member touched the floor: `fluid.toml`, `intent/`, the clinical and research policy paths, the registry, the runner's stock modules (`app/toml.ts`, `app/types.ts`), or stock suites under `tests/` (a fork's `tests/user/` is not floor). A draft copies only the runtime files that the reference fork's matching intent record lists.

## Routes added in Stage 3

```
POST /api/customize                 {repo, request} -> {runId}             session (own fork) or admin
GET  /api/forks/:repo/ui            -> {repo, commit, path, present, valid, preferences, errors?}   validated ui/preferences.json on main
GET  /api/me/charts                 -> chart aggregates for the session's own fork (ledger, intents, gates)
GET  /api/runs/:runId               -> Run
POST /api/suggestions/:runId/decide {testId, decision, edited?} -> Run     edit sends edited: {assert: [...]}
GET  /api/gates/:repo               -> GateResult[] (newest first, last 20)
POST /api/gates/:repo               {branch, commit?} -> {runId, created}  direct gate trigger (local dev has no queue delivery)
POST /api/forks/:repo/upgrade       -> one-tap fast-forward to the fork's pendingUpgrade
POST /api/forks/:repo/repairs/:sha/apply -> {runId, branch, commit}       gate repair/<sha> in merge mode; main fast-forwards on pass
POST /api/admin/stock/publish       {tag?, notes?, safety?}               publish the bundled stock source
POST /api/admin/release             {tag, notes, safety} -> {tag, upgradeRuns, runId}
POST /api/admin/fleet/seed          {count} -> {created, batch, runId}     default 200, cap 500
POST /api/admin/fleet/cleanup       {batch?} -> {deleted, failed}          deletes seeded forks only (user-seed-*)
POST /api/admin/harvest             -> {runId}
GET  /api/harvest                   -> HarvestProposal[]
```

The fleet view shows these fork statuses: `provisioning`, `pinned` (idle on its tag), `upgrading`, `gating`, `passed` (`pendingUpgrade` is set while the upgrade waits for approval), `failed`, and `repair_open`. `POST /api/ask` cards on a redirected fork carry `fork.servedBy` and `fork.safetyFallback`.

## Releases

`POST /api/admin/stock/publish` and `POST /api/admin/release` write `releases/<tag>.json` into `stock` with the notes, the safety flag, the date, and, for a safety release, a 14-day grace period with its `graceUntil` date. The demo release takes the latest stock content and:

- makes one wording change to the multi-intent framing in `app/cards.ts`, with a different phrasing on each release, so forks that customized the same line conflict on purpose;
- tightens the floor: it appends the probes in `stock/overlays/demo-release/invariants.json` (`inv-research-cross-check-visible` and two paraphrases: a research dose answer shows its per-source cross-check in the body) to `tests/invariants/manifest.json` when they are missing. The overlay is never published as stock content; stock passes it (`stock/tests/unit/demo-overlay.test.ts`);
- keeps `harvest_opt_in = false` in stock's `fluid.toml`.

The release intent record lists the changed files and the tightened probes. Upgrade instances are keyed by (tag, fork), and a release skips forks already on the tag, waiting to approve it, or already upgraded or repaired at it, so running it again only reaches new forks.

The merge agent resolves conflicts with the agent model when there are at most 3 conflicted files and the merge agent's budget of 30 model calls per minute allows it. Otherwise it uses a fixed rule:

- Keep the fork's version of any file that an intent record lists.
- Take stock's version of every other file.
- Always keep the fork's `fluid.toml`, with `stock_tag` moved to the new tag.

In both cases the gate decides whether the result ships.

## Demo fleet

`POST /api/admin/fleet/seed` builds forks that are honest about the floor:

- Seeded forks pin the newest release whose invariants do not yet include the demo tightening (on a fresh account, the latest release). An older tag is set up by moving the fork's `main` back to that tag's commit before onboarding.
- Customizations on `main` (REDCap, budget summary, plain wording, raised tau, compact research answers) all pass the floor at the fork's pin. No seeded customization computes a clinical dose.
- `compact-research` drops the per-source cross-check lines from research bodies. It passes its pinned floor and fails only the invariant the demo release adds, so on release day those forks stay pinned with a repair branch that reverts the research customization (its check passes at the new tag).
- `lower-tau` never reaches `main`: it is pushed to `work/seed-lower-tau-<n>`, the gate fails it on `inv-tau-config-floor`, and a repair (restore tau) opens. `main` stays clean, so these forks upgrade normally.

## Events

`node platform/scripts/setup-events.mjs` creates the queues `fluid-events` and `fluid-events-dlq` and the account-level Artifacts subscription `fluid-artifacts-pushed` (`repo.pushed` to that queue). It only creates what is missing, so it is safe to run more than once. The consumer ignores the following:

- namespaces other than `fluid`
- repos that do not start with `user-`
- pushes to `main` (the gate's own merges)
- tag pushes
- `upgrade/*` branches (the upgrade workflow gates them itself)
- `repair/*` branches (the repair workflow checks them; applying one is an explicit request)
- deleted branches

Gate instance ids come from (repo, branch, commit). So a direct trigger and the event for the same push start only one gate. A gate that errored is started again under a new id. Before a workflow pushes, it records which run made the push (`gatelink_<repo>_<commit>_<branch hash>` in the Runs namespace), so a gate the event starts first still reports to that run and links its repair. Gates and repairs send `gate-finished` and `repair-finished` events to a waiting customize run, which also checks the run record after each wait (30 waits of 1 minute at most).

Messages that still fail after 5 deliveries go to the dead letter queue `fluid-events-dlq` (configured on the consumer in `cloudflare.config.ts`; `setup-events.mjs` creates the queue).

## Measured locally

These numbers come from `cf dev` with Artifacts and AI remote. The first table is the latest run of `scripts/e2e-stage3.mjs --seed 30` after the Stage 3 review fixes (release v1.8.0, 31 forks, seeds pinned to v1.5.0):

| Step | Time |
| --- | --- |
| Provision a fork | 7 s |
| REDCap customization from request to fast-forward of main, including the test decisions | 15 s |
| Lower-tau customization through the failed gate and the linked repair | 12 s |
| Seed 30 forks (settled: customized on main, or a failed work branch with its repair open) | 12 s |
| Release and upgrade 31 forks | 64 s, with all 31 upgrading or gating at once; first upgrade finished after 8 s |
| Apply a repair (gate in merge mode, fast-forward main) | 5 s |
| Harvest across 31 forks | 12 s |

Of the 31 forks, 30 passed, 6 of them after the merge agent resolved a conflict. The one compact-research seed failed only `inv-research-cross-check-visible` and stayed pinned with a repair branch; applying that repair moved its `main` to the new tag. The lowered-tau seed's `main` stayed clean (its change failed on a work branch), so it upgraded normally. Earlier, before the fixes, `--seed 200` upgraded 202 forks in 159 s with up to 110 in flight.

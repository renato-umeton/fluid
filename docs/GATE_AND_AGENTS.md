# Gate and agents

How Fluid's control plane (`platform/`) gates fork changes and runs its agents. Spec sections 4.3, 6, 7, 8, 9, and 11.

## Workflows

All agent work runs in Workflows, declared in `platform/cloudflare.config.ts` and called through `ctx.exports`. Every run writes its timeline to a `Runs` Durable Object (`GET /api/runs/:runId`), and fork status changes go to the `Fleet` Durable Object, which streams them over `GET /api/fleet/stream`.

| Workflow | Name | One instance per | What it does |
| :-- | :-- | :-- | :-- |
| `GateWorkflow` | `fluid-gate` | push (repo, branch, commit) | Runs tiers 1 to 3 against the pushed commit. On a pass `main` fast-forwards to that commit (see "Main only fast-forwards"); on a fail `main` is untouched and a repair starts. `repair/*` branches are only checked, unless the user applies one. |
| `CustomizeWorkflow` | `fluid-customize` | user request | Plans the change (a recipe or the agent model), checks its imports and loads it in an isolate (a model-written change gets up to 2 repairs, see "Customization checks and repairs"), writes `.intent/<id>.json`, has the suggester propose tier 3 tests, waits for the user's decisions, commits on `work/<slug>` with an `Intent-Id:` trailer, records the gate link, pushes, starts the gate, and waits for the gate's (and any repair's) event. |
| `RepairWorkflow` | `fluid-repair` | failed gate or yellow rollback | Opens `repair/<short-sha>` with `.repair/<short-sha>.md`, a repair intent record (`relies_on` lists the records it used), and a fix when a rule applies (restore tau, revert a customization that broke the clinical or research floor). A yellow repair works differently (see "Yellow to green"). It checks the fix in check mode and never merges it; the user applies it. |
| `ReleaseWorkflow` | `fluid-release` | release | Starts one upgrade per fork that still needs the tag, in batches of 20 with a 1 second pause between batches. |
| `UpgradeWorkflow` | `fluid-upgrade` | (tag, fork) | Creates `upgrade/<tag>`, merges the stock tag (the merge agent resolves conflicts), and runs the gate at the new tag. It then fast-forwards `main` if `auto_upgrade` is set, or records a pending upgrade for one-tap approval. On a fail the fork stays pinned and a repair opens. |
| `SeedFleetWorkflow` and `SeedForkWorkflow` | `fluid-seed-fleet`, `fluid-seed-fork` | seed batch, seeded fork | Builds the synthetic demo fleet (see "Demo fleet"). |
| `YellowWorkflow` | `fluid-yellow` | change landed on main (repo, commit) | Runs the end-to-end tiers against the live fork 3 times with a 10 second pause, plus the browser checks once. All passes turn the fork green; a failure the fork caused, or a soak that cannot finish, rolls `main` back to the last green commit and opens a repair (see "Yellow to green"). |
| `HarvestWorkflow` | `fluid-harvest` | harvest run | Reads intent records from forks that opted in, clusters them, labels the clusters with the model, and drafts the eligible ones as `harvest/<slug>` branches in `stock`. Each run replaces earlier drafts. |

If a step fails after all its retries, the run is marked `failed` with the error and the instance ends as errored. A run is never left showing `running`.

## Gate integrity

- **Floor source.** Tiers 1 and 2 always come from `stock` at the tag pinned in the fork's `fluid.toml` at the pushed commit. Copies of `tests/` inside a fork are never loaded.
- **Published pins only.** `stock_tag` must be a `vMAJOR.MINOR.PATCH` tag that exists in `stock` and is a recorded release (in the fleet's stock tags or with `releases/<tag>.json`). It is resolved only as a tag (`ls-refs refs/tags/`, peeled), never as a branch or SHA. Anything else fails tier 1 as `stock-tag-published`.
- **Pin monotonicity.** In merge mode (anything that can reach `main`: work branches, upgrades, applied repairs) the pin must be at least `main`'s pinned tag and at least the latest safety release. Otherwise tier 1 fails with probe `pin-monotonic` (`stock_tag gte <floor>`), next to whatever the suites found. Check mode (repair checks, the admin suite) only reports.
- **Runner isolation.** Stock's `tests/runner.ts` runs in its own Worker Loader isolate (`stock-runner:<stock sha>`). That isolate is built only from stock's runner, `app/toml.ts`, and `app/types.ts` at the pinned tag. It has no env and no network. It reaches the fork only through an `ask` callback passed over RPC. The fork runs in a separate isolate with a fresh variant per gate run (`<repo>:<sha>:gate-<nonce>`), never the production isolate, so no module state carries over between production and gates. The fork serializes its card to a JSON string itself and the platform parses it (at most 256 KB), so the gate and production only see plain data.
- **Fork errors and infrastructure errors.** Only problems the fork caused fail a tier: a missing ref, an unusable pin, code that does not build (`ForkCodeError`: transform errors, invalid JSON, no `app/index.ts`), and an invalid tier 3 manifest. Any other error (Artifacts or the loader unavailable, the stock suite failing to run) is thrown, so the workflow step retries it and no repair opens for an infrastructure problem.
- **Time limits.** Each fork call from the platform is limited to 10 seconds, and each sample in the runner to 5 seconds.
- **Tier 3.** Tier 3 is the fork's `tests/user/manifest.json`, always run as tier `user`. It is validated before it runs (the runner's rules, unique ids, positive integer samples, and the regex limits: a `notMatches` pattern of at most 200 characters with no group that repeats an unbounded quantifier without bound, such as `(a+)+`). The platform checks the regex limits itself too, because a fork may pin a stock tag whose runner predates them (`platform/src/gate/regex.ts`). Sample counts are capped at 10 (manifest and per probe) and the list at 20 probes; the tier notes any probes left out. A probe with `"disabled": true` is skipped, and the gate logs it with its `disabledReason` in the run steps and the tier summary.
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

## Yellow to green

Every change that passes the gate goes live on `main` at once, in a **yellow** state with a visible badge. That covers customizations (the gate fast-forward), auto upgrades, one-tap upgrades, and repair applies. A slower end-to-end regression suite then runs against the live fork in the background (`platform/src/workflows/yellow.ts`, one `YellowWorkflow` per landed commit, keyed by repo and commit).

```mermaid
stateDiagram-v2
  [*] --> green: fork with no history
  green --> yellow: a gated change lands on main
  rolled_back --> yellow: the next gated change lands
  yellow --> yellow: soak pass n of 3
  yellow --> yellow: a newer change lands (older run cancelled)
  yellow --> green: 3 consecutive passes
  yellow --> rolled_back: a scenario or browser check fails
```

- **State.** The `Fleet` entry of each fork carries `health` (`yellow`, `green`, or `rolled_back`), `lastGreenCommit`, the soak progress (`pass` of `of`), the active run, the failure, and the browser tier result, plus a history of events (`GET /api/forks/:repo/health`). Every change is broadcast on the fleet stream. The transitions are pure code in `platform/src/yellow/state.ts`. Forks with no history read as green at their current `main`; the commit before their first landed change becomes their last green commit. After a rollback the revert commit becomes the last green commit: its tree is the green tree plus the rollback intent record, so a later rollback keeps that record.
- **Landing.** The fork's pin moves to the change's tag before its soak starts, so the pin a fast rollback restores is never overwritten afterwards. A merge step, upgrade step, or one-tap request that is retried after its push succeeded finds `main` already at the commit with no soak for it, and starts the soak then (`platform/src/yellow/landing.ts`). One-tap keeps the pending upgrade until the soak has started, so a repeated tap can still start it.
- **Soak.** Three consecutive passes of every end-to-end tier, with a 10 second pause between them. The browser tier runs once per yellow period, after the first pass. Each pass is recorded on the run (`passes[]`) with every scenario, its steps, their latencies, and any latency warnings. A retried record step that finds the fork already green at this commit counts as the pass it recorded.
- **Retryable failures.** Only failures the fork caused roll back: an assertion on the fork's output, an error the fork's code threw, or code that does not build. Host errors (Artifacts, the loader, the network), step timeouts, and steps slower than 3 times their latency budget are retryable; a step over its budget but under that cap is only a warning. The stock runner marks these failures itself (from v1.11.0), and the platform infers the same marks for older runners (`failureRetryable` in `platform/src/yellow/tiers.ts`). A pass that fails only for retryable reasons runs once more in a fresh runner isolate. If that run also fails only for retryable reasons, the step retries with backoff.
- **Errors.** A soak that still cannot finish after its step retries is treated as a failure: `main` rolls back with the failure `platform yellow run` and a repair opens, because a change that cannot be verified must not stay live. If the rollback itself fails, the failure is recorded with no revert, the fork stays yellow with no run, and an admin re-check starts a new soak. An errored yellow instance is started again under a new id when the change lands again.
- **Rollback.** On a failure, if `main` is still at the yellow commit, `main` moves back to the last green commit's tree with a new revert commit on top of the yellow commit. History is kept and the push is never forced, so the remote refuses it if `main` moved meanwhile. The revert commit carries a build-time intent record (`agent: "yellow-rollback"`, `relies_on` the change's intent records, the failed scenario and step). The fork's pinned tag in the fleet follows the restored `fluid.toml`. A retried roll back step recognizes its own revert on `main` (parent is the yellow commit, authored by the yellow soak, message naming the run) and records it instead of deciding again.
- **Repair.** Then the Repair workflow opens `repair/<short sha>` with reason `yellow`, the failing scenario and step as its failures, and the change's intent records as `relies_on`. A yellow repair relies only on those records, never on older customizations. It starts from `main` as the rollback left it and writes no files (rule `keep-green`), because reverting files to stock could undo older customizations that were green. Its note says so: applying it keeps `main` on the last green tree and records the diagnosis, and the change comes back only when the user reworks it and runs the request again.
- **Newer changes.** A change that lands while an older one is still soaking supersedes it: the older run stops at its next check (status `cancelled`), and the newer run decides for both. Its last green commit is still the one before the older change.
- **No earlier green commit.** When there is nothing to roll back to (an admin re-check of a fork's current `main`), the failure is recorded, the fork stays yellow with no run, and a repair opens. Each admin re-check is its own run (a nonce in the instance id), even for a commit whose earlier soak finished.
- **Baseline.** Forks that existed before Stage 6 read as green without ever passing the suite. `POST /api/admin/fleet/baseline` runs one dry pass against each fork's `main`, a page of at most 25 forks at a time (`scripts/baseline.mjs` pages through the whole fleet), with the same retry of retryable failures. It records the result on the fork's fleet entry (`baseline`, shown in the fork detail and in `GET /api/forks/:repo/health`, counted in the fleet snapshot's `baselineCounts`). A fork that fails is flagged for review; nothing is rolled back and no fork's `main` or health changes. A result with only retryable failures flags nothing and is reported as inconclusive.

### Who owns the suite

The mothership owns it. Stock ships the core suite in `tests/e2e/manifest.json` and its pure runner `tests/e2e/runner.ts`. The platform reads both from stock at the fork's pinned tag, never from the fork, like tiers 1 and 2, and runs the runner in its own Worker Loader isolate (`stock-e2e-runner:<stock sha>`) built only from stock files. The runner reaches the live fork and the platform through one host callback over RPC.

| Tier | Source | Notes |
| :-- | :-- | :-- |
| `stock` | `tests/e2e/manifest.json` in stock at the pinned tag | The core suite. |
| `platform` | `PLATFORM_SCENARIOS` in `platform/src/yellow/tiers.ts` | Runs instead of the stock tier when the pinned tag predates the suite (an empty stock suite). The runner then comes from the stock source bundled into the platform. |
| `user` | `tests/user/e2e.json` in the fork at the yellow commit | Extra scenarios from the user or the test suggester. A scenario cannot reuse a stock or platform id (it is rejected and logged); `"disabled": true` skips it and logs its `disabledReason`; at most 10 run. |

Steps that touch platform state act for a synthetic test user scoped to the run (`e2e-<run id>`): asks go through the platform's own ask path (the same safety guard users get) at the yellow commit, and overrides and ledger reads use that user's own ledger. The real user's ledger never sees a soak.

### Scenario format

A scenario is an ordered list of steps with assertions on each step's result and references to earlier steps (`"$ask.answer_id"`) or the live fork (`"$live.commit"`, `"$live.stockTag"`). Step kinds: `ask` (request with context, `explicitMode`, `attestation`, optional `withHistory` for multi-turn, optional `focusMode`), `override` (records the override, optionally asks again in that mode), `ledger`, `intents`, and `config` (`fluid.toml` and `ui/preferences.json`, validated the way the platform reads them). `requires: { "connector": "redcap" }` skips a scenario or step when the fork has no such connector. Every step has a latency budget and a time limit; over the budget is a warning, and only 3 times the budget fails, as a retryable failure. User scenarios follow the same regex limits as tier 3. Details in `stock/README.md`.

The stock suite covers: each mode answering with its contract (clinical, research with a two-source cross-check, administrative with a committee policy), the multi-intent view, the attestation flow, overrides reaching the ledger and the re-ask holding the number at the bedside, the clinical no-dose rule across a three-turn conversation, ledger records whose `fork_commit` equals the live commit and whose `stock_tag` is the pinned tag, the intent ledger, valid config files, the REDCap connector when present, the synthetic notice, and a latency budget per step.

### Browser checks

`platform/src/yellow/browser.ts` drives a real headless browser through Browser Rendering (`BROWSER` binding, `@cloudflare/puppeteer`), once per yellow period:

1. load the app for the fork's user and see the fork in the top bar;
2. ask the bedside question with a chart open and see a clinical card with no dose and an override control;
3. see the fork's UI preferences render (font, density, accent, and the tabs under **Your tabs**);
4. see no console errors.

The browser signs in with a short-lived signed test session (at most 15 minutes, scoped to the run): a synthetic user that can read and ask that one fork, whose answers go to its own ledger, and that cannot change anything. The app URL is the deployment's configured `PUBLIC_ORIGIN` (a text binding set from `FLUID_PUBLIC_ORIGIN` at deploy time; request traffic never changes it). The browser asks the fork's `main`, which is the yellow commit while the run is current (the run checks this before every pass), so it tests the change itself. The tier is `unavailable` when there is no binding, no `PUBLIC_ORIGIN`, Browser Rendering cannot start a browser, or the URL is local (`cf dev`); then the API tiers decide alone and the run says why. Seeded demo forks skip it, and the platform starts at most 6 browser sessions per minute, so a release that lands many forks at once does not flood Browser Rendering.

### Test suggester

For each customization the suggester also proposes end-to-end scenarios for `tests/user/e2e.json` (kind `e2e`), reviewed with the tier 3 tests (accept or reject; edit the file in the fork to change one). For a REDCap connector it proposes: ask an enrollment question in research mode, then override that answer to clinical and check that no enrollment number leaks into the clinical answer, and that the override reaches the ledger. UI preference, tau, and model-written changes get their own scenarios.

### Admin-only test recipe

`platform/src/agents/test-recipe.ts` is a clearly labeled test recipe, accepted only with the admin token: `[admin test] break ledger fork_commit` makes every ledger record name the constant `build-cache` as its fork commit. Tier 1 only checks that `fork_commit` exists, so the change passes tiers 1 to 3; the end-to-end suite checks it equals the live commit, so the soak catches it and rolls it back. `scripts/e2e-yellow.mjs` uses it.

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
GET  /api/forks/:repo/health        -> {repo, health, history[]}             yellow to green state (Stage 6)
POST /api/admin/e2e                 {repo, ref?} -> E2E result               one run of the end-to-end tiers, no state change
POST /api/admin/yellow/:repo        -> {runId}                               re-check a fork's current main with a new yellow soak
POST /api/admin/fleet/baseline      {offset?, limit?, concurrency?, record?} -> {total, next, results[]}   baseline dry run of a page of forks
GET  /api/harvest                   -> HarvestProposal[]
```

The fleet view shows these fork statuses: `provisioning`, `pinned` (idle on its tag), `upgrading`, `gating`, `passed` (`pendingUpgrade` is set while the upgrade waits for approval), `failed`, and `repair_open`. `POST /api/ask` cards on a redirected fork carry `fork.servedBy` and `fork.safetyFallback`.

## Releases

`POST /api/admin/stock/publish` and `POST /api/admin/release` write `releases/<tag>.json` into `stock` with the notes, the safety flag, the date, and, for a safety release, a 14-day grace period with its `graceUntil` date. A publish keeps any invariants the latest release tightened and lists them in `keptInvariants` (v1.10.0 kept `inv-research-cross-check-visible` and its two paraphrases; it predates the field, so only the publish response showed them). The demo release takes the latest stock content and:

- makes one wording change to the multi-intent framing in `app/cards.ts`, with a different phrasing on each release, so forks that customized the same line conflict on purpose;
- tightens the floor: it appends the probes in `stock/overlays/demo-release/invariants.json` (`inv-research-cross-check-visible` and two paraphrases: a research dose answer shows its per-source cross-check in the body) to `tests/invariants/manifest.json` when they are missing. The overlay is never published as stock content; stock passes it (`stock/tests/unit/demo-overlay.test.ts`);
- keeps `harvest_opt_in = false` in stock's `fluid.toml`.

The release intent record lists the changed files and the tightened probes. Upgrade instances are keyed by (tag, fork), and a release skips forks already on the tag, waiting to approve it, or already upgraded or repaired at it, so running it again only reaches new forks. The exception is a fork whose upgrade to the tag landed and was then rolled back by the yellow soak: running the release again upgrades it under a new instance id. The tag is already in its history, so a merge would change nothing; the upgrade instead applies the rolled back upgrade's changes again on top of `main` (files the fork changed after the rollback keep `main`'s version, intent records are never deleted), and the gate decides (`platform/src/yellow/reapply.ts`).

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
| :-- | :-- |
| Provision a fork | 7 s |
| REDCap customization from request to fast-forward of main, including the test decisions | 15 s |
| Lower-tau customization through the failed gate and the linked repair | 12 s |
| Seed 30 forks (settled: customized on main, or a failed work branch with its repair open) | 12 s |
| Release and upgrade 31 forks | 64 s, with all 31 upgrading or gating at once; first upgrade finished after 8 s |
| Apply a repair (gate in merge mode, fast-forward main) | 5 s |
| Harvest across 31 forks | 12 s |

Of the 31 forks, 30 passed, 6 of them after the merge agent resolved a conflict. The one compact-research seed failed only `inv-research-cross-check-visible` and stayed pinned with a repair branch; applying that repair moved its `main` to the new tag. The lowered-tau seed's `main` stayed clean (its change failed on a work branch), so it upgraded normally. Earlier, before the fixes, `--seed 200` upgraded 202 forks in 159 s with up to 110 in flight.

### Yellow soak, measured on 2026-10-04

`scripts/e2e-yellow.mjs` against production (fork on stock v1.10.0, stock tier 10 scenarios plus 1 skipped, user tier 1 scenario) and against `cf dev` with remote Artifacts:

| Step | Production | Local |
| :-- | :-- | :-- |
| Good change, request to merged (gate, including test decisions) | 17.9 s | 12.1 s |
| Good change, yellow soak to green (3 passes, browser checks once) | 38.9 s | 48.2 s |
| Admin test change, request to merged (tiers 1 to 3 passed) | 15.1 s | 10.1 s |
| Admin test change, yellow to rolled back (revert commit pushed, repair started) | 18.4 s | 10.1 s |
| Repair apply, gate (with the merge of main) and soak to green | 58.0 s | 54.8 s |

On production the browser tier passed all four checks; locally it reports `unavailable` because the remote browser cannot reach `localhost`.

### Load rehearsal and baseline, measured on 2026-10-04

After the Stage 6 review fixes, `scripts/e2e-stage3.mjs --seed 200 --tag v1.10.0` against `cf dev` (re-running the v1.10.0 fan-out, so no new stock tag): 200 upgrade runs, up to 124 forks upgrading or gating at once and 88 soaking in yellow at once. The upgrades settled in 129 s and the last soak 30 s later. All 90 upgrades that landed (auto upgrade) turned green; none was rolled back and none was left yellow. 196 forks passed the gate (34 after the merge agent resolved a conflict), and exactly the 4 compact-research seeds stayed pinned with repair branches whose check passes at the new tag. The whole scenario took 659 s.

The production baseline (`scripts/baseline.mjs`, pages of 10, 4 at a time) ran one dry pass on all 201 forks in 120 s: all 201 passed (200 seeds on v1.5.0 and one fork on v1.9.0, both with the basic platform scenarios), none was flagged, and no fork's health or `main` changed. A dry pass took 1.5 s at the median and 2.6 s at most. After deploy 5fe35d0c, `scripts/e2e-yellow.mjs` passed on production on stock v1.11.0: soak to green in 41 s, rollback 16 s after landing, repair apply to green in 46 s, browser tier 4 of 4. A dry run of one pass (`POST /api/admin/e2e`) on seeded forks pinned to v1.5.0 (basic platform scenarios) took 2 to 4 seconds.

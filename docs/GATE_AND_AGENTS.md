# Gate and agents

How Fluid's control plane (`platform/`) gates fork changes and runs its agents. Spec sections 4.3, 6, 7, 8, 9, and 11.

## Workflows

All agent work runs in Workflows, declared in `platform/cloudflare.config.ts` and called through `ctx.exports`. Every run writes its timeline to a `Runs` Durable Object (`GET /api/runs/:runId`), and fork status changes go to the `Fleet` Durable Object, which streams them over `GET /api/fleet/stream`.

| Workflow | Name | One instance per | What it does |
| --- | --- | --- | --- |
| `GateWorkflow` | `fluid-gate` | push (repo, branch, commit) | Runs tiers 1 to 3 against the pushed commit. On a pass it merges the branch into `main`; on a fail it leaves `main` alone and starts a repair. `repair/*` branches are checked but never merged. |
| `CustomizeWorkflow` | `fluid-customize` | user request | Plans the change (a recipe or the agent model), loads it in an isolate, writes `.intent/<id>.json`, has the suggester propose tier 3 tests, waits for the user's decisions, commits on `work/<slug>` with an `Intent-Id:` trailer, pushes, and starts the gate. |
| `RepairWorkflow` | `fluid-repair` | failed gate | Opens `repair/<short-sha>` with `.repair/<short-sha>.md`, a repair intent record (`relies_on` lists the records it used), and a fix when a rule applies. It gates the fix in check mode and never merges it. |
| `ReleaseWorkflow` | `fluid-release` | release | Starts one upgrade per fork, in batches of 20 with a 1 second pause between batches. |
| `UpgradeWorkflow` | `fluid-upgrade` | fork and tag | Creates `upgrade/<tag>`, merges the stock tag (the merge agent resolves conflicts), and runs the gate at the new tag. It then merges to `main` if `auto_upgrade` is set, or waits for a one-tap approval. On a fail the fork stays pinned and a repair opens. |
| `SeedFleetWorkflow` and `SeedForkWorkflow` | `fluid-seed-fleet`, `fluid-seed-fork` | seed batch, seeded fork | Builds the synthetic demo fleet. |
| `HarvestWorkflow` | `fluid-harvest` | harvest run | Reads intent records from opted-in forks, clusters them, labels the clusters with the model, and drafts the eligible ones as `harvest/<slug>` branches in `stock`. Each run replaces earlier drafts. |

If a step fails after all its retries, the run is marked `failed` with the error and the instance ends as errored. A run is never left showing `running`.

## Gate integrity

- **Floor source.** Tiers 1 and 2 always come from `stock` at the tag pinned in the fork's `fluid.toml` at the pushed commit. Copies of `tests/` inside a fork are never loaded.
- **Runner isolation.** Stock's `tests/runner.ts` runs in its own Worker Loader isolate (`stock-runner:<stock sha>`). That isolate is built only from stock's runner, `app/toml.ts`, and `app/types.ts` at the pinned tag. It has no env and no network. It reaches the fork only through an `ask` callback passed over RPC. The fork runs in a separate isolate (`<repo>:<sha>`), so fork code cannot patch the runner's globals or its config parser.
- **Time limits.** Each fork call from the platform is limited to 10 seconds, and each sample in the runner to 5 seconds.
- **Tier 3.** Tier 3 is the fork's `tests/user/manifest.json`, always run as tier `user`. A probe with `"disabled": true` is skipped, and the gate logs it with its `disabledReason`.
- **Model access.** Fork isolates have no model access by default. Only the `:llm` variant, which `POST /api/ask` uses when `useModel` is set, gets the `LLM` capability. `LlmHost` limits model calls to 20 per minute per repo and 200 per minute across the platform.
- **Repairs.** Repair branches are never merged automatically.

## Routes added in Stage 3

```
POST /api/customize                 {repo, request} -> {runId}             session (own fork) or admin
GET  /api/runs/:runId               -> Run
POST /api/suggestions/:runId/decide {testId, decision, edited?} -> Run     edit sends edited: {assert: [...]}
GET  /api/gates/:repo               -> GateResult[] (newest first, last 20)
POST /api/gates/:repo               {branch, commit?} -> {runId, created}  direct gate trigger (local dev has no queue delivery)
POST /api/forks/:repo/upgrade       -> one-tap merge of a gated upgrade/<tag>
POST /api/admin/stock/publish       {tag?, notes?, safety?}               publish the bundled stock source
POST /api/admin/release             {tag, notes, safety} -> {tag, upgradeRuns, runId}
POST /api/admin/fleet/seed          {count} -> {created, batch, runId}     default 200, cap 500
POST /api/admin/fleet/cleanup       {batch?} -> {deleted, failed}          deletes seeded forks only (user-seed-*)
POST /api/admin/harvest             -> {runId}
GET  /api/harvest                   -> HarvestProposal[]
```

The fleet view shows these fork statuses: `provisioning`, `pinned` (idle on its tag), `upgrading`, `gating`, `passed` (`lastRun.applied` is false while the upgrade waits for approval), `failed`, and `repair_open`.

## Releases

`POST /api/admin/stock/publish` and `POST /api/admin/release` write `releases/<tag>.json` into `stock` with the notes, the safety flag, the date, and, for a safety release, a 14-day grace period with its `graceUntil` date. The demo release takes the latest stock content and makes one wording change to the multi-intent framing in `app/cards.ts`, with a different phrasing on each release. Forks that customized the same line conflict on purpose.

The merge agent resolves conflicts with the agent model when there are at most 3 conflicted files and the merge agent's budget of 30 model calls per minute allows it. Otherwise it uses a fixed rule:

- Keep the fork's version of any file that an intent record lists.
- Take stock's version of every other file.
- Always keep the fork's `fluid.toml`, with `stock_tag` moved to the new tag.

In both cases the gate decides whether the result ships.

## Events

`node platform/scripts/setup-events.mjs` creates the queue `fluid-events` and the account-level Artifacts subscription `fluid-artifacts-pushed` (`repo.pushed` to that queue). It only creates what is missing, so it is safe to run more than once. The consumer ignores the following:

- namespaces other than `fluid`
- repos that do not start with `user-`
- pushes to `main` (the gate's own merges)
- tag pushes
- `upgrade/*` branches (the upgrade workflow gates them itself)
- deleted branches

Gate instance ids come from (repo, branch, commit). So a direct trigger and the event for the same push start only one gate. A gate that errored is started again under a new id.

## Measured locally

These numbers come from `cf dev` with Artifacts and AI remote, using `scripts/e2e-stage3.mjs --seed 200`:

| Step | Time |
| --- | --- |
| Provision a fork | 4 to 7 s |
| REDCap customization from request to merge, including the test decisions | 9 to 12 s |
| Lower-tau customization through the failed gate and repair branch | 12 to 14 s |
| Seed 200 forks | 17 s |
| Release and upgrade 202 forks | 159 s, with up to 110 forks upgrading or gating at once |
| Harvest across 200 forks | 35 s |

Of the 202 forks, 193 passed, 39 of them after the merge agent resolved a conflict. The other 9 stayed pinned with repair branches: 5 had lowered tau and 4 had a custom clinical dose path.

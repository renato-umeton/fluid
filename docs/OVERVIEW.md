# Fluid overview

**Everyone gets their own fork. Behavior decides what ships.**

Fluid is a platform for personal software. A central team ships upstream (the stock release) as tagged versions of one git repository. Every user gets a fork of it. The user, the platform's agents, and any outside agent can change that fork. A change reaches the fork's `main` only when its behavior passes upstream's tests, the user's own tests, and a live soak.

The first app on Fluid is a medical assistant, because a wrong merge there can hurt someone. Nothing in the idea is medical. This page explains the split between the platform and the app, and lists the places where the platform code still assumes the medical app.

## Words used here

- **Upstream** (stock): the repository the central team owns and tags. In code and routes it is the `stock` repo.
- **Fork**: one user's copy of upstream, an Artifacts repository named `user-<id>`.
- **Wish**: one change plus its intent record (`.intent/<id>.json`), which says why the change exists.
- **Proof**: the tests that check a wish, in the fork's `tests/user/`.
- **Floor**: the tests upstream owns. A fork cannot edit or skip them.

## How a change ships

1. A change lands on a `work/*` branch of the fork, from the customize agent, a recipe, or an outside agent through the fork's inbox.
2. A push event starts the gate. Tier 1 (invariants) and tier 2 (functional tests) come from upstream at the fork's pinned tag. Tier 3 is the fork's own tests.
3. On a pass, `main` fast-forwards to the gated commit and the fork turns yellow.
4. Upstream's end-to-end suite runs against the live fork (a basic platform suite runs when the pinned release has none). Three clean passes turn it green. A failure rolls `main` back with a revert commit and opens a repair branch.
5. On a release, each fork upgrades by intent replay when every wish came from a recipe, or by a merge otherwise. The same gate and soak decide.

**Contest (v2.0-beta).** Several agents can work on one wish at the same time, each on its own `work/contest-<id>-<label>` branch. Each is gated in check mode while the platform keeps the fork's answer to every probe. A behavior diff against `main` and a fixed rule pick the winner (every tier and wish test passed, then fewest behavior changes outside the wish, fewest files, earliest finished). Only the contestant the owner ships is gated in merge mode and then soaks like any change. `GET /api/forks/:repo/wishes` lists every wish in flight in a fork. Details in [GATE_AND_AGENTS.md](GATE_AND_AGENTS.md#contest).

## The platform and the tenant

The platform is the control plane in `platform/`. The tenant is the app that upstream ships. Today one deployment hosts one tenant.

### What upstream must provide

| Path | Purpose |
| :-- | :-- |
| `app/index.ts` | Default export `{ ask(request, env) }` that returns a JSON card. This is the only entry the platform calls. |
| `app/`, `intent/`, `policies/`, `connectors/` | The runtime folders. The loader reads only these into the fork's isolate. |
| `app/toml.ts`, `app/types.ts` | Modules the test runner imports. The gate always takes them from upstream. |
| `tests/runner.ts` | The pure probe runner for tiers 1 to 3. |
| `tests/invariants/manifest.json` | Tier 1: every sample must pass. |
| `tests/functional/manifest.json` | Tier 2: a majority of samples must pass. |
| `tests/e2e/manifest.json`, `tests/e2e/runner.ts` | The end-to-end suite and runner for the yellow soak. |
| `tests/user/` | An empty template for the user's own tests (tier 3 and soak scenarios). Forks fill it in. |
| `fluid.toml` | `stock_tag` pins the release. It also holds user preferences such as `auto_upgrade` and `harvest_opt_in`. |
| `.intent/` | Build-time intent records for upstream's own changes. |

Releases are `vMAJOR.MINOR.PATCH` tags. The platform writes `releases/<tag>.json` (notes, safety flag, grace period) when it publishes one. See `stock/README.md` for the runtime contract.

### What the platform provides

- **Forks.** Provisioning from an upstream tag, sessions, and quotas.
- **Runtime.** One Worker Loader isolate per fork commit, keyed by repo and sha, with no network. The gate's test runner runs in a separate isolate built only from upstream files and reaches the fork through one `ask` RPC. The soak's runner reaches the live fork through a small set of platform calls.
- **Gate.** The three tiers, published pins only, pins that only move forward, append-only intent records, and `main` that only fast-forwards.
- **Yellow soak.** End-to-end runs against the live fork, browser checks, rollback by revert commit, and repair.
- **Agents.** Customize (recipes or a model plan, checked before anything runs), the test suggester, merge, repair, intent replay, and harvest. Models run on Workers AI behind AI Gateway. Every decision about what merges is plain code.
- **Outside agents.** A one hour token for a per-fork inbox repo. The platform imports `work/*` branches into the fork, and the gate decides.
- **Records.** Intent records in each fork, and a per-user run-time ledger committed daily to a git repo, `ledger-<id>`.
- **Fleet.** Live status of every fork, run timelines, and release fan-out.
- **UI shell.** One UI for all forks. A fork changes its look only through `ui/preferences.json`, which the platform validates.

## Tenant hooks: what is still medical-specific

These parts of the platform code assume the medical app. A second tenant would need each one moved into upstream or made configurable.

- **Answer card modes.** The modes `clinical`, `research`, and `administrative` are fixed lists in many places, for example `platform/src/durable/user-ledger.ts`, `platform/src/api/routes.ts`, `platform/src/agents/suggester.ts`, `platform/src/yellow/run.ts`, `platform/src/agents/intent.ts`, `platform/src/agents/outside-intent.ts`, `platform/src/agents/recipes.ts`, and `platform/src/ui/charts.ts`. Overrides and the ledger accept only these.
- **Agent prompts.** The test suggester's prompt in `platform/src/workflows/customize.ts` describes the fork as a clinical assistant.
- **`computed_dose`.** The platform reads this card field to find a clinical dose.
- **Safety backstop.** `platform/src/api/safety.ts` and `platform/src/api/ask.ts` refuse any clinical card with a computed dose and serve upstream instead. The safety release fallback in `ask.ts` is general.
- **Tau checks.** The tau recipe (`platform/src/agents/recipes.ts`), the restore-tau repair rule and the clinical and research failure rules (`platform/src/agents/repair-plan.ts`), and the default of 0.85 all assume `thresholds.tau` in `fluid.toml`. The minimum of 0.85 is also written into the platform in `platform/src/yellow/run.ts`, `platform/src/yellow/tiers.ts`, `platform/src/agents/suggester.ts`, and `platform/src/forks/provision.ts`.
- **Harvest floor paths.** `FLOOR_FILES` in `platform/src/agents/harvest-cluster.ts` names the clinical, dose, research, and registry policy files.
- **Personas.** Demo users come from `synthetic/personas.json` through `platform/src/forks/provision.ts`.
- **Synthetic data.** The loader passes the bundled medical data to every fork as `env.data` (`platform/src/runtime/loader.ts`).
- **Recipes.** The REDCap connector, tau, and the plain framing wording are recipes and replay kinds (`platform/src/agents/recipes.ts`, `platform/src/agents/replay.ts`).
- **Seeds.** The demo fleet's customizations are medical (`platform/src/fleet/seed-catalog.ts`).
- **Demo release.** `platform/src/stock/releases.ts` rewords a line in `app/cards.ts` and adds research cross-check invariants.
- **Platform end-to-end scenarios and browser checks.** `PLATFORM_SCENARIOS` in `platform/src/yellow/tiers.ts` and the checks in `platform/src/yellow/browser.ts` ask the bedside dosing question and expect a clinical card with no dose.
- **UI.** `platform/public/` renders medical answer cards, the context simulator, and charts by mode.

## Not built yet

- Several tenants on one deployment. Upstream is always the repo named `stock`.
- A live end-to-end run of Contest. Contest and the list of wishes in flight shipped in v2.0-beta and are covered by unit and route tests and by mock mode, but the contest workflow has not yet been run against live Artifacts and Workers AI. The mock contest plays one fixed scenario whatever the wish.

## Related documents

- [ARCHITECTURE.md](ARCHITECTURE.md): concepts mapped to code and Cloudflare primitives.
- [GATE_AND_AGENTS.md](GATE_AND_AGENTS.md): the gate, the soak, and every agent in detail.
- [Fluid_ Personal Software for Academic Medicine.md](<Fluid_ Personal Software for Academic Medicine.md>): the original medical case study spec.

# Fluid Implementation Plan

Source spec: `docs/Fluid_ Personal Software for Academic Medicine.md`.
Target: Cloudflare "Build the next Git platform" competition (deadline 2026-10-14).
Competition minimum: multiple agents working on changes concurrently. Submission needs MIT source, run instructions, and a 5 to 10 minute video (we provide the demo script).

## Ground rules

- Everything lives under `/Users/rumeton/workspace/argos`. Use nothing from other folders on this machine.
- All data is synthetic. No real patient data anywhere.
- License: MIT.
- Tooling: the `cf` CLI (v1.0.0-beta.12) and `cloudflare.config.ts` projects. TypeScript everywhere. Tests with Vitest.
- Credentials never go into files, git config, remote URLs, or logs.
- No billing changes. The account is already on Workers Paid (Artifacts works).
- Commit messages explain why. Never mention AI assistants or tool vendors in commits, code, comments, or docs. No emojis.

## Repository layout

```
LICENSE                 MIT
README.md               what Fluid is, how to run and try it (short; details in docs/)
docs/                   all Markdown except README.md
stock/                  source of the mothership `stock` repo (pushed to Artifacts and tagged)
  app/                  fork runtime module loaded per fork (entry: app/index.ts)
  intent/               signal adapters, classifier, mode contracts
  policies/             per-mode answer policies, US source registry
  connectors/           stock connectors (mock FHIR, call schedule, calendar, documents, formulary)
  tests/invariants/     tier 1 probes (manifest.json + probe files)
  tests/functional/     tier 2 probes
  tests/user/           empty in stock; tier 3 lives in forks
  .intent/              build-time intent ledger
  fluid.toml            pinned tag, thresholds, preferences
platform/               the Fluid control plane Worker (cf project)
synthetic/              synthetic patients, schedule, calendars, documents, policies, personas
```

## Architecture decisions

1. **Per-fork runtime through Worker Loader.** The platform reads a fork's `app/`, `intent/`, `policies/`, `connectors/` files from Artifacts at a given ref and runs them in a dynamic isolate through the Worker Loader binding. Every branch and commit is instantly live, which serves as the Workers Preview equivalent for the gate. The docs describe Workers Builds per fork as the production path. If Worker Loader is unavailable, Stage 0 records the fallback.
2. **Writes through isomorphic-git in the Worker.** The binding reads (readFile, log, readTree) and forks. All commits, branches, merges, and tags happen with isomorphic-git over an in-memory filesystem, authenticated with repo-scoped tokens minted by the binding.
3. **Events drive the gate.** Artifacts event subscription to a Queue. The queue consumer starts a Gate Workflow on every push to a `user-*` work branch.
4. **Workflows for long agent work.** Gate, Customize, Upgrade (one instance per fork), Repair, Harvest.
5. **Durable Objects for state.** `UserLedger` (run-time intent records per user, daily commit to `ledger-<id>` repo), `Fleet` (fork registry, pinned tags, live status for the fleet view).
6. **Models through Workers AI behind AI Gateway.** Agents produce structured JSON. Safety-critical decisions (hard-context floors, clinical no-dose rule, τ minimum) are deterministic code, never model output.
7. **Namespace.** `fluid` Artifacts namespace with US jurisdiction. Repos: `stock`, `user-<id>`, `ledger-<id>`.

## Shared contracts

### Fork runtime module (stock/app/index.ts)

```ts
export interface AskRequest {
  question: string;
  context: ContextSignals;        // see below
  explicitMode?: Mode;            // layer 1 override
  attestation?: boolean;          // "not deciding for a patient right now"
  history?: { role: "user" | "assistant"; text: string }[];
}
export type Mode = "clinical" | "research" | "administrative";
export interface ContextSignals {
  chartOpen?: { patientId: string; identified: boolean } | null;
  orderEntryActive?: boolean;
  onService?: boolean;
  documentType?: "manuscript" | "grant" | "budget" | "irb" | null;
  calendarEvent?: string | null;
  screenLabel?: { label: string; confidence: number } | null;
}
export interface AnswerCard {
  answer_id: string;
  mode: Mode | "multi";
  confidence: number;
  distribution: Record<Mode, number>;
  signals: string[];
  override_available: true;
  computed_dose: { value: number; unit: string; basis: string } | null;
  sources: { id: string; title: string; kind: "policy" | "fda" | "cdc" | "society" | "literature" | "committee" }[];
  framing: string[];               // required framing statements per mode contract
  body: string;
  alternatives?: AnswerCard[];     // labeled per-intent answers when below τ or option B view
  requires_attestation?: boolean;
  ledger: RunTimeRecord;
}
export interface RunTimeRecord {
  answer_id: string; intent: Mode | "multi"; confidence: number; signals: string[];
  override: Mode | null; attestation: boolean | null; sources: string[];
  fork_commit: string; stock_tag: string;
}
export default { ask(req: AskRequest, env: ForkEnv): Promise<AnswerCard> }
```

Option B plus attestation (spec 5.4) is the stock behavior and is protected by invariants.

### fluid.toml

```toml
stock_tag = "v1.0.0"
[thresholds]
tau = 0.85            # user may raise, never below stock minimum
[preferences]
auto_upgrade = false
harvest_opt_in = true
```

### Test probe format (tests/*/manifest.json)

```json
{ "tier": "invariant", "samples": 5, "probes": [
  { "id": "inv-chart-open-no-dose", "request": { "question": "...", "context": {} },
    "assert": [ { "path": "mode", "equals": "clinical" }, { "path": "computed_dose", "equals": null },
                { "path": "sources", "some": { "path": "kind", "equals": "policy" } } ] } ] }
```

Invariants: every sample passes. Functional: majority. User tier: user-defined, disabling is logged.

### Platform HTTP API (served by platform/, consumed by the UI in platform/public/)

All JSON. Write routes require the demo session cookie issued by `POST /api/session` (public demo: per-visitor sandbox user ids; admin-only routes need the `x-fluid-admin` secret).

```
POST /api/session                     -> { userId, persona }            body { persona }
GET  /api/personas                    -> Persona[]
GET  /api/me                          -> { userId, persona, fork: ForkInfo | null }
POST /api/forks                       -> ForkInfo                        provision fork from current stock tag
GET  /api/forks/:repo                 -> ForkInfo { repo, remote, stockTag, tau, branches[], lastGate }
POST /api/ask                         -> AnswerCard                      body { repo, ref?, question, context, explicitMode?, attestation? }
POST /api/override                    -> RunTimeRecord                   body { answer_id, mode }
GET  /api/ledger/:userId              -> RunTimeRecord[]
GET  /api/intents/:repo               -> BuildTimeIntent[]
POST /api/customize                   -> { runId }                       body { repo, request }  starts Customize workflow
GET  /api/runs/:runId                 -> Run { id, kind, status, steps[], branch?, commit?, suggestions?, gate? }
POST /api/suggestions/:runId/decide   -> Run                             body { testId, decision: "accept"|"reject"|"edit", edited? }
GET  /api/gates/:repo                 -> GateResult[] { commit, ref, tiers: { invariant, functional, user }, passed, failures[] }
POST /api/admin/release               -> { tag, upgradeRuns }            body { tag, notes, safety?: boolean } (admin)
POST /api/admin/fleet/seed            -> { created }                     body { count } (admin)
GET  /api/fleet                       -> Fleet { stockTags[], forks: { repo, persona, pinnedTag, status, lastRun }[] }
GET  /api/fleet/stream                -> text/event-stream of fleet status changes
POST /api/admin/harvest               -> { runId } (admin)
GET  /api/harvest                     -> HarvestProposal[] { cluster, count, forks[], intents[], draftBranch }
```

### Build-time intent record

As in spec section 8, stored at `.intent/<id>.json`, commit trailer `Intent-Id: <id>`.

## Stage 0: Capability spike
**Goal**: Prove each Cloudflare primitive works on this account before building on it.
**Success Criteria**: A findings file `docs/SPIKE_FINDINGS.md` with working code snippets and exact API shapes for: `fluid` namespace with US jurisdiction; binding `fork`, `readFile` at a tag ref, `createToken`; isomorphic-git clone, commit, branch, tag, merge, push from a Worker; Worker Loader running code read from a repo; Workers AI JSON output via AI Gateway; Queue plus Artifacts event subscription delivering a push event; Workflow start from a queue consumer; Durable Object. Spike Worker deleted afterwards.
**Tests**: Each primitive exercised against the real account, output recorded.
**Status**: Complete. All nine primitives work; see `docs/SPIKE_FINDINGS.md`. Deviations later stages must apply: fork runtime code is plain ESM JavaScript (`stock/app/index.js`, no TypeScript, since Worker Loader has no build step); binding calls take short refs or SHAs (never `refs/...`); one account-level `repo.pushed` subscription instead of per-repo; annotated tags are peeled before `git.merge`; use the patched MemoryFS from the spike.

## Stage 1: Stock release content
**Goal**: The stock repo source: intent engine, mode contracts, policies, US source registry, connectors over synthetic data, invariant and functional suites, and a local probe runner.
**Success Criteria**: Vitest unit tests pass; the local probe runner passes all invariant and functional probes against stock; the three dosing scenarios from spec section 2 behave as specified.
**Tests**: Classifier floors, τ handling, multi-intent view, attestation path, clinical never returns a dose, research cites two registry sources, admin cites policy version and owner.
**Status**: Complete

## Stage 2: Platform core
**Goal**: Control plane Worker: git ops library, stock publishing and tagging, fork provisioning, fork runtime via Worker Loader, ask API, UserLedger DO, Fleet DO.
**Success Criteria**: Running locally against real Artifacts: publish stock v1.0.0, provision a fork, ask the dosing question through the fork runtime, see the run-time record in the ledger.
**Tests**: Unit tests for git ops and toml handling; integration script hitting the local server.
**Status**: Not Started

## Stage 3: Gate and agents
**Goal**: Queue consumer, Gate Workflow (three tiers against the branch runtime, merge on pass), Customization agent, Test suggester, Repair agent, Upgrade Workflow fan-out, Harvester.
**Success Criteria**: A customization that lowers τ fails the gate with the failing probe shown; a REDCap connector customization gets a suggested test and passes; tagging v1.1.0 upgrades many forks concurrently with a few pinned and repair branches opened.
**Tests**: Workflow step unit tests; end-to-end scenario scripts.
**Status**: Not Started

## Stage 4: UI
**Goal**: Single-page app served by the platform: persona switcher, context simulator (chart, document, screen label), chat with answer cards and override, attestation dialog, gate results, fleet view with live upgrade status, ledger and intent record viewers, harvest view.
**Success Criteria**: All five demo scenes from spec section 13 can be performed in the browser.
**Tests**: Component-level checks plus a scripted browser run of each scene.
**Status**: Not Started

## Stage 5: Ship
**Goal**: Deployed public demo, seeded fleet, README, LICENSE, `docs/DEMO_SCRIPT.md`, run instructions.
**Success Criteria**: Public URL works for all scenes; fresh clone setup instructions verified; no credentials in the repo; write routes protected.
**Tests**: Scripted run of all scenes against the deployed URL; secret scan.
**Status**: Not Started

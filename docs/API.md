# Fluid API and contracts

This page holds the contracts that stock, the platform, and the UI share, the HTTP routes, and the limits that protect the public demo.

## Shared contracts

The types in `stock/app/types.ts` are the source of truth. Later stages added fields such as `tau` on cards and records and `publisher` on sources.

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

### UI preferences (ui/preferences.json)

```json
{ "look": "crimson", "font": "georgia", "density": "compact", "accent": "teal",
  "tabs": [ { "title": "Charts", "widgets": ["answers-by-intent", "override-rate"] } ] }
```

Every key is optional and unknown keys are rejected. `look` is one of `standard`, `crimson`, `luna-xp` (`standard` is the same as no look). `font`, `density`, `accent`, and the 6 widgets are fixed lists in `platform/src/ui/preferences.ts`. At most 4 tabs, titles of at most 40 plain characters, 1 to 6 widgets each, and at most 8 KB. An explicit `font`, `density`, or `accent` wins over the look's own. Details in `docs/UI.md`.

### Test probe format (tests/*/manifest.json)

```json
{ "tier": "invariant", "samples": 5, "probes": [
  { "id": "inv-chart-open-no-dose", "request": { "question": "...", "context": {} },
    "assert": [ { "path": "mode", "equals": "clinical" }, { "path": "computed_dose", "equals": null },
                { "path": "sources", "some": { "path": "kind", "equals": "policy" } } ] } ] }
```

Invariants: every sample passes. Functional: majority. User tier: user-defined, disabling is logged.


### Build-time intent record

As in spec section 8, stored at `.intent/<id>.json`, commit trailer `Intent-Id: <id>`.

Records the customization agent and seeded customizations write may carry an optional `replay` field, which says how to run the change again on fresh stock (intent replay, see `docs/GATE_AND_AGENTS.md`):

```json
{ "replay": { "kind": "tau", "params": { "value": 0.9 } } }
{ "replay": { "kind": "ui", "params": { "look": "crimson", "tab": { "title": "Charts", "widgets": ["override-rate"] } } } }
{ "replay": { "kind": "redcap", "params": { "protocols": ["IRB-2026-0142", "IRB-2026-0219"] } } }
{ "replay": { "kind": "framing", "params": { "line": "      : `Not sure which role you are in ...`," } } }
{ "replay": { "kind": "model", "request": "Show a budget variance summary in administrative answers" } }
```

`tau`, `ui`, `redcap`, and `framing` are replayable. `model` is not: a fork with a model change upgrades by merge. The field is optional, so older records stay valid, and a malformed field reads as no replay.

An upgrade run and the fork's `lastRun` in the fleet carry `path` (`"replay"` or `"merge"`) and, for a fork with wishes, `replay`:

```json
{ "tag": "v1.11.0", "path": "replay", "carried": 2, "total": 2,
  "wishes": [ { "intentId": "int_...", "status": "replayed", "kind": "framing", "request": "...",
                "reason": "multi-intent framing line set to this fork's wording in app/cards.ts",
                "stockAlsoChanged": ["app/cards.ts"] } ] }
```

`status` is `replayed`, `fallback` (not replayable), or `failed` (no longer applies). On the merge path `carried` is 0 and `reason` says why.


### Contest run record

`GET /api/runs/run_contest_<id>` returns the contest; each contestant's own timeline is `GET /api/runs/run_contest_<id>_<label>`.

```json
{ "kind": "contest", "status": "waiting", "request": "...", "contestId": "1a2b3c4d5e6f", "size": 3,
  "includeAgent": false, "joinUntil": null, "agentBranch": null, "baseCommit": "...", "stockTag": "v1.11.0",
  "contestants": [ { "label": "model-a", "kind": "model", "title": "Model plan A: smallest change",
    "runId": "run_contest_1a2b3c4d5e6f_model-a", "status": "evaluated", "branch": "work/contest-1a2b3c4d5e6f-model-a",
    "commit": "...", "intentId": "int_...", "summary": "...", "files": ["app/cards.ts"], "wishTests": 2,
    "readyAt": "...", "latencyMs": 41000, "checkMs": 9000, "outside": 0,
    "wish": { "passed": 2, "total": 2, "failing": [] },
    "gate": { "passed": true, "firstFailure": null, "tiers": { "invariant": { "passed": true, "total": 57, "failed": 0 } } },
    "note": "lost to ... because ..." } ],
  "wishTests": [ { "id": "t-int_...-card-contract", "question": "..." } ],
  "behavior": { "targetModes": ["research"], "omitted": 12,
    "rows": [ { "id": "inv-...", "key": "invariant:inv-...", "tier": "invariant", "question": "...", "wish": false,
      "main": { "passed": true },
      "cells": { "model-a": { "passed": true, "changed": true, "scope": "target", "total": 1,
        "changes": [ { "path": "body", "kind": "changed", "before": "...", "after": "..." } ] } } } ],
    "counts": { "model-a": { "outside": 0, "inside": 1, "target": 3, "wishPassed": 2, "wishTotal": 2, "failingWish": [] } } },
  "verdict": { "winner": "model-a", "reason": "model-a wins: ...", "ranking": [ { "label": "model-a", "eligible": true, "why": "..." } ],
    "notes": { "model-b": "lost to model-a because ..." } },
  "winner": "model-a", "picked": { "label": "model-a", "by": "rule", "reason": "...", "at": "..." },
  "notes": { "model-b": "lost to model-a because ..." }, "shipGateRunId": "run_gate-..." }
```

`status` is `running`, `waiting` (for a pick), `passed` (the pick reached main), `failed` (no winner, or the pick did not pass its merge gate), or `cancelled` (no pick within an hour). A contestant's `status` moves through `queued`, `planning`, `ready`, `checking`, `evaluated`, or ends as `no change` with an `error`; the owner's agent starts as `waiting for your push` and becomes `joined`. A cell's `scope` is `wish`, `target` (wording in a mode the wish targets), `outside`, or `own` (a test main never ran, such as one the contestant added; never counted against it). A row main never ran has `main: {passed: null, missing: true}`.

## HTTP routes

| Method and path | Who | What it does |
| :-- | :-- | :-- |
| `GET /api/health` | anyone | Liveness check |
| `GET /api/personas` | anyone | The three synthetic personas |
| `POST /api/session` | anyone | Start or switch a persona session (signed cookie) |
| `GET /api/me` | session | Current user, persona, and fork |
| `GET /api/me/charts` | session | Chart data for the user's own fork tabs |
| `POST /api/forks` | session | Provision the user's fork from the current stock release |
| `GET /api/forks/:repo` | anyone | Fork info: remote, pinned tag, tau, branches, last gate |
| `GET /api/forks/:repo/health` | anyone | Yellow or green state, soak progress, history |
| `GET /api/forks/:repo/ui` | anyone | Validated `ui/preferences.json` from main |
| `GET /api/forks/:repo/imports` | owner | The last 5 imports from the fork's inbox, newest first: `{imports: [{at, branch, commit, status: "imported" or "refused" or "not joined", reason, runId}]}`. A refused push names why in plain words (quota, cap, unsafe path, replaced inbox) |
| `POST /api/forks/:repo/token` | owner | A one hour git write token for your own agent, scoped to the fork's inbox repo (`inbox-<fork>`, created on first use), never to the fork: `{repo, inbox, remote, token, expiresAt, branchPrefix: "work/", commands}`. Revokes the previous outside token |
| `POST /api/forks/:repo/upgrade` | owner | One-tap upgrade to a passed release |
| `POST /api/forks/:repo/repairs/:sha/apply` | owner | Gate a repair branch and fast-forward main on pass |
| `POST /api/ask` | session | Ask the user's fork (or stock); returns an answer card. `reaskOf` (an earlier `answer_id`) marks an override or attestation re-ask of the same question and is recorded as `reask_of` |
| `POST /api/override` | session | Record an override on a run-time record |
| `GET /api/ledger/:userId` | owner | Run-time intent records |
| `POST /api/ledger/commit` | owner | Commit pending records to the `ledger-<id>` repo |
| `GET /api/intents/:repo` | anyone | Build-time intent records |
| `POST /api/customize` | owner | Start a customization run |
| `POST /api/contests` | owner | Start a contest for one wish: `{repo, request, size?: 2 or 3, includeAgent?: boolean}` -> `{runId, contestId, joinUntil, agentBranch}`. Costs `size` customizations |
| `POST /api/contests/:runId/pick` | owner | Ship a contestant: `{label}`. Only one that passed every tier and every wish test, once per contest; it is then gated in merge mode |
| `GET /api/forks/:repo/wishes` | anyone | Wishes in flight: the newest work branches with the intent records they add and their status. The owner (or admin) also gets the notes of runs that have not pushed yet (`notesIncluded: true`). Cached per fork for 10 seconds |
| `GET /api/runs/:runId` | session | Run timeline: steps, diff, suggestions, gate, yellow phase |
| `POST /api/suggestions/:runId/decide` | owner | Accept, edit, or reject a suggested test |
| `GET /api/gates/:repo` | anyone | Gate results history |
| `POST /api/gates/:repo` | owner | Gate the head of a work branch directly |
| `GET /api/fleet` | anyone | Fleet snapshot: forks, statuses, health, releases |
| `GET /api/fleet/stream` | anyone | Server-sent events for fleet changes |
| `GET /api/harvest` | anyone | Harvest proposals |
| `POST /api/admin/stock/publish` | admin | Publish a stock release tag |
| `POST /api/admin/release` | admin | Tag a release and upgrade the fleet; each upgrade tries intent replay first unless the body sets `replay: false` |
| `POST /api/admin/fleet/seed` | admin | Seed synthetic forks |
| `POST /api/admin/fleet/cleanup` | admin | Delete seeded forks |
| `POST /api/admin/fleet/baseline` | admin | Dry-run the end-to-end suite on every fork and flag failures |
| `POST /api/admin/forks/:repo/delete` | admin | Delete one fork |
| `POST /api/admin/harvest` | admin | Run the harvester |
| `POST /api/admin/suite` | admin | Run the stock suites against a fork ref |
| `POST /api/admin/e2e` | admin | One end-to-end dry run, no state change |
| `POST /api/admin/yellow/:repo` | admin | Re-check a fork's main through a yellow soak |

"Owner" means a session whose fork is `:repo`. Admin routes need the `x-fluid-admin` header. Every POST must send `content-type: application/json`. Server code: `platform/src/api/routes.ts`.

## Limits and protections

- Per-client quotas run ahead of the global ones. A client is an IPv4 address or an IPv6 /64, and the admin is exempt. The limits: forks 3 per hour per client and 60 per hour overall, asks 30 per minute per client, and Artifacts-backed reads (`/api/me`, `/api/forks/:repo`, `/api/intents/:repo`) 60 per minute per client. Fork info is cached for 5 seconds.
- Outside git tokens (`POST /api/forks/:repo/token`): only a normal session that owns the fork (not the admin header, not a yellow run's test session), 3 per hour per user, 6 per hour per client, and 60 per hour overall, one request per fork at a time (a second one gets a 409, and so does a mint that outlived its 30 second lease and lost it to another request: it writes no grant and revokes its token). Each token lasts one hour and can write only the fork's inbox repo; each request replaces the inbox with a fresh fork of `main`, which ends every earlier token, and the inbox is deleted 15 minutes after its token expires. The response is `no-store` and the token is never logged (only its id and expiry). Inboxes are not fleet forks and do not count toward the fork limits. Imports from the inbox: 10 per fork per hour and 200 per hour overall, each in its own workflow, capped at 8 MB downloaded, 5000 tree entries, 50 commits, 200 files, and 1 MB per file, with unsafe paths refused. A failed gate for an imported change opens no repair. See "Outside pushes" in `docs/GATE_AND_AGENTS.md`.
- Contests: a contest of N counts as N customizations of the owner (10 an hour), and 30 contests an hour run across the platform. Units already taken are given back when a later one is refused, or when the contest cannot start. If creating the contest workflow throws but the instance exists anyway (a dropped connection after the create), the contest is kept and the start answers 202. When the route cannot find the instance and abandons the contest, an instance that was made anyway stops at its first step without touching the run, the contest state, or the lease. If sending a pick fails, the pick is cleared so the owner can pick again. N is 2 or 3, one contest per fork at a time (a second gets a 409), a second pick gets a 409, the join window for the owner's agent is 5 minutes, and a contest waits at most an hour for a pick.
- Wishes in flight (`GET /api/forks/:repo/wishes`): the per-client read quota and 300 reads a minute across the platform.
- Refusals say why in a machine-readable way. A rate limit 429 (except a contest refused by its quota, which says why in `error` only) carries `{reason: "rate-limit", bucket, scope: "client" or "user" or "global", limit, windowSeconds, retryAfterSeconds}` and a `retry-after` header; a full fleet is a 429 with `reason: "fleet-full"`; a fork already being set up is a 409 with `reason: "busy"`. The UI turns these into plain words (`docs/UI.md`, "When the platform cannot give you a fork").
- Fork claims are atomic in `Fleet.claimProvisioning`. A concurrent second request gets a 409, and failed attempts do not count toward the 500-fork cap.
- Fleet streams are capped at 200 overall and 5 per client. A subscriber with more than 256 KB unread is dropped.
- Ledger repos are created only for users with a fork, and the daily alarm stops when nothing is waiting.
- Every POST must declare `application/json`, and a browser Origin must be this site. Bodies are capped at 64 KB, counted in bytes, and the declared length is checked first. A malformed path escape is a 400.
- `/api/forks/:repo` and `/api/intents/:repo` answer only for fleet forks and `stock`. Visitors ask by branch or tag, never by raw SHA. A SHA ref must exist in the repo. The direct gate trigger gates only the branch head.
- Error responses carry a `requestId` (also in `x-request-id`). Unexpected errors return `internal error`, and their scrubbed details go only to the log.
- The `fluid` AI Gateway is capped at 300 requests per minute (see `docs/GATE_AND_AGENTS.md`).

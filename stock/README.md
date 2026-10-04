# Fluid stock release

Source of the mothership `stock` repository. Every user fork starts from a tag
of this repo. All data, drugs (Morphinex, Hydrolane), policies, and numbers are
synthetic and must never be used for patient care.

## Layout

```
app/                 fork runtime entry (index.ts), cards, ledger records, fluid.toml reader
intent/              signal adapters, classifier, hard-context floors, tau, decision (option B)
policies/            mode contracts, clinical/research/administrative policies, US source registry
connectors/          mock FHIR, call schedule, calendar, documents, formulary (read env.data)
tests/invariants/    tier 1 probes (every sample must pass)
tests/functional/    tier 2 probes (majority of samples)
tests/user/          empty in stock; tier 3 (manifest.json) and user e2e scenarios (e2e.json) live in forks
tests/runner.ts      pure probe runner, reused by the platform gate
tests/e2e/           end-to-end regression suite (manifest.json) and its pure scenario runner (runner.ts)
tests/unit/          Vitest unit tests (development only)
.intent/             build-time intent records
fluid.toml           pinned stock tag, tau, preferences (harvest_opt_in defaults to false)
overlays/demo-release/  extra invariant probes added only when the platform tags a demo release
scripts/build.mjs    bundles app/index.ts to dist/app.js
```

`overlays/` is never published as stock content. The platform appends
`overlays/demo-release/invariants.json` to `tests/invariants/manifest.json`
only when it tags a demo release, so that release tightens the floor; stock
passes those probes too (`tests/unit/demo-overlay.test.ts`).

## Runtime contract

`app/index.ts` default-exports `{ ask(request, env) }` returning an `AnswerCard`
(shapes in `app/types.ts`). `env` is:

| key          | meaning                                                                 |
| :-- | :-- |
| `fluidToml`  | text of the fork's `fluid.toml` (stock defaults if absent)              |
| `forkCommit` | commit that produced the answer, recorded in the ledger                 |
| `data`       | synthetic data, keys as in `synthetic/manifest.json`                    |
| `llm`        | optional `(prompt, schema) => Promise<{ body }>`, used only to reword   |
| `newId`      | optional answer id factory                                              |

Every card (and every alternative) carries `tau`, the effective threshold it
used, and so does its ledger record (`ledger.tau`). Registry sources carry a
`publisher` label, always marked as a synthetic summary.

Requests are validated and fail closed: a chart is identified unless
`identified` is exactly `false`; truthy non-boolean `orderEntryActive` or
`onService` count as true; a non-boolean `attestation` (other than `null`,
treated as absent) or a non-array `history` is rejected with an error.

Safety rules are deterministic code and work with no model: hard-context
floors, clinical never computes a dose, effective tau never below 0.85, an
identified patient context answers in clinical mode at any tau, option B with
attestation while an identified patient is in context, option B when the
question itself describes a current patient, and two independent current
registry publishers for any research number. Ambiguous parameters (several
drugs, weights, or ages) withhold the number. Clinical and held research cards
never use model wording; elsewhere model wording is rejected if it introduces
any number, number word, or number-unit pair not in the template.

## Probe runner

`runManifest({ app, manifest, forkFiles, env, samples, tier?, timeoutMs? })`.
Manifests are validated first (unknown assertion keys, assertions with no op,
probes with no assertions, and non-positive-integer `samples` are errors).
`tier` overrides the manifest tier (the gate sets it for user manifests); an
unknown tier is an error. Each sample has a time limit (default 5000 ms) and a
timeout is a failed sample. Ops: `equals`, `notEquals`, `gte`, `lte`,
`exists`, `some`, `every` (fails on an empty array unless `allowEmpty: true`),
`contains`, `notContains`, `length_gte`, and `notMatches` (regex as
`"/pattern/flags"`; with `path: ""` it checks the whole card as JSON). A
`notMatches` pattern is at most 200 characters and may not repeat a group that
already holds an unbounded quantifier (`(a+)+`, `(\w*x)*`), since manifests can
come from a fork and such patterns backtrack for exponential time. A probe
may set `focusMode` to assert on the card in that mode, either the card itself
or the matching alternative of a multi-intent card, so probes stay valid when
a fork raises tau.

The gate must read `tests/` (manifests and `runner.ts`) from stock at the
fork's pinned tag and ignore any copies inside the fork.

## End-to-end scenarios

`tests/e2e/manifest.json` is the stock end-to-end suite. After a change lands
on a fork's `main`, the platform runs it against the live fork (the yellow
state) three times in a row before the fork turns green; a failure rolls
`main` back to the last green commit. Like tiers 1 and 2 it is read from stock
at the fork's pinned tag, never from the fork. A fork may add its own
scenarios in `tests/user/e2e.json`; those run as an extra tier and cannot reuse
a stock scenario id.

A scenario is an ordered list of steps. Step kinds:

| kind       | does                                                              | assertion target              |
| :-- | :-- | :-- |
| `ask`      | asks the live fork (`request`, optional `withHistory`, `focusMode`) | the answer card               |
| `override` | records the user's mode override on `answer`; `reask` asks the named ask step again in that mode | `{ record, card? }` |
| `ledger`   | reads the run-time record of `answer`                             | the record, or null           |
| `intents`  | reads the fork's build-time intent records                        | `{ count, records }`          |
| `config`   | reads and validates a fork file (`fluid.toml`, `ui/preferences.json`) | `{ present, valid, errors?, parsed? }` |

Assertions use the probe runner's ops. An expected value of `"$live.commit"`
or `"$live.stockTag"` names the live fork; `"$<step>.<path>"` names a value
from an earlier step's target. `requires: { "connector": "redcap" }` on a
scenario or step skips it when the fork has no `connectors/redcap.ts`. Each
step has a latency budget (`latencyBudgetMs` on the step, scenario, or
manifest; default 10000 ms) and a time limit. A step over its budget gets a
warning (`warnings[]`); only a step slower than 3 times its budget fails. A
scenario stops at its first failing step.

Failures that may come from the platform rather than the fork carry
`retryable: true`: a host error, a step that hit its time limit, and a step
past the hard latency cap. A host error whose message starts with
`fork error: ` was caused by the fork (its code threw or did not build) and is
not retryable, and neither is any assertion on the fork's output. A failed
scenario is `retryable` when every failure of its failing step is, and a tier
result is `retryable` when every failed scenario is. The platform runs a
retryable pass again before it rolls anything back.

`runScenarios({ manifest, host, live, tier?, stepTimeoutMs? })` runs a
manifest against a host that implements `ask`, `override`, `ledger`,
`intents`, `config`, and `connectors` (see `tests/e2e/runner.ts`). The
platform implements the host with its own ask path and a synthetic test user
scoped to the run, so scenarios never write to a real user's ledger.

## Modules

Runtime modules are plain TypeScript with relative imports that use the `.js`
extension (plus `.json` imports for policies and the registry, inlined by the build). They use no
Node APIs and have no runtime dependencies. `npm run build` emits
`dist/app.js`, a single self-contained ES module with one default export,
which is what a Worker Loader isolate should load.

## Development

```
npm install          # .npmrc sets legacy-peer-deps
npm test             # unit tests plus both manifests against stock, 5 samples
npm run typecheck
npm run build
```

Unit tests read synthetic data from `../synthetic` (the monorepo layout). Stock
tests are read by the gate from this repo at the fork's pinned tag; they are
not meant to be edited in a fork.

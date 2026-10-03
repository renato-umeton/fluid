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
tests/user/          empty in stock; tier 3 lives in forks
tests/runner.ts      pure probe runner, reused by the platform gate
tests/unit/          Vitest unit tests (development only)
.intent/             build-time intent records
fluid.toml           pinned stock tag, tau, preferences
scripts/build.mjs    bundles app/index.ts to dist/app.js
```

## Runtime contract

`app/index.ts` default-exports `{ ask(request, env) }` returning an `AnswerCard`
(shapes in `app/types.ts`). `env` is:

| key          | meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `fluidToml`  | text of the fork's `fluid.toml` (stock defaults if absent)              |
| `forkCommit` | commit that produced the answer, recorded in the ledger                 |
| `data`       | synthetic data, keys as in `synthetic/manifest.json`                    |
| `llm`        | optional `(prompt, schema) => Promise<{ body }>`, used only to reword   |
| `newId`      | optional answer id factory                                              |

Safety rules are deterministic code and work with no model: hard-context
floors, clinical never computes a dose, effective tau never below 0.85,
option B with attestation while an identified patient is in context, and two
independent current registry sources for any research number. Model wording is
rejected if it introduces any number not in the template.

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

# Polymorphic installation: implementation plan

Issue #1. Design: [plans/2026-11-06-polymorphic-installation-design.md](plans/2026-11-06-polymorphic-installation-design.md). Branch: `issue-1-polymorphic-installation`.

**Goal:** each fork runs a uniquely renamed copy of upstream's internal names, proven behavior-equivalent by the gate, rotated on a schedule and on tripwire hits, and measured end to end against a planted zero-day.

**Architecture:** upstream lists the internal names that may move (`stock/polymorph.json`). The loader renames those identifiers in the fork's module map with a per fork, commit and epoch seed (`platform/src/polymorph/`). The gate runs every probe against the plain fork and the copy and compares cards. Fleet keeps the verified copy per fork. The live ask path refuses requests that name a dead original name (tripwire) and starts a rotation. A new `fluid-rotate` workflow rotates forks every 6 hours.

**Tech:** TypeScript, vitest, sucrase's parser for tokens, WebCrypto HMAC-SHA256 for seeds. No new dependencies.

## Rules for every stage

- Test first: write the failing test, run it, then the code. Run the whole suite before each commit (`cd platform && npm test`, `cd stock && npm test`, `cd platform && npx tsc --noEmit -p .`).
- Match the file you touch: tabs in `platform/src`, `platform/test`, `platform/scripts`; 2 spaces in `stock/` and `platform/public/js`.
- Commit messages: imperative, sentence case, no prefixes, explain why in the body. No trailers. Never mention any AI tool or assistant anywhere.
- Docs: plain short sentences, no horizontal rules, no emojis.
- Never push. Never deploy.

## Stage 1: Polymorph core
**Goal**: pure functions that rename listed identifiers in a module map with a seed, plus upstream's name list.
**Success Criteria**: the stock module map renamed with 5 different seeds answers every invariant and functional probe exactly like the plain map (cards equal after dropping `answer_id` and `fork_commit`); the same seed always gives the same copy; different seeds give different names; strings, comments, regular expressions and JSON modules are untouched; a list entry that appears in a string literal or a JSON key is rejected with a clear message.
**Tests**: `platform/test/polymorph-names.test.ts`, `polymorph-morph.test.ts`, `polymorph-tripwire.test.ts`, `polymorph-stock.test.ts`; `stock/tests/unit/polymorph-list.test.ts`.
**Status**: Not Started

Tasks:
1. `stock/polymorph.json`: `{ "version": 1, "description": "...", "names": [...] }`. Start from the internal names in `intent/decide.ts` (`answerModes`, `optionB`, `identifiedPatientContext`, `researchNeedsAttestation`, `currentPatientDosing`), `intent/signals.ts`, `intent/classifier.ts`, `policies/contracts.ts` (`facts`, `enforceContract`, `enforceResearch`, ...), `app/cards.ts` (`answerId`, `buildCard`, `draftFor`, ...), `app/body.ts`, `app/ledger.ts`, `policies/dose.ts`. Keep only names that pass task 2. Never list a request key, card or ledger field, env key (`fluidToml`, `forkCommit`, `data`, `llm`, `newId`), `ask`, or a name the platform or browser bundle imports by name (`readForkConfig`, `effectiveTau`, `scheduleContext`, `normalizeRequest`, `MODE_CONTRACTS`, `SYNTHETIC_NOTICE`, `STOCK_MIN_TAU`, `STOCK_TAG`).
2. `stock/tests/unit/polymorph-list.test.ts`: upstream's own check of its list. Each name is a valid identifier and not a keyword; appears as an identifier in runtime code; never appears as a string literal or template text in runtime code (use the TypeScript scanner from stock's `typescript` devDependency); is not a key in runtime JSON or `synthetic/`; never appears in any manifest (invariants, functional, e2e, demo overlay) as a path segment, request key, or string value; is not a field of `AskRequest`, `ContextSignals`, `AnswerCard`, `RunTimeRecord`, `ForkEnv`; is not in the names imported by the platform or browser bundle.
3. `platform/scripts/bundle-content.mjs`: add `"polymorph.json"` to `STOCK_INCLUDE` so the published stock carries the list.
4. `platform/src/polymorph/names.ts`: `deriveSeed(secret, repo, sha, epoch): Promise<string>` (HMAC-SHA256 hex over `polymorph:v1:<repo>:<sha>:<epoch>`), `variantNames(seed, names): Promise<Map<string,string>>` (each name gets `name$` plus 8 base36 characters from HMAC-SHA256(seed, name), independent per name), `fingerprint(seed): Promise<string>` (8 hex characters, safe to show).
5. `platform/src/polymorph/tokens.ts`: a small adapter over sucrase's parser (`sucrase/dist/parser/index.js`, CommonJS, already installed) that returns identifier tokens with positions and the decoded values of string and template tokens. Add a local type declaration for the deep import. Fail loudly if the token shape changes.
6. `platform/src/polymorph/list.ts`: `parsePolymorphList(text)`, `RESERVED_NAMES` (keywords, contextual keywords, every global and every own property name of standard built-ins and their prototypes, protocol names such as `then`, `next`, `done`, `value`, `toJSON`, `default`, and the runtime contract names), `listProblems(names, map): string[]` (reserved, not an identifier, never used in the map, used in a string or template, used as a JSON key).
7. `platform/src/polymorph/morph.ts`: `morphSource(js, names)` renames every identifier token whose text is a key of `names`; throws if a target name already exists in the source. `morphModuleMap(map, names)` applies it to every `{ js }` module except the generated entry, leaves `{ json }` modules as they are, and throws a descriptive error when `listProblems` reports anything.
8. `platform/src/polymorph/tripwire.ts`: `scanRequest(request, names): TripwireHit | null` walks the request (objects and arrays, any depth, keys only). A key equal to an original listed name is `{ kind: "decoy" }`. A key shaped `<listed name>$<8 base36>` that differs from this copy's name is `{ kind: "foreign" }`. This copy's own names are not flagged. `ForkTripwireError` carries the hit.
9. `platform/test/polymorph-stock.test.ts`: build the stock module map from `src/generated/stock-source.json` (as `test/modules.test.ts` and `test/gate.test.ts` do), morph it with 5 seeds, materialize plain and morphed maps, run the invariant and functional manifests through the stock runner against both, and compare every card.

## Stage 2: Test fakes for Artifacts reads and Worker Loader
**Goal**: run `loadForkRuntime`, `serveAsk`, and `runGate` in Node tests with no Cloudflare account.
**Success Criteria**: a stock fork stored in a fake Artifacts namespace loads through `loadForkRuntime` and answers through the fake loader; `runGate` in check mode passes on stock through the fakes; the existing suite still passes.
**Tests**: `platform/test/runtime-load.test.ts`.
**Status**: Not Started

Tasks:
1. `platform/test/helpers/fake-repos.ts`: in-memory repositories that implement exactly the read surface used by `src/runtime/repo-files.ts`, `src/runtime/refs.ts`, and `src/stock/suite.ts` (commits, trees, blobs, `log`, tags), seeded from a `Record<path, text>` per commit. Plug it into the existing `fakeArtifacts()` shape in `test/helpers/api-env.ts` without breaking current tests.
2. `platform/test/helpers/fake-loader.ts`: `fakeLoader()` with `get(id, factory)` that runs the factory once per id, materializes the module map under `test/.tmp-loader/`, imports the main module (the `cloudflare:workers` alias applies), and returns `getEntrypoint(name)` instances built with the factory's `env`. Record the ids it built, for assertions. Clean up in `afterAll`.
3. `platform/test/runtime-load.test.ts`: provision `stock` at `v1.0.0` and `user-1` from it in the fakes; ask through `loadForkRuntime` + `askCard`; run `runGate` in check mode and expect a pass.

## Stage 3: Platform wiring
**Goal**: the platform installs, verifies, serves, guards, and rotates renamed copies.
**Success Criteria**: a fork with a verified epoch is served from a renamed copy with its own isolate id; the gate reports any card difference between plain and renamed copies as a tier 1 `polymorph-equivalence` failure; a request naming a dead original name is refused, recorded, and starts one rotation per copy; errors from a renamed copy never show renamed names; `rotateFork` moves a fork to the next epoch only after the check passes; with no secret or no list, everything behaves exactly as today.
**Tests**: `platform/test/polymorph-loader.test.ts`, `polymorph-gate.test.ts`, `polymorph-fleet.test.ts`, `polymorph-ask.test.ts`, `polymorph-rotate.test.ts`.
**Status**: Not Started

Tasks (3a, then 3b):
1. (3a) Loader: `LoadOptions.morph?: { epoch: number; onlyAt?: string }`. When the secret `POLYMORPH_SECRET` is set and the stock list exists at the fork's pinned tag (read from the `stock` repo and cached by stock commit), derive the seed, morph the map after `buildModuleMap`, and add `m<fingerprint>` to both the isolate id and the build cache key. `LoadedFork.morph` reports `{ epoch, fingerprint, names } | null`. With `onlyAt`, morph only when the resolved commit equals it.
2. (3a) Gate: `GateInput.morph?: { epoch: number }`. Load plain and renamed copies, send each runner request to both, return the renamed card to the runner, and record each difference (cards compared with `cardDifferences`, which drops `answer_id` and `fork_commit`) as a tier 1 failure with probe id `polymorph-equivalence`. When both copies throw, compare the messages after mapping renamed names back. Report `polymorph: { epoch, fingerprint, compared, mismatches } | null` on the gate result.
3. (3a) `unmorphText(text, names)`: replaces every renamed name with its original. Every error that leaves a renamed copy (`askCard` failures, gate failure details, logs) goes through it.
4. (3a) Fleet: per fork `morph_epoch`, `morph_sha`, `morph_fp`, `morph_at` (migration pattern at `src/durable/fleet.ts:129-132`), `morphState(repo)`, `setMorph(repo, state)`, a `security_events` table with `recordSecurityEvent` and `securityEvents`, and a `security` fleet event that carries only repo, kind, and time.
5. (3a) `platform/src/polymorph/rotate.ts`: `rotateFork(deps, repo, reason)` runs a check mode gate at main with the next epoch and stores it only on a pass. Returns `rotated`, `refused` (with failures), or `skipped` (no secret, no list, fork not ready).
6. (3b) Live path: `serveAsk` reads the fork's morph state with its existing Fleet call, loads with `morph: { epoch, onlyAt: sha }`, runs `scanRequest` before asking, and on a hit refuses with a 403 style error (the same answer for decoy and foreign hits), records a security event, and starts a `fluid-rotate` instance for that fork whose id includes the copy's fingerprint, so a flood of hits starts one rotation. Answers carry `fork.variant` (the fingerprint) and the ledger row gets `variant` the way it gets `reask_of`.
7. (3b) `fluid-rotate` workflow in `cloudflare.config.ts` with `schedules: "0 */6 * * *"`, exported from `src/index.ts`, added to `AppExports` and to the Runs kinds. With a repo it rotates that fork; without one it fans out over the fleet with the existing batch pattern. Add `POST /api/admin/fleet/rotate`. When a merge mode gate lands a change on a fork's `main`, start a rotation for that fork so the new commit gets a verified copy (until it finishes, the fork runs plain because `onlyAt` no longer matches).

## Stage 4: End-to-end fleet experiment and docs
**Goal**: measure what polymorphic installation does against a planted zero-day, through the real platform code paths.
**Success Criteria**: one test provisions 20 forks on a fixture release with two planted bugs and reports, and asserts: the upstream-built exploit compromises 20 of 20 plain forks and 0 of 20 renamed forks, and all 20 renamed forks refuse it and start a rotation; a leaked copy works only on its own fork and stops working after that fork rotates; 1000 blind guesses compromise nothing and are all refused; the public-field bug compromises 20 of 20 in both fleets; every copy passed the equivalence check with 0 differences. `npm run polymorph:demo` prints the scoreboard.
**Tests**: `platform/test/polymorph-e2e.test.ts`, fixture `platform/test/fixtures/zero-day.ts`.
**Status**: Not Started

Tasks:
1. `platform/test/fixtures/zero-day.ts`: `zeroDayRelease(files)` patches `app/cards.ts` in `draftFor` so display options are spread into the `enforceContract` options after the safety flag (mass assignment), and adds a public `display.preview` switch that skips the attestation hold. Anchors must throw if stock changes. Stock itself stays clean.
2. `platform/test/polymorph-e2e.test.ts` with the fakes from stage 2 and the wiring from stage 3. Exploits: A, built from upstream source (`display: { researchNeedsAttestation: false }`); A2, built from fork 7's copy; A3, 1000 random suffixes on fork 3; B, `display: { preview: true }`. Measure direct compromise (calling the fork without the platform's scan) and platform outcomes (refused, rotations started).
3. `platform/package.json`: `polymorph:demo` script (content step first).
4. Docs: `docs/POLYMORPH.md` (what it does, how to run it, measured results, limits), README section, `docs/DEPLOY.md` (the secret, thirteen workflows), `docs/GATE_AND_AGENTS.md` and `docs/API.md` (new tier 1 check, rotation, admin route), `docs/OVERVIEW.md` tenant hooks, and the results in the design doc.

## Stage 5: Mock mode view
**Goal**: show the experiment in the browser like the other demos.
**Success Criteria**: `/?mock=1#polymorph` replays a recorded run of the stage 4 experiment (forks, fingerprints, attacks, refusals, rotations), says plainly that it is a replay, builds DOM only with `h()`, and passes a UI test.
**Tests**: `platform/test/ui-polymorph.test.ts`.
**Status**: Not Started

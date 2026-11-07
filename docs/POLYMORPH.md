# Polymorphic installation

Every Fluid fork starts from the same upstream code. A bug in upstream sits in every fork, so one exploit built from upstream's public source can reach every user at once. Polymorphic installation gives each fork its own running copy of that code, with upstream's internal names renamed by a secret seed. The gate checks that the copy answers like the plain fork. The original names become tripwires, and every copy rotates.

This page describes what the platform does and what the 20-fork experiment measured. The question, the background research, and the threat model are in the [design doc](plans/2026-11-06-polymorphic-installation-design.md) for [issue #1](https://github.com/renato-umeton/fluid/issues/1).

Code: `platform/src/polymorph/`, the loader (`platform/src/runtime/loader.ts`), the gate (`platform/src/gate/run.ts`), the live ask path (`platform/src/api/ask.ts`), Fleet (`platform/src/durable/fleet.ts`), and the Rotate workflow (`platform/src/workflows/rotate.ts`).

## How a copy is made

### Upstream lists the names that may move

`stock/polymorph.json` holds `{ "version": 1, "description": "...", "names": [...] }`. It lists 74 internal names of the medical app, for example `researchNeedsAttestation`, `enforceContract`, and `buildCard`. Upstream checks its own list in `stock/tests/unit/polymorph-list.test.ts`. Each listed name must be:

- a plain identifier other than a keyword, a global, or a property of a standard built-in;
- used as an identifier in runtime code;
- absent from every string, template text, and regular expression of runtime code, from runtime JSON and the synthetic data (keys and string values), and from the probe suites and the demo overlay;
- absent from the request, card, ledger, and env shapes, from what `app/types.ts`, `app/toml.ts`, and `app/index.ts` export, and from the names the platform and the browser bundle import from stock.

The list ships with stock. `platform/scripts/bundle-content.mjs` bundles it with the other `STOCK_INCLUDE` files into `src/generated/stock-source.json`, and the stock publisher (`platform/src/stock/publish.ts`, run by `POST /api/admin/stock/publish` or `npm run publish-stock`) commits that bundle to the `stock` repo.

The platform reads the list from stock at the tag the fork's `fluid.toml` pins, the way the gate reads the probes, so a fork cannot shrink it. A release without a list runs every fork plain. So does a release whose list the platform refuses. It refuses a list that:

- is not valid JSON, or not a JSON object;
- has a version other than 1;
- has `names` that are not a list of strings;
- lists a name twice;
- holds a name that is not a plain identifier;
- holds a reserved name: a keyword, or a name the language or the runtime contract reads, such as `then` or `fluidToml`.

### A secret seed per fork, commit, and epoch

```
seed   = HMAC-SHA256(POLYMORPH_SECRET, "polymorph:v1:<repo>:<sha>:<epoch>")
suffix = 8 base36 characters from HMAC-SHA256(seed, name), one per listed name
```

`researchNeedsAttestation` becomes `researchNeedsAttestation$` followed by its 8 characters. A suffix holds about 41 bits (36^8 is about 2.8 trillion). Each name gets its own suffix, so learning one renamed name tells nothing about the others. A public fingerprint of 8 hex characters, also derived from the seed, names the copy in answers and in the ledger without revealing the seed. A second 8 hex character hash names which listed names the copy renamed. A new commit or a new epoch gives a new copy. A fork's first copy is epoch 1, and each rotation that stores a copy adds one.

### The loader renames at load time

The loader turns a fork's files at a commit into modules (`buildModuleMap`). When a load asks for a copy (`LoadOptions.morph`), `morphFork` then renames every identifier token that matches a listed name the copy does not skip (see below), in every JavaScript module except the generated entry. It finds the tokens with sucrase's parser, the one the loader already uses to strip types. Strings, comments, regular expressions, and JSON modules stay as they are.

Git keeps the readable code. The customize agent, recipes, contests, merges, and intent replay all work on the plain text, as before. Plain loads are never renamed.

Two callers ask for a copy:

- **A rotation's gate.** `rotateFork` runs a check mode gate with `GateInput.morph`, and only `rotateFork` passes it (see "How the gate checks a copy").
- **The live ask path.** It asks for a copy when Fleet holds a verified copy of the fork. At the copy's commit it loads the copy. At any other commit it builds the stored copy without starting it, only to get its names for the tripwire scan.

A fork's first copy comes from a rotation: `POST /api/forks` and `SeedForkWorkflow` each start one, and it makes and checks that copy.

A built copy is cached in the platform isolate under its own isolate id, so each copy runs in its own Worker Loader isolate:

```
repo:sha[:variant][:m<epoch>.<fingerprint>.<namesHash>][:llm]
```

Without a copy, the id has no `:m<epoch>.<fingerprint>.<namesHash>` part.

### What a copy skips, and why

Renaming touches identifiers only. A name that reaches the fork's code as text can be read back as a property name at run time, and that use would not be renamed. So a copy skips, name by name:

- names the fork's own modules use as text: in a string, template text, a regular expression, or a JSON key or string value. A fork that reads `r.context["evidence"]` keeps `evidence` plain;
- names in the fork's own contract: `tests/user/manifest.json`, `tests/user/e2e.json`, and `fluid.toml`. Requests and config bring these words to the fork's code as data;
- names the runtime defines: globals and the properties of built-ins in that runtime;
- names the runtime reads from objects the fork creates, such as stream sources, event listener options, and WebCrypto parameters.

A skipped name is neither renamed nor a tripwire, so it costs the copy that one name. The gate reports each skipped name with its reason. In the experiment, every copy renamed all 74 names.

### When no copy can be made

The fork then runs plain, and the loader logs one line: `polymorph: <repo>@<short sha> runs plain: <reason>`, where the short sha is the commit's first 7 characters. Each isolate logs it at most once per fork commit, epoch, and reason every 10 minutes. The reasons:

- no usable secret, a `fluid.toml` that pins no stock tag, or a pinned release with no list;
- a list the platform refuses, or a pin that names no published release;
- more code than the renamer reads. The caps count characters (JavaScript string length): 262,144 in one module, and 1,048,576 across the fork's modules. A JavaScript module counts its source. A JSON module counts the characters of its keys and strings, plus one for every other value. The generated entry does not count. Each contract file is also capped at 262,144 characters, apart from the total;
- a module the parser cannot read, or one that nests deeper than its stack;
- a module that already uses one of the copy's renamed names;
- a candidate change under validation (a build with extra files);
- a stored copy that this load no longer makes as verified: another commit, another fingerprint (the secret changed), or another names hash (other names are skipped now);
- a read of upstream's list or the fork's contract that failed in Artifacts.

On the live path, a failed read of a stored copy gets a 503 instead, and a stored copy that no longer builds as verified starts a `mismatch` rotation (see "Tripwires and refusals").

## How the gate checks a copy

A rotation runs `runGate` in check mode on `main`, with one sample per probe and `morph: { epoch }` for the next epoch. The gate loads the plain fork and the renamed copy at the gated commit, both in the gate's own isolate variant. Every request that stock's runner sends goes to both at once. The runner sees the copy's answer, so tiers 1 to 3 judge the copy too.

- **Names mapped back first.** Everything a copy sends back, its cards and its error messages, passes through `askLoaded`, which maps renamed names back to the originals (`unmorphText`) before anything else sees it.
- **Exact match.** Every value of the two cards must match (`cardDifferences` in `platform/src/polymorph/equivalence.ts`). Only `answer_id` and `fork_commit` are ignored, at any depth. A key whose value is undefined counts as absent, and key order does not matter. Two errors match when their messages match. A card on one side and an error on the other is a difference.
- **Failures.** A difference fails tier 1 as probe `polymorph-equivalence`, ahead of what the suites found. The first 10 differences are recorded. When there were more, the last one says how many requests differed in all. A copy that no request reached fails too, since nothing showed that it answers like the fork. The failure text never names the copy.
- **Result.** `GateResult.polymorph` is `{ epoch, fingerprint, namesHash, compared, mismatches, skipped }`: the copy, the requests sent to both sides, the requests the two answered differently, and the listed names the copy skipped, with why. When the gate could make no copy, it runs as without one, `polymorph` is null, and `polymorphPlain` says why.

Details in [GATE_AND_AGENTS.md](GATE_AND_AGENTS.md#polymorphic-installation).

## Tripwires and refusals

No request needs an internal name. In a renamed copy the original names are dead, so a request key that uses one was built from upstream's source. A key with another copy's suffix came from another copy. The live path (`serveAsk`, behind `POST /api/ask`) scans every request to a fork with a stored copy, on every ref, before the fork sees it:

- **Decoy:** a key exactly equal to a name this copy renamed.
- **Foreign:** a key `<name>$<8 base36 characters>` for one of those names, with a suffix other than this copy's.

Only the keys of plain objects are checked, at any depth up to 32 levels and 10,000 keys (array elements count toward that). Values are never inspected. Only the names this copy renamed are tripwires: a listed name the copy skipped never trips, and the copy's own renamed names do not either.

| Case | Answer |
| :-- | :-- |
| A key hits a tripwire | 403 `Request refused by a security check.`, the same for both kinds. The platform records a `tripwire` security event and starts one rotation of this copy in each 10-minute window, however many requests trip it. The fork is not asked, and no ledger row is written. |
| The request is too deep or has too many keys to scan | 400 `Request too large or too deeply nested.` Nothing is recorded, and no rotation starts. |
| The stored copy cannot be built because a read failed in Artifacts | 503 `The fork's renamed copy could not be loaded; retry shortly.`, with `retry-after: 10`, on every ref. Nothing is recorded, and no rotation starts. |
| The stored copy no longer builds as verified for another reason (a changed secret, other names, code the renamer refuses now) | The plain fork answers without a scan, and a rotation starts (reason `mismatch`). If that rotation stores no new copy, it builds the stored copy again. When that still fails, for a reason other than a failed read, the rotation clears the stored copy and records `copy_cleared`. The fork then answers as one with no copy until a later rotation stores one. |

Error bodies carry `error` and `requestId`, like every other API error.

Which code answers a request that passes:

- **At the copy's commit,** the copy answers, always with the model off. `useModel` comes from the request body, so honoring it would let any request bypass the copy, and the gate checked the copy with the model off. The answer carries `fork.variant` (the copy's fingerprint), and its ledger row gets `variant`.
- **At any other commit,** the platform scans the request with the stored copy's names, and then the plain fork answers, with the model if asked. That covers another branch or tag, and `main` after a change lands and before its rotation stores a copy of it.

The stored copy was made from the commit that `main` had at its last passing rotation. That commit may no longer be `main`'s head.

These asks run with no copy and no scan:

- every ask on a platform without a usable secret, even when Fleet holds a copy;
- a fork that has no stored copy yet;
- the yellow soak's end-to-end host, which asks the commit as it landed through its own entry point, `serveAskAsBuilt` (`serveAsk` has no input that turns the guard off);
- `main` under an active safety fallback, where stock answers. The safety fallback (main only) and the clinical dose backstop are unchanged.

## Rotation

`rotateFork(deps, repo, reason)` (`platform/src/polymorph/rotate.ts`) moves a fork to its next epoch. It runs the check mode gate above and stores the new copy in Fleet only when the gate passes, and only if no other rotation stored one first (compare-and-set on the epoch it read before the gate). Once the new copy is stored, whatever an attacker learned about the old copy goes stale. A copy that fails the gate never goes live: the fork keeps the copy it has.

A rotation of a fork that is `provisioning`, `upgrading`, or `gating` waits: the workflow tries again a minute later, up to 5 times, and notes each wait on the run. A rotation skips when:

- there is no usable secret;
- the fork is not in the fleet;
- the fork is still busy after the last try;
- the gate could make no copy;
- `main` moved during the gate;
- another rotation moved the fork first.

A skip changes nothing, except that a `mismatch` rotation clears a stored copy that no longer builds (see "Tripwires and refusals"). A failed read in Artifacts throws instead, so the workflow step retries.

Rotations run in the `fluid-rotate` workflow. What starts one:

| Trigger | Reason | How often |
| :-- | :-- | :-- |
| The schedule, `0 */6 * * *`: an instance with no repo starts one rotation per fork that is not provisioning, in batches of 20 | `schedule` | every 6 hours |
| A tripwire hit on the live path | `tripwire` | one per copy in each 10-minute window |
| A stored copy that no longer builds as verified | `mismatch` | one per copy in each 10-minute window |
| A change landing on `main`: a merge mode gate (customizations, outside imports, contest picks, repair applies), an upgrade with `auto_upgrade`, a one-tap upgrade approval, or a yellow rollback | `landed` | one per landed commit |
| A new fork: `POST /api/forks`, and `SeedForkWorkflow` for a seeded fork with no change still gating | `install` | one per fork |
| `POST /api/admin/fleet/rotate`, for one fork or the whole fleet | `admin` | each request |

Each rotation logs a `rotate` run (`GET /api/runs/:runId`): a rotated or refused run records the epoch and the commit, and a skipped one its `cancelReason`. The run never holds the copy's fingerprint. Details in [GATE_AND_AGENTS.md](GATE_AND_AGENTS.md#rotation) and [API.md](API.md#rotate-run-record).

## Records

- **Fleet's copy state.** Fleet keeps the verified copy of each fork: epoch, commit, fingerprint, names hash, and when it was stored. Only a rotation changes it, by compare-and-set. It is never part of the public fleet entries.
- **Security events.** `tripwire` (which kind of tripwire, the listed name, the key's path, the copy's epoch and fingerprint), `rotated` (reason, epoch, fingerprint), `rotation_refused` (reason, epoch, number of failures), and `copy_cleared` (epoch, and why the stored copy no longer builds). Fleet keeps the latest 100 per fork. No route serves them yet.
- **The public fleet stream** gets a `security` event with only the repo, the kind, and the time, at most one per fork and kind every 10 seconds. `rotation_refused` and `copy_cleared` are never broadcast.
- **Answers and the ledger.** An answer from a copy carries `fork.variant` (the fingerprint), and its ledger row carries `variant`.

## Setup

Polymorphic installation is optional. It needs one secret, `POLYMORPH_SECRET`, of at least 16 characters, set as a Worker secret. It is deliberately not declared in `platform/cloudflare.config.ts`, because a declared secret must exist at deploy time, and Fluid runs without this one. [DEPLOY.md](DEPLOY.md#6-create-the-secrets-file) shows how to set it.

Without it, or with one shorter than 16 characters, every fork runs plain: no copies, no scan, no rotation. The schedule still starts a `fluid-rotate` instance every 6 hours, which records a rotate run marked `cancelled` ("Skipped: POLYMORPH_SECRET is not set or is shorter than 16 characters"). `POST /api/admin/fleet/rotate` still starts runs, which skip the same way. A secret that is set but shorter than 16 characters also logs one warning per isolate.

Copies also need `polymorph.json` in the stock release that a fork pins. On a deployment whose stock tags were published before the list existed, every rotation skips (`stock <tag> publishes no polymorph.json`) until its forks pin a release that has the list. [DEPLOY.md](DEPLOY.md#polymorphic-installation-on-an-existing-deployment) shows how to publish one and move the fleet to it.

Once the secret is set and the pinned release has the list, each fork gets its first copy at its next rotation. To give every fork one now, send `POST /api/admin/fleet/rotate` with body `{}`. A new secret makes new copies: a stored copy made with the old one no longer matches, so its fork answers plain and starts a rotation on its next request.

## Run the experiment

The experiment is `platform/test/polymorph-e2e.test.ts`. Its fixture, `platform/test/fixtures/zero-day.ts`, builds a stock release tagged v1.1.0, the next minor release after the v1.0.0 the platform bundles. The release exists only in the test's in-memory stock repo and is never published as stock. It plants two bugs in `draftFor` in `app/cards.ts`. Both pass every probe, as a real zero-day would, because no probe sends display options.

- **Bug A, mass assignment.** Display options from `context.display` are spread into the options of `enforceContract` after the safety flag. A request that sets `display.researchNeedsAttestation` to false releases a held research dose. The exploit has to name an internal property.
- **Bug B, a public switch.** `display.preview: true` skips the attestation hold. It names only public fields.

The test provisions the forks on the fixture release, with in-memory fakes for Artifacts and the Worker Loader, and installs each fork as a renamed copy (one rotation each). It then sends each attack three ways: to the plain fork, to the fork's stored copy with nothing scanning the request (as if the platform's scan were bypassed), and through `serveAsk` on `main`, which may refuse the request and start a rotation. Each rotation started then runs, as the workflow would. Every attack starts from the installed copies. The platform secret and the guesses' seed are fixed by default (`POLYMORPH_TEST_SECRET` and `POLYMORPH_GUESS_SEED` override them), so every default run makes the same copies and sends the same guesses.

- **A, built from upstream's source:** `display: { researchNeedsAttestation: false }` on every fork.
- **A2, built from a leaked copy:** the same option under fork 7's renamed name, on every fork. Then the schedule moves fork 7 to its next copy, and the request is sent to fork 7 again.
- **A3, blind guessing:** 1000 requests to fork 3, each with the option under a random 8-character suffix.
- **B, public field only:** `display: { preview: true }` on every fork.

It needs Node 22.18 or later, a git clone (the content step bundles stock from `git HEAD`), and `npm install` in `platform/`. It needs no Cloudflare account: Artifacts and the Worker Loader are in-memory fakes.

```sh
cd platform
npm run polymorph:demo     # prints the scoreboard for 20 forks
npm run polymorph:record   # writes public/data/polymorph-demo.json after checking it with the view's validateDemo
npm test                   # the regular suite runs the same test with 4 forks
```

Both scripts run `npm run content` first. A 20-fork run takes about 15 seconds. The view at `/?mock=1#polymorph` replays the recording (see [UI.md](UI.md#polymorphic-installation)).

## Measured results

Twenty forks, from `npm run polymorph:demo`:

| Attack | Plain fleet | Renamed copies, scan bypassed | Through the platform | Refused | Moved to a new copy |
| :-- | :-- | :-- | :-- | :-- | :-- |
| A: built from upstream's source | 20 of 20 | 0 of 20 | 0 of 20 | 20 of 20 | 20 of 20 |
| A2: built from fork 7's leaked copy | 0 of 20 | 1 of 20 | 1 of 20 | 19 of 20 | 19 of 20 |
| A3: 1000 blind guesses on fork 3 | 0 of 1000 | 0 of 1000 | 0 of 1000 | 1000 of 1000 | 1 of 1 fork |
| B: public field only | 20 of 20 | 20 of 20 | 20 of 20 | 0 of 20 | 0 of 20 |

The first three result columns count requests that released a held research dose (7 mg) while an identified patient was in context and no attestation was given. "Refused" counts requests, and "Moved to a new copy" counts forks.

- **Equivalence.** On 20 of 20 forks the renamed copy answered all 70 probe requests like the plain fork, with 0 differences. Each copy renamed 74 of 74 listed names.
- **Tripwires.** Attack A hit a decoy tripwire on every fork. A2 and A3 hit foreign tripwires.
- **A leaked copy.** The exploit built from fork 7's copy compromised only fork 7. After fork 7 moved to a new copy, the leaked names compromised 0 forks and were refused on fork 7.
- **Guessing.** No guess found fork 3's real suffix: 1000 guesses out of 36^8 suffixes.
- **Public fields.** Attack B compromised every fork, renamed or not.

The recording is `platform/public/data/polymorph-demo.json`.

## Limits

- **Public behavior.** A bug reachable through public fields alone works on every copy (attack B). Renaming cannot hide a name that callers use.
- **Disclosure.** A leaked copy works on its own fork until that fork rotates (attack A2): within 6 hours on the schedule, sooner after a change lands, and longer while its rotations are refused or skip.
- **One secret.** Every copy's names come from `POLYMORPH_SECRET`. Whoever reads it can compute every fork's renamed names, so the design assumes it never leaves the platform. If it leaks, replace it: copies made with the old one stop matching, and each fork rotates to a new copy (see "Setup").
- **Coverage.** Only listed names move. Code a fork adds stays plain unless upstream lists its names.
- **Other classes.** Logic bugs, timing, and denial of service are untouched. Prototype pollution gadgets that read names fixed by the runtime survive renaming.
- **Tested equivalence.** The gate checks equivalence only on the behavior that the probes test. A difference that no probe reaches goes unseen.
- **Model off.** Copies answer with the model off.
- **A fork's own fields.** When a fork reads a request field of its own whose name is on the list, that field stays plain only when the fork's tests (`tests/user/manifest.json`, `tests/user/e2e.json`), its `fluid.toml`, or its modules' text name it. Otherwise the copy renames the code that reads the field, so the copy answers differently, and a request that sends the field under its original name is refused as a decoy. Naming the field in the fork's own tests fixes it.
- **Rotation needs a pass.** A rotation needs the whole check mode gate to pass. A fork whose `main` fails a tier keeps the copy it has, or stays plain.
- **After a change lands.** Until the landed commit's rotation stores a copy of it, `main` answers plain, behind the stored copy's scan.
- **Runtime upgrades.** A runtime upgrade can cost a name: a name the new runtime builds in is skipped from then on. The stored copy then no longer matches, so the fork answers plain until it rotates, and a `mismatch` rotation that stores no new copy clears the old one.
- **Cost.** Each rotation is a check mode gate that asks every probe twice, and the schedule runs one per fork every 6 hours.
- **Tests share one process.** Tests simulate isolates in one Node process. The experiment checks that no attack changed a built-in the isolates share.
- **Not on the live site yet.** Nothing has run on the deployed site yet.

## Next steps

- Freeze built-in prototypes in the fork isolate before the app loads, as GHunter recommends (see the design doc's [background](plans/2026-11-06-polymorphic-installation-design.md#background)), and check inside the isolate after each answer that they are unchanged.
- Trace a foreign suffix back to the fork that leaked it, and rotate that fork too.
- Let a fork raise its rotation rate in `fluid.toml`, a preference that only moves toward safety.
- Derive the list from the contract automatically.
- Add model wording for renamed copies.
- Add a route that shows a fork's security events to admins.
- Run polymorphic installation on the deployed site.

## Related documents

- [plans/2026-11-06-polymorphic-installation-design.md](plans/2026-11-06-polymorphic-installation-design.md): the question, background research, threat model, and design.
- [GATE_AND_AGENTS.md](GATE_AND_AGENTS.md): the equivalence check and the Rotate workflow in detail.
- [API.md](API.md): the refusals, `fork.variant`, the ledger's `variant`, and the rotate route and runs.
- [UI.md](UI.md): the Polymorph view that replays the experiment.
- [DEPLOY.md](DEPLOY.md): setting `POLYMORPH_SECRET`.

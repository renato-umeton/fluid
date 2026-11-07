# Polymorphic installation: design

Issue: [#1](https://github.com/renato-umeton/fluid/issues/1), "Can the polymorphic aspect of Fluid be turned into an advantage to protect from zeroday cyberattacks?"
Date: 2026-11-06. Status: the proof of concept is built on branch `issue-1-polymorphic-installation` and measured in tests (20 forks, with in-memory fakes for Artifacts and the Worker Loader). It has not run on the deployed site yet. Feature doc: [../POLYMORPH.md](../POLYMORPH.md).

## The question

Every Fluid fork starts from the same upstream code. A bug in upstream sits in every fork, so one exploit built from upstream's public source can reach every user at once. The issue asks whether Fluid can make each installation different, and keep it changing, so that an attacker cannot build one exploit and reuse it everywhere.

## Short answer

Yes, for a large class of exploits, and Fluid is well placed to do it safely.

- Many exploits depend on details that callers never see: internal property names, internal function names, the shape of internal objects. If each fork runs a copy where those details are renamed with a secret seed, an exploit built against upstream stops working on the forks.
- The hard part of software diversity has always been knowing that the changed copy still works. Fluid already checks that for every change: the gate runs upstream's probes. A renamed copy goes live only when every probe gives the same answer as the plain fork. That shows equivalence on tested behavior; it is not a formal proof.
- The original names stay behind as tripwires. Only someone working from upstream's source would use them, so a blind attempt raises an alarm. The platform then starts a rotation at once, and the fork moves to a new copy when that copy passes its gate.

Limits, stated plainly: a transform that keeps behavior also keeps every bug that the public behavior exposes. A wrong rule or a missing check on a public request field stays exploitable. Polymorphic installation buys time between "bug found" and "fix shipped", and in that window it stops one exploit from reaching the whole fleet. The bug still needs a patch.

## Background

**Why now.** In October 2026 a cluster of incidents was reported under the name "Black October" (INCIBE-CERT, "Vulnerabilities and security incidents during Black October 2026", 3 Nov 2026). It included PHP2Shell (CVE-2026-109618 and CVE-2026-109619), which Wiz reports frontier models helped find and exploit ([Wiz, 21 Oct 2026](https://www.wiz.io/blog/php2shell-php-rce)); CISA added both to its Known Exploited Vulnerabilities list on 26 Oct 2026. Automated bug finding at scale was already public: in DARPA's AI Cyber Challenge, finalists found 54 of 63 synthetic vulnerabilities and 18 real ones ([DARPA, 8 Aug 2025](https://www.darpa.mil/news/2025/aixcc-results)), and Google reported that Big Sleep found SQLite CVE-2025-6965 ([Google, 15 Jul 2025](https://blog.google/technology/safety-security/cybersecurity-updates-summer-2025/)). When finding bugs gets cheap, the thing left to take away is reuse: one exploit that works on every copy of a program.

**The idea is old.** Cohen proposed an "evolver that operates at program installation" ([Computers & Security 1993](https://doi.org/10.1016/0167-4048(93)90054-9)). Forrest, Somayaji and Ackley argued that what a language leaves arbitrary should be random ([HotOS 1997](https://doi.org/10.1109/HOTOS.1997.595185)). Franz proposed an app store that hands every downloader "a unique, but functionally identical version" of each program ([NSPW 2010](https://doi.org/10.1145/1900546.1900550)). SQLrand appends a random key to SQL keywords so injected SQL fails, and strips the key from error messages ([ACNS 2004](https://doi.org/10.1007/978-3-540-24852-1_21)); renaming identifiers is the same move. Larsen et al. survey the field ([IEEE S&P 2014](https://doi.org/10.1109/SP.2014.25)). Crane et al. pair diversity with booby traps that only an attack can trigger ([NSPW 2013](https://doi.org/10.1145/2535813.2535824)), which is what our tripwires are. RaJa randomized JavaScript identifiers in the browser against cross-site scripting ([ISC 2010](https://doi.org/10.1007/978-3-642-18178-8_18)). We found no published work that renames server-side JavaScript names per installation against exploit reuse; that may only mean we did not find it.

**What the research says to watch for.**

| Finding | Rule we follow |
| :-- | :-- |
| Randomization that is not refreshed falls to brute force and to probing, and fast re-randomization adds little on its own ([Shacham et al., CCS 2004](https://doi.org/10.1145/1030083.1030124); [Bittau et al., S&P 2014](https://doi.org/10.1109/SP.2014.22)). | Strength comes from entropy per copy: every listed name gets its own 41-bit suffix. Copies are seeded independently, and a tripwire hit starts a rotation of that fork. |
| A tripwire that takes a service down turns detection into denial of service (Shacham et al.). | A hit refuses that one request and starts a rotation of the fork. The fork keeps serving. Hits start at most one rotation per fork in each 10-minute window, however many there are. |
| One leak can reveal a randomized layout ([Snow et al., S&P 2013](https://doi.org/10.1109/SP.2013.45)). | Copies and seeds stay inside the platform. Renamed names are mapped back to the originals in error messages before they leave it, as SQLrand does. |
| Diversity gives no advantage against attacks that do not depend on the randomized detail, and helps most against probing ([Evans, Nguyen-Tuong, Knight 2011](https://doi.org/10.1007/978-1-4614-0977-9_2)). | We claim protection only for exploits that name internal properties or functions, and the experiment includes an exploit that does not. Wrong guesses all get the same refusal, so names cannot be learned one at a time. |
| A test-based check shows equivalence only on tested behavior ([Baudry, Allier, Monperrus, ISSTA 2014](https://doi.org/10.1145/2610384.2610415)). | The rename is a consistent change of identifiers, and the list checks rule out the usual ways names leak into behavior (strings, JSON keys, card fields). The gate compares every probe answer on top of that. |
| Prototype pollution gadgets in Node.js and Deno read names fixed by the runtime, such as `shell` and `env` ([Silent Spring, USENIX Security 2023](https://www.usenix.org/conference/usenixsecurity23/presentation/shcherbakov); GHunter, Cornelissen, Shcherbakov and Balliu, USENIX Security 2024). | Renaming app names does not touch those. Fork isolates have no shell or network, and the next steps below add the hardening GHunter recommends. |

## Threat model

- **Attacker.** Anyone who can read upstream's public source and send requests to forks. This includes automated tools that search public code for bugs.
- **Goal.** One exploit that works on many forks.
- **Assumed safe.** The platform secret and each fork's running copy. An attacker who can read a fork's running copy owns that fork until its next rotation.
- **Out of scope.** Bugs reachable through public fields alone, denial of service, and attacks on the platform itself.

## How it works

### 1. Upstream lists the names that may move

`stock/polymorph.json` lists internal names: names that never appear in a request, a card, a ledger record, a probe, an env key, a JSON key, or a string in runtime code. Upstream checks its own list in a unit test. The platform reads the list from upstream at the fork's pinned tag, the same way it reads the tests, so a fork cannot shrink it. The platform rejects a list with keywords or contract names in it. It skips any listed name that the fork's own text uses (a string, template text, a regular expression, JSON, the fork's own tests, `fluid.toml`) or that the runtime already defines. A skipped name is neither renamed nor a tripwire, so a fork's own words cost only those names.

### 2. A secret seed per fork, commit, and epoch

`seed = HMAC-SHA256(POLYMORPH_SECRET, "polymorph:v1:<repo>:<commit>:<epoch>")`. Each listed name gets its own suffix from `HMAC-SHA256(seed, name)`, 8 base36 characters, about 41 bits: `researchNeedsAttestation` becomes `researchNeedsAttestation$k3f9q2xa`. Learning one suffix tells nothing about the others. A fingerprint (8 hex characters), also derived from the seed, names the copy in logs. Answers and the ledger name it by a random variant, which gives no way to test a guess of the secret. A fork's own code can still read its copy's renamed names, so the secret must be random. A new commit or a new epoch gives a new copy.

### 3. The rename happens when the platform installs the fork

The loader already turns a fork's files into modules (`buildModuleMap`). Right after that step, `morphModuleMap` renames every identifier token that matches a listed name, using sucrase's own parser to find tokens. Strings, comments, regular expressions, and JSON modules stay as they are. Git keeps the readable code, so the customize agent, recipes, contests, and merges work as before. The isolate id gains the fingerprint, so each copy runs in its own isolate.

### 4. The gate checks that the copy behaves the same

For a fork with a list, the gate sends every probe request to the plain fork and to the renamed copy and compares the two cards field by field, ignoring `answer_id` and `fork_commit`. Any difference is a tier 1 failure named `polymorph-equivalence`, and the copy never goes live. A fork runs a renamed copy only for a commit and epoch pair that passed this check. Otherwise it runs plain, as today.

### 5. Tripwires

In a renamed copy, the original names are dead. A request that uses one as a key, at any depth, can only come from someone working from upstream's source. The platform refuses that request, records a security event, and starts a rotation for that fork. A key shaped like a renamed name with another copy's suffix is treated the same way. A key that is exactly the fork's own renamed name is not flagged, so the experiment can show honestly what a leaked copy does. A renamed name inside a string value is refused, the fork's own included. The copy maps its own names back in what it answers, so an echoed value would otherwise confirm a guess.

### 6. Nothing renamed leaves the platform

Seeds and renamed copies never leave the platform. Everything a renamed copy sends back, its cards and its error messages, passes through one step that maps renamed names back to the original names, so neither an answer nor an error can leak a copy. A refused request gets the same answer whether it used an original name or a wrong suffix. When the rename step itself cannot run safely (code too large, code the parser cannot read), the fork runs plain and the platform logs why.

### 7. Rotation

A new workflow, `fluid-rotate`, moves every fork to its next epoch every 6 hours, starts a rotation of one fork at once after a tripwire hit, and moves a fork right after a change lands on its `main`. It runs the equivalence check first and keeps the old copy when the new one fails. Hits on one fork start at most one rotation in each 10-minute window, whatever copy they trip. Whatever an attacker learned about a copy goes stale at the next rotation.

## The proof of concept

### A planted zero-day, in a test fixture only

A fixture release changes one line in `app/cards.ts`: display options from `context.display` are spread into the options of `enforceContract` after the safety flag. That is a mass assignment bug, a common class in web APIs. It passes every tier, as a real zero-day would. The fixture also adds a second bug that needs only public fields: `display.preview: true` skips the attestation hold. Stock itself stays clean.

### Exploits

- **A, built from upstream's source:** `display: { researchNeedsAttestation: false }` releases a held research dose while an identified patient is in context.
- **A2, built from a leaked copy:** the same, with fork 7's renamed name.
- **A3, blind guessing:** 1000 random suffixes against one fork.
- **B, public-field bug:** `display: { preview: true }`.

### Fleet experiment

Twenty forks on the fixture release, run through the real loader, gate, and ask path with in-memory fakes for Artifacts and the Worker Loader. The test sends each request four ways: to each fork's plain code, through the ask path with installation off, to each renamed copy with nothing scanning the request, and through the ask path with the copies installed. Installation off must answer every request as the plain code did, so the plain fleet stands for it. The test measures what compromised a fork, what the platform refused, which rotations started, and the equivalence check of every copy. `npm run polymorph:demo` prints the scoreboard, and these are its results. The Polymorph view replays a recording of this experiment, `platform/public/data/polymorph-demo.json`.

| Attack | Sent | Plain fleet compromised | Renamed copies compromised, platform scan bypassed | Compromised through the platform | Refused by the platform | Moved to a new copy |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| A: built from upstream's source | 20 requests to 20 forks | 20 of 20 | 0 of 20 | 0 of 20 | 20 of 20 | 20 of 20 attacked forks |
| A2: built from fork 7's leaked copy | 20 requests to 20 forks | 0 of 20 | 1 of 20 | 1 of 20 | 19 of 20 | 19 of 20 attacked forks |
| A3: 1000 blind guesses on fork 3 | 1000 requests to 1 fork | 0 of 1000 | 0 of 1000 | 0 of 1000 | 1000 of 1000 | 1 of 1 attacked fork |
| B: public field only | 20 requests to 20 forks | 20 of 20 | 20 of 20 | 20 of 20 | 0 of 20 | 0 of 20 attacked forks |

Compromised and refused count requests out of those sent; moved to a new copy counts the forks attacked. A request compromised a fork when it released a held research dose (7 mg) while an identified patient was in context and no attestation was given.

- **Equivalence.** Every copy renamed 74 of the 74 listed names. On 20 of 20 forks the copy answered all 70 probe requests like the plain fork, with 0 differences.
- **A.** The exploit built from upstream's source compromised the whole plain fleet and no renamed copy. Every fork refused it as a decoy and moved to a new copy.
- **A2.** Fork 7's leaked names compromised only fork 7, since a copy's own renamed names are never its tripwires. The other 19 forks refused them as foreign. After fork 7 moved to a new copy, the leaked names compromised 0 forks and were refused on fork 7.
- **A3.** All 1000 guesses were refused, and one rotation started for fork 3.
- **B.** The public-field bug compromised 20 of 20 forks, renamed or plain.

So for this bug class the answer to the issue is yes: one exploit built from upstream's public source stopped working on every renamed copy, and every fork refused it and moved to a new copy. The public-field bug went through everywhere, as the limits below say.

### Where the build differs from this design

- **Where renaming happens.** The loader's entry point is `morphFork`, which skips names one by one; `morphModuleMap` is the strict form that refuses any skipped name. A copy is made only when a load asks for one: a rotation's gate, or the live path for a fork with a stored copy. Creating a fork starts a rotation, which makes its first copy.
- **Which gates check a copy.** Only a rotation's check mode gate compares the copy with the plain fork. Gates of pushed changes run as before.
- **Every ref is guarded.** While the platform has a usable `POLYMORPH_SECRET`, requests to any ref of a fork with a stored copy are scanned with that copy's names. The copy itself answers only at its commit. Any other commit, including `main` after a change lands and before its rotation, answers plain behind that scan. `main` under a safety fallback is answered by stock, unscanned.
- **Model off.** A copy always answers with the model off: `useModel` comes from the request body, so honoring it would let any request bypass the copy.
- **Reads fail closed.** When a read that the stored copy needs fails in Artifacts, the plain fork never answers the request unscanned. A failed read of upstream's list or of the fork's own tests gets a retryable 503. A failed read of the fork's own code or ref fails the ask as it does for any fork (500 for the code, 404 for the ref or a repo that cannot be opened).
- **When rotations start.** Tripwire hits start one rotation per fork in each 10-minute window, even when that rotation stores a new copy that the next hits trip. So a sustained flood of hits on one fork starts at most one tripwire rotation in each 10-minute window. Rotations also start for new forks, landed upgrades, one-tap approvals, yellow rollbacks, and stored copies that no longer build as verified.
- **Stale copies.** A stored copy that no longer builds as verified starts a `mismatch` rotation. Meanwhile the plain fork answers behind a scan with the names Fleet stored for the old copy, in which every suffix is foreign. A try of that rotation that stores no new copy, even a try that found the fork busy, builds the old copy again, and clears it when it still does not build. The fork then answers unscanned until a rotation stores a copy. Fleet keeps a cleared copy's epoch, and a deleted fork's latest epoch for a fork created again under the same name. The next copy is numbered above it. So a fork's epochs never repeat, and no retired copy comes back.

## Limits and open questions

- **Public behavior.** A bug reachable through public fields alone works on every copy (attack B). Renaming cannot hide a name that callers use.
- **Disclosure.** A leaked copy works on its own fork until that fork rotates (attack A2). Rotation bounds that window.
- **Coverage.** Only listed names move. Code a fork adds stays plain unless upstream lists its names.
- **Other classes.** Logic bugs, timing, and denial of service are untouched. Prototype pollution gadgets that read names fixed by the runtime survive renaming.
- **Tested equivalence.** The gate checks equivalence only on the behavior that the probes test. A difference that no probe reaches goes unseen.
- **Model off.** Copies answer with the model off.
- **A fork's own fields.** When a fork reads a request field of its own whose name is on the list, that field stays plain only when the fork's tests (`tests/user/manifest.json`, `tests/user/e2e.json`), its `fluid.toml`, or its modules' text name it. Otherwise the copy renames the code that reads the field, so the copy answers differently, and a request that sends the field under its original name is refused as a decoy.
- **Rotation needs a pass.** A rotation needs the whole check mode gate to pass. A fork whose `main` fails a tier keeps the copy it has, or stays plain.
- **After a change lands.** Between a landed change and its rotation, the fork answers plain behind the stored copy's scan.
- **Runtime upgrades.** A runtime upgrade can cost a name: a name the new runtime builds in is skipped from then on.
- **Hand-curated list.** A wrong entry leaves the fork less protected, in one of three ways. The platform may refuse the whole list, and then every fork on that release runs plain. A copy may skip the name, which is then neither renamed nor a tripwire. Only the gate's result says why, and no run or route shows it yet. A copy may fail the gate, and then the fork keeps the copy it has, or stays plain.
- **Cost.** Each rotation is a check mode gate that asks every probe twice. The schedule runs one per fork every 6 hours, and landed changes, new forks, tripwire hits, and stale copies add more. Tripwire hits add at most one per fork in each 10-minute window, however long a flood of decoys lasts.
- **Tests share one process.** In tests, isolates are simulated in one Node process. The experiment uses a bug class that leaves no shared state, and it checks that no attack changed a built-in the isolates share.
- **Not on the live site yet.** Nothing has run on the deployed site yet.

## Next steps beyond the proof of concept

- Freeze built-in prototypes in the fork isolate before the app loads, as GHunter recommends, and add a tripwire inside the isolate that checks them after each answer.
- Trace a foreign suffix back to the fork that leaked it and rotate that fork too.
- Let a fork raise its rotation rate in `fluid.toml`, a preference that only moves toward safety.
- Derive the list from the contract automatically instead of by hand.

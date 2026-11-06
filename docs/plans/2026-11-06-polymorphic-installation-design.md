# Polymorphic installation: design

Issue: [#1](https://github.com/renato-umeton/fluid/issues/1), "Can the polymorphic aspect of Fluid be turned into an advantage to protect from zeroday cyberattacks?"
Date: 2026-11-06. Status: proof of concept on branch `issue-1-polymorphic-installation`. Plan: [../IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md).

## The question

Every Fluid fork starts from the same upstream code. A bug in upstream sits in every fork, so one exploit built from upstream's public source can reach every user at once. The issue asks whether Fluid can make each installation different, and keep it changing, so that an attacker cannot build one exploit and reuse it everywhere.

## Short answer

Yes, for a large class of exploits, and Fluid is well placed to do it safely.

- Many exploits depend on details that callers never see: internal property names, internal function names, the shape of internal objects. If each fork runs a copy where those details are renamed with a secret seed, an exploit built against upstream stops working on the forks.
- The hard part of software diversity has always been knowing that the changed copy still works. Fluid already answers that question for every change: the gate runs upstream's probes. A renamed copy goes live only when every probe gives the same answer as the plain fork.
- The original names stay behind as tripwires. Only someone working from upstream's source would use them, so a blind attempt raises an alarm, and the platform moves that fork to a new copy at once.

Limits, stated plainly: a transform that keeps behavior also keeps every bug that the public behavior exposes. A wrong rule or a missing check on a public request field stays exploitable. Polymorphic installation does not replace a patch. It buys time between "bug found" and "fix shipped", and it stops one exploit from reaching the whole fleet in that window.

## Background

(filled in from the research brief)

## Threat model

- **Attacker.** Anyone who can read upstream's public source and send requests to forks. This includes automated tools that search public code for bugs.
- **Goal.** One exploit that works on many forks.
- **Assumed safe.** The platform secret and each fork's running copy. An attacker who can read a fork's running copy owns that fork until its next rotation.
- **Out of scope.** Bugs reachable through public fields alone, denial of service, and attacks on the platform itself.

## How it works

### 1. Upstream lists the names that may move

`stock/polymorph.json` lists internal names: names that never appear in a request, a card, a ledger record, a probe, an env key, a JSON key, or a string in runtime code. Upstream checks its own list in a unit test. The platform reads the list from upstream at the fork's pinned tag, the same way it reads the tests, so a fork cannot shrink it. The platform also rejects keywords, built-in names, and names that appear in strings or JSON keys of the fork's code.

### 2. A secret seed per fork, commit, and epoch

`seed = HMAC-SHA256(POLYMORPH_SECRET, "polymorph:v1:<repo>:<commit>:<epoch>")`. Each listed name gets its own suffix from `HMAC-SHA256(seed, name)`, 8 base36 characters, about 41 bits: `researchNeedsAttestation` becomes `researchNeedsAttestation$k3f9q2xa`. Learning one suffix tells nothing about the others. A public fingerprint (8 hex characters) names the copy in logs, the ledger, and the UI without revealing the seed. A new commit or a new epoch gives a new copy.

### 3. The rename happens when the platform installs the fork

The loader already turns a fork's files into modules (`buildModuleMap`). Right after that step, `morphModuleMap` renames every identifier token that matches a listed name, using sucrase's own parser to find tokens. Strings, comments, regular expressions, and JSON modules stay as they are. Git keeps the readable code, so the customize agent, recipes, contests, and merges work as before. The isolate id gains the fingerprint, so each copy runs in its own isolate.

### 4. The gate proves the copy behaves the same

For a fork with a list, the gate sends every probe request to the plain fork and to the renamed copy and compares the two cards field by field, ignoring `answer_id` and `fork_commit`. Any difference is a tier 1 failure named `polymorph-equivalence`, and the copy never goes live. A fork runs a renamed copy only for a commit and epoch pair that passed this check. Otherwise it runs plain, as today.

### 5. Tripwires

In a renamed copy, the original names are dead. A request that uses one as a key, at any depth, can only come from someone working from upstream's source. The platform refuses that request, records a security event, and starts a rotation for that fork. A key shaped like a renamed name with another copy's suffix is treated the same way. The fork's own renamed names are not flagged, so the experiment can show honestly what a leaked copy does.

### 6. Rotation

A new workflow, `fluid-rotate`, moves every fork to its next epoch every 6 hours, and moves one fork at once after a tripwire hit. It runs the equivalence check first and keeps the old copy when the new one fails. Whatever an attacker learned about a copy goes stale at the next rotation.

## The proof of concept

### A planted zero-day, in a test fixture only

A fixture release changes one line in `app/cards.ts`: display options from `context.display` are spread into the options of `enforceContract` after the safety flag. That is a mass assignment bug, a common class in web APIs. It passes every tier, as a real zero-day would. The fixture also adds a second bug that needs only public fields: `display.preview: true` skips the attestation hold. Stock itself stays clean.

### Exploits

- **A, built from upstream's source:** `display: { researchNeedsAttestation: false }` releases a held research dose while an identified patient is in context.
- **A2, built from a leaked copy:** the same, with fork 7's renamed name.
- **A3, blind guessing:** 1000 random suffixes against one fork.
- **B, public-field bug:** `display: { preview: true }`.

### Fleet experiment

Twenty forks on the fixture release, run through the real loader, gate, and ask path with in-memory fakes for Artifacts and the Worker Loader. The test measures compromise for a plain fleet and a polymorphic fleet, what the platform refuses, which rotations start, and the equivalence check for every copy. `npm run polymorph:demo` prints the scoreboard. Results: (filled in after the run)

## Limits and open questions

- **Public behavior.** Exploit B works on every copy. Renaming cannot hide a name that callers use.
- **Disclosure.** A leaked copy works on its own fork until the next rotation. Rotation bounds that window.
- **Coverage.** Only listed names move. Code a fork adds stays plain unless upstream lists its names.
- **Other classes.** Logic bugs, timing, and denial of service are untouched.
- **Cost.** The gate runs every probe twice for forks with a list, and each rotation is a check mode gate run.
- **Hand-curated list.** A wrong entry fails closed: the copy fails the gate and the fork stays plain.
- **Tests share one process.** In tests, isolates are simulated in one Node process. The experiment uses a bug class that leaves no shared state.

## Next steps beyond the proof of concept

- A tripwire inside the isolate for prototype pollution (a check of built-in prototypes after each answer).
- Trace a foreign suffix back to the fork that leaked it and rotate that fork too.
- Let a fork raise its rotation rate in `fluid.toml`, a preference that only moves toward safety.
- Derive the list from the contract automatically instead of by hand.

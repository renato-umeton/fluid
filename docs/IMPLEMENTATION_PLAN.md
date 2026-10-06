# Contest (v2.0 beta)

Best-of-N agents compete to grant one wish. A behavior diff replaces the pull request, and a fixed rule picks the winner.

## Stage 1: Behavior diff and winner rule
**Goal**: Pure code that turns answer cards captured during a gate into a per-probe diff, and a deterministic winner rule with plain reasons.
**Success Criteria**: Volatile card fields are ignored; diffs list added, removed, and changed fields with caps; the rule applies (a) to (d) in order and explains the choice and each loss.
**Tests**: `test/contest-behavior.test.ts`, `test/contest-winner.test.ts`.
**Status**: Complete

## Stage 2: Capture in the gate, wishes in flight, branch rules
**Goal**: `runGate` can record the fork's card for every probe in the host ask callback (runner and stock unchanged), and run extra probes that do not count toward the verdict. Contest branches are never gated by push events or the direct trigger. Customize and contest runs note their wishes; `GET /api/forks/:repo/wishes` lists them with the work branches and their intent records.
**Success Criteria**: Observations map each probe to its card and result; the consumer and direct trigger ignore `work/contest-*` and `work/inbox/contest-*`; wish notes are atomic and capped.
**Tests**: `test/contest-observe.test.ts`, `test/events.test.ts` additions, `test/contest-wishes.test.ts`.
**Status**: Complete

## Stage 3: Contest workflow and routes
**Goal**: `ContestWorkflow` runs N contestants at once (recipe, model plans with different prompts and temperatures, and optionally the user's own agent through the inbox), checks each one, gates each in check mode with capture, diffs against main, picks a winner, waits for the user's pick, and ships the pick through the normal merge gate.
**Success Criteria**: Quota counts a contest as N customizations; N is 2 or 3; one contest per fork at a time; late or unknown contest imports are refused; nothing reaches main except through a merge gate.
**Tests**: `test/contest-plan.test.ts` (lineup, branch names, join rules, quota, contest seat), `test/contest-route.test.ts`, `test/contest-join.test.ts`, `test/contest-wishes.test.ts` (list entry patching).
**Status**: Complete

## Stage 4: Contest screen and mock mode
**Goal**: A Contest view with contestants side by side, the behavior diff table, the winner banner, and "Ship this one" buttons; Customize offers "Run as a contest"; mock mode simulates a full contest.
**Success Criteria**: Built with `h()` only; states carry text, not color alone; the mock shows a floor failure, a pass that changes behavior outside the wish, and a winner; the browser rule matches the platform rule.
**Tests**: `test/ui-contest.test.ts`.
**Status**: Complete

## Stage 5: Docs
**Goal**: GATE_AND_AGENTS.md, API.md, UI.md, README.md describe Contest and wishes in flight.
**Success Criteria**: Routes, the contest record, the rule, and the limits are documented in plain words.
**Tests**: Full `npm test` in platform and stock, and the type check.
**Status**: Not Started

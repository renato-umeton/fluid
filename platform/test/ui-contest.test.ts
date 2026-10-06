import { describe, expect, it } from "vitest";
import { decideWinner, pickNotes, type Entrant } from "../src/contest/winner.ts";
// @ts-expect-error plain ES module from the static UI
import * as ui from "../public/js/contest-rules.js";
// @ts-expect-error plain ES module from the static UI
import { cellView, changeLine, countsLine, isFinalContest, joinCountdown, mainText, shipChoices, tierLines } from "../public/js/contest.js";
// @ts-expect-error plain ES module from the static UI
import { childRunAt, contestAt, mockContestScenario } from "../public/js/mock-contest.js";

const entrant = (label: string, over: Partial<Entrant> = {}): Entrant => ({ label, ready: true, problem: null, gatePassed: true, firstFailure: null, wishPassed: 2, wishTotal: 2, failingWish: [], outsideChanges: 0, filesChanged: 1, finishedAt: "2026-10-06T10:00:00.000Z", ...over });

const FIXTURES: Entrant[][] = [
	[entrant("recipe", { gatePassed: false, firstFailure: "invariant: inv-x (mode equals)" }), entrant("model-a")],
	[entrant("model-a", { outsideChanges: 2 }), entrant("model-b", { filesChanged: 3 })],
	[entrant("model-a", { filesChanged: 2 }), entrant("model-b")],
	[entrant("model-a", { finishedAt: "2026-10-06T10:00:05.000Z" }), entrant("model-b", { finishedAt: "2026-10-06T10:00:01.000Z" })],
	[entrant("recipe"), entrant("model-a")],
	[entrant("a", { ready: false, problem: "x" }), entrant("b", { wishPassed: 1, failingWish: ["t-1"] }), entrant("c", { wishTotal: 0, wishPassed: 0 })],
	[entrant("x", { outsideChanges: 3 }), entrant("y", { gatePassed: false, firstFailure: "f" }), entrant("z", { outsideChanges: 1 }), entrant("agent", { finishedAt: null })],
];

describe("the mock winner rule matches the platform's", () => {
	it.each(FIXTURES.map((f, i) => [i, f]))("fixture %i: same winner, reason, ranking, and notes", (_i, list) => {
		expect(ui.decideWinner(list)).toEqual(decideWinner(list as Entrant[]));
		for (const e of list as Entrant[]) expect(ui.pickNotes(list, e.label)).toEqual(pickNotes(list as Entrant[], e.label));
		expect(ui.pickNotes(list, "nobody")).toEqual(pickNotes(list as Entrant[], "nobody"));
	});
});

describe("contest screen text", () => {
	it("says each cell's result and whether it changed, in words", () => {
		expect(cellView({ passed: true, changed: false, total: 0, changes: [] })).toMatchObject({ state: "same", text: "pass, same as main" });
		expect(cellView({ passed: false, changed: true, total: 2, changes: [], scope: "outside" })).toMatchObject({ state: "outside", text: "fail, changed (2 fields)", label: "fail, answer changed from main (2 fields), outside the wish" });
		expect(cellView({ passed: true, changed: true, total: 1, changes: [], scope: "target" }).label).toContain("wording in a mode the wish targets");
		expect(cellView({ passed: null, changed: true, total: 0, changes: [], missing: true }).state).toBe("missing");
		expect(cellView(undefined).text).toBe("not run");
	});

	it("shows a test only one contestant ran as a new test, never as a change outside the wish", () => {
		expect(cellView({ passed: true, changed: true, total: 3, changes: [], scope: "own" })).toMatchObject({ state: "own", text: "pass, new test", label: "pass, a new test only this contestant runs; not counted against it" });
		expect(cellView({ passed: null, changed: false, total: 0, changes: [], missing: true })).toMatchObject({ state: "missing", text: "not run (another contestant's own test)" });
		expect(mainText({ passed: null, missing: true })).toBe("new test, not on main");
		expect(mainText({ passed: true })).toBe("pass");
	});

	it("writes field changes in plain words", () => {
		expect(changeLine({ path: "computed_dose", kind: "changed", before: null, after: { value: 5, unit: "mg" } })).toBe('computed_dose changed from null to {"value":5,"unit":"mg"}');
		expect(changeLine({ path: "sources.1.id", kind: "added", after: "reg-b" })).toBe('sources.1.id added: "reg-b"');
		expect(changeLine({ path: "framing.0", kind: "removed", before: "Research mode" })).toBe('framing.0 removed (was "Research mode")');
	});

	it("lists tiers with pass or fail spelled out", () => {
		expect(tierLines({ tiers: { invariant: { passed: false, total: 57, failed: 2 }, functional: { passed: true, total: 14, failed: 0 }, user: null } })).toEqual([
			{ name: "Tier 1 invariants", state: "fail", text: "fail: 55 of 57" },
			{ name: "Tier 2 functional", state: "pass", text: "pass: 14 of 14" },
			{ name: "Tier 3 your tests", state: "pending", text: "not run yet" },
		]);
	});

	it("counts down the join window", () => {
		const now = Date.parse("2026-10-06T12:00:00Z");
		expect(joinCountdown("2026-10-06T12:04:05Z", now)).toBe("Join window: 4:05 left");
		expect(joinCountdown("2026-10-06T11:59:00Z", now)).toBe("Join window closed");
	});

	it("offers to ship only contestants that passed, and only while the contest waits", () => {
		const run = { status: "waiting", verdict: { ranking: [{ label: "a", eligible: true }, { label: "b", eligible: true }, { label: "c", eligible: false }] } };
		expect(shipChoices(run)).toEqual(["a", "b"]);
		expect(shipChoices({ ...run, picked: { label: "a" } })).toEqual([]);
		expect(shipChoices({ ...run, status: "running" })).toEqual([]);
	});

	it("summarizes a contestant's counts", () => {
		expect(countsLine({ wish: { passed: 2, total: 2 }, outside: 1, files: ["app/cards.ts"] })).toBe("wish tests 2 of 2, 1 change outside the wish, 1 file");
	});
});

describe("mock contest", () => {
	const START = "2026-10-06T10:00:00.000Z";
	const opts = { runId: "run_contest_abc", repo: "user-x", startedAt: START, includeAgent: false };

	it("ends with a floor failure, a pass that changes behavior outside the wish, and a winner", () => {
		const scn = mockContestScenario({ contestId: "abc", request: "Add a plain-language summary line to research answers", size: 3 });
		const labels = scn.seats.map((s: { label: string }) => s.label);
		expect(labels).toEqual(["model-a", "model-b", "model-c"]);
		expect(scn.verdict.winner).toBe("model-a");
		const byLabel = Object.fromEntries(scn.entrants.map((e: Entrant) => [e.label, e]));
		expect(byLabel["model-c"]).toMatchObject({ gatePassed: false, firstFailure: expect.stringContaining("inv-chart-open-dosing-clinical") });
		expect(byLabel["model-b"]).toMatchObject({ gatePassed: true, outsideChanges: 2 });
		expect(byLabel["model-a"]).toMatchObject({ gatePassed: true, outsideChanges: 0, wishPassed: 2, wishTotal: 2 });
		expect(scn.verdict.reason).toBe(decideWinner(scn.entrants).reason);
	});

	it("moves from planning to a winner waiting for a pick, then ships the pick", () => {
		const scn = mockContestScenario({ contestId: "abc", request: "r", size: 3 });
		const first = contestAt(scn, 0, opts);
		expect(first.contestants.map((c: { status: string }) => c.status)).toEqual(["planning", "planning", "planning"]);
		expect(first.verdict).toBeUndefined();
		const waiting = contestAt(scn, scn.decideMs, opts);
		expect(waiting.status).toBe("waiting");
		expect(waiting.winner).toBe("model-a");
		expect(shipChoices(waiting)).toEqual(["model-a", "model-b"]);
		const pickAt = Date.parse(START) + scn.decideMs + 1000;
		const shipping = contestAt(scn, scn.decideMs + 1500, { ...opts, pick: { label: "model-b", at: pickAt } });
		expect(shipping.picked).toMatchObject({ label: "model-b", by: "you" });
		expect(shipping.notes["model-a"]).toBe("lost to model-b because you picked model-b (the rule chose model-a)");
		const done = contestAt(scn, scn.decideMs + 10_000, { ...opts, pick: { label: "model-a", at: pickAt } });
		expect(done.status).toBe("passed");
		expect(isFinalContest(done)).toBe(true);
		expect(done.notes["model-c"]).toMatch(/^lost to model-a because it failed the gate/);
	});

	it("seats your own agent last when it joins, and serves each contestant's timeline", () => {
		const scn = mockContestScenario({ contestId: "abc", request: "r", size: 3, includeAgent: true, recipe: true });
		expect(scn.seats.map((s: { label: string }) => s.label)).toEqual(["recipe", "model-a", "agent"]);
		const early = contestAt(scn, 1000, { ...opts, includeAgent: true });
		expect(early.contestants[2].status).toBe("waiting for your push");
		expect(early.agentBranch).toBe("work/contest-abc/my-entry");
		const child = childRunAt(contestAt(scn, scn.decideMs, { ...opts, includeAgent: true }), "run_contest_abc_agent");
		expect(child.steps[0].name).toBe("Wait for your agent");
	});
});

import { describe, expect, it } from "vitest";
import { decideWinner, eligibility, pickNotes, type Entrant } from "../src/contest/winner.ts";

const entrant = (label: string, over: Partial<Entrant> = {}): Entrant => ({
	label,
	ready: true,
	problem: null,
	gatePassed: true,
	firstFailure: null,
	wishPassed: 2,
	wishTotal: 2,
	failingWish: [],
	outsideChanges: 0,
	filesChanged: 1,
	finishedAt: "2026-10-06T10:00:00.000Z",
	...over,
});

describe("eligibility (rule a)", () => {
	it("needs a change, every tier, and every wish test", () => {
		expect(eligibility(entrant("a")).eligible).toBe(true);
		expect(eligibility(entrant("a", { ready: false, problem: "imports do not resolve" }))).toEqual({ eligible: false, why: "it could not produce a change (imports do not resolve)" });
		expect(eligibility(entrant("a", { gatePassed: false, firstFailure: "invariant: inv-clinical-no-dose (computed_dose equals)" }))).toEqual({ eligible: false, why: "it failed the gate: invariant: inv-clinical-no-dose (computed_dose equals)" });
		expect(eligibility(entrant("a", { wishPassed: 1, failingWish: ["t-x-summary"] }))).toEqual({ eligible: false, why: "wish test t-x-summary failed" });
		expect(eligibility(entrant("a", { wishPassed: 0, wishTotal: 0 }))).toEqual({ eligible: false, why: "no wish test ran, so nothing shows the wish was granted" });
	});
});

describe("decideWinner", () => {
	it("picks the only eligible contestant and says why the others lost", () => {
		const v = decideWinner([entrant("recipe", { gatePassed: false, firstFailure: "invariant: inv-tau-config-floor (thresholds.tau gte)" }), entrant("model-a")]);
		expect(v.winner).toBe("model-a");
		expect(v.reason).toBe("model-a wins: it is the only contestant that passed every tier and every wish test.");
		expect(v.notes.recipe).toBe("lost to model-a because it failed the gate: invariant: inv-tau-config-floor (thresholds.tau gte)");
	});

	it("rule b: fewest behavior changes outside the wish", () => {
		const v = decideWinner([entrant("model-a", { outsideChanges: 2 }), entrant("model-b", { outsideChanges: 0, filesChanged: 3 })]);
		expect(v.winner).toBe("model-b");
		expect(v.reason).toBe("model-b wins: like model-a, it passed every tier and every wish test, and it changed behavior on 0 probes outside the wish (model-a: 2).");
		expect(v.notes["model-a"]).toBe("lost to model-b because it changed behavior on 2 probes outside the wish (model-b: 0)");
	});

	it("rule c: fewest files changed", () => {
		const v = decideWinner([entrant("model-a", { filesChanged: 2 }), entrant("model-b", { filesChanged: 1 })]);
		expect(v.winner).toBe("model-b");
		expect(v.reason).toBe("model-b wins: like model-a, it passed every tier and every wish test, and it tied on behavior outside the wish (0 probes) and changed 1 file (model-a: 2).");
		expect(v.notes["model-a"]).toBe("lost to model-b because it changed 2 files (model-b: 1)");
	});

	it("rule d: earliest finished, then lineup order", () => {
		const v = decideWinner([entrant("model-a", { finishedAt: "2026-10-06T10:00:05.000Z" }), entrant("model-b", { finishedAt: "2026-10-06T10:00:01.000Z" })]);
		expect(v.winner).toBe("model-b");
		expect(v.notes["model-a"]).toBe("lost to model-b because it finished later (model-b finished first)");
		const tie = decideWinner([entrant("recipe"), entrant("model-a")]);
		expect(tie.winner).toBe("recipe");
		expect(tie.notes["model-a"]).toBe("lost to recipe because it tied on every rule and comes later in the lineup");
	});

	it("has no winner when nobody is eligible", () => {
		const v = decideWinner([entrant("a", { gatePassed: false, firstFailure: "x" }), entrant("b", { ready: false, problem: "y" })]);
		expect(v.winner).toBeNull();
		expect(v.reason).toBe("No winner: no contestant passed every tier and every wish test. Nothing ships; every branch stays for you to look at.");
		expect(v.ranking.map((r) => r.eligible)).toEqual([false, false]);
	});

	it("ranks eligible contestants by the rule", () => {
		const v = decideWinner([entrant("x", { outsideChanges: 3 }), entrant("y", { gatePassed: false, firstFailure: "f" }), entrant("z", { outsideChanges: 1 })]);
		expect(v.ranking.map((r) => r.label)).toEqual(["z", "x", "y"]);
	});
});

describe("pickNotes (the user overrides the rule)", () => {
	it("notes that the user picked another passing contestant", () => {
		const list = [entrant("model-a", { outsideChanges: 0 }), entrant("model-b", { outsideChanges: 2 }), entrant("agent", { gatePassed: false, firstFailure: "f" })];
		const out = pickNotes(list, "model-b");
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.notes["model-a"]).toBe("lost to model-b because you picked model-b (the rule chose model-a)");
		expect(out.notes.agent).toBe("lost to model-b because it failed the gate: f");
		expect(out.reason).toBe("You picked model-b over the rule's choice, model-a.");
	});

	it("refuses a contestant that did not pass", () => {
		const out = pickNotes([entrant("a"), entrant("b", { gatePassed: false, firstFailure: "f" })], "b");
		expect(out).toEqual({ ok: false, error: "b cannot ship: it failed the gate: f" });
	});

	it("refuses an unknown label", () => {
		expect(pickNotes([entrant("a")], "zz")).toEqual({ ok: false, error: "no contestant zz in this contest" });
	});

	it("agrees with the rule when the user picks the winner", () => {
		const out = pickNotes([entrant("a"), entrant("b", { outsideChanges: 1 })], "a");
		expect(out).toMatchObject({ ok: true, reason: "a wins: like b, it passed every tier and every wish test, and it changed behavior on 0 probes outside the wish (b: 1)." });
	});
});

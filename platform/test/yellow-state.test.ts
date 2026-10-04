import { describe, expect, it } from "vitest";
import { cancelRun, displayStatus, initialHealth, recordBrowser, recordFailure, recordPass, SOAK_PASSES, startYellow, type HealthState } from "../src/yellow/state.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const R = "r".repeat(40);
const at = "2026-10-04T12:00:00.000Z";
const failure = { tier: "stock", scenario: "e2e-ledger-provenance", step: "ask", detail: "ledger.fork_commit equals" };

function yellow(commit = B, runId = "run_y1", previous: string | null = A, state: HealthState = initialHealth()): HealthState {
	return startYellow(state, { commit, runId, previous, source: "customize", at }).state;
}

describe("yellow state machine", () => {
	it("starts every fork with no history green", () => {
		expect(initialHealth()).toMatchObject({ health: "green", lastGreenCommit: null, runId: null, of: SOAK_PASSES });
	});

	it("a fork with no history treats main before its first change as the last green commit", () => {
		const t = startYellow(initialHealth(), { commit: B, runId: "run_y1", previous: A, source: "customize", at });
		expect(t.state).toMatchObject({ health: "yellow", commit: B, lastGreenCommit: A, runId: "run_y1", pass: 0 });
		expect(t.events.map((e) => e.event)).toEqual(["yellow"]);
	});

	it("starting the same run again changes nothing (workflow step retries)", () => {
		const s = yellow();
		expect(startYellow(s, { commit: B, runId: "run_y1", previous: A, source: "customize", at })).toEqual({ state: s, events: [] });
	});

	it("turns green after three consecutive passes, and the yellow commit becomes the last green", () => {
		let s = yellow();
		for (const pass of [1, 2]) {
			const t = recordPass(s, { runId: "run_y1", pass, at });
			expect(t.state.health).toBe("yellow");
			expect(t.state.pass).toBe(pass);
			s = t.state;
		}
		const t = recordPass(s, { runId: "run_y1", pass: 3, at });
		expect(t.state).toMatchObject({ health: "green", lastGreenCommit: B, commit: B, runId: null, pass: 3 });
		expect(t.events.map((e) => e.event)).toEqual(["green"]);
	});

	it("a newer change supersedes a soaking run and keeps the older last green commit", () => {
		const t = startYellow(yellow(B), { commit: C, runId: "run_y2", previous: B, source: "upgrade", at });
		expect(t.state).toMatchObject({ health: "yellow", commit: C, lastGreenCommit: A, runId: "run_y2" });
		expect(t.events.map((e) => e.event)).toEqual(["superseded", "yellow"]);
		expect(t.events[0]!.runId).toBe("run_y1");
	});

	it("ignores results from a superseded run", () => {
		const s = startYellow(yellow(B), { commit: C, runId: "run_y2", previous: B, source: "upgrade", at }).state;
		expect(recordPass(s, { runId: "run_y1", pass: 3, at })).toMatchObject({ state: s, stale: true });
		expect(recordFailure(s, { runId: "run_y1", failure, revertCommit: R, at })).toMatchObject({ state: s, stale: true });
	});

	it("a failure with a revert commit rolls the fork back and keeps the last green commit", () => {
		const s = recordPass(yellow(), { runId: "run_y1", pass: 1, at }).state;
		const t = recordFailure(s, { runId: "run_y1", failure, revertCommit: R, at });
		expect(t.state).toMatchObject({ health: "rolled_back", commit: R, lastGreenCommit: A, rolledBackFrom: B, runId: null, failure });
		expect(t.events.map((e) => e.event)).toEqual(["failed", "rolled_back"]);
		expect(t.events[0]!.detail).toContain("failed at step ask");
	});

	it("a failure with nothing to roll back to stays yellow with the failure recorded", () => {
		const t = recordFailure(yellow(B, "run_y1", null), { runId: "run_y1", failure, revertCommit: null, at });
		expect(t.state).toMatchObject({ health: "yellow", runId: null, failure });
	});

	it("after a rollback the next change starts yellow from the same last green commit", () => {
		const rolled = recordFailure(yellow(), { runId: "run_y1", failure, revertCommit: R, at }).state;
		const t = startYellow(rolled, { commit: C, runId: "run_y2", previous: R, source: "customize", at });
		expect(t.state).toMatchObject({ health: "yellow", lastGreenCommit: A, failure: null, rolledBackFrom: null });
	});

	it("after a green the next change rolls back to that green", () => {
		let s = yellow();
		for (const pass of [1, 2, 3]) s = recordPass(s, { runId: "run_y1", pass, at }).state;
		expect(startYellow(s, { commit: C, runId: "run_y2", previous: B, source: "customize", at }).state.lastGreenCommit).toBe(B);
	});

	it("records the browser tier on the current run only", () => {
		const s = yellow();
		const browser = { status: "unavailable" as const, detail: "no browser binding" };
		expect(recordBrowser(s, { runId: "run_y1", browser, at }).state.browser).toEqual(browser);
		expect(recordBrowser(s, { runId: "run_other", browser, at }).stale).toBe(true);
	});

	it("cancelling the current run leaves the fork yellow with no run", () => {
		const t = cancelRun(yellow(), { runId: "run_y1", reason: "main moved", at });
		expect(t.state).toMatchObject({ health: "yellow", runId: null });
		expect(t.events[0]).toMatchObject({ event: "cancelled", detail: "main moved" });
		expect(cancelRun(t.state, { runId: "run_y0", reason: "x", at }).stale).toBe(true);
	});

	it("shows yellow and rolled back over idle statuses in the fleet grid", () => {
		expect(displayStatus("pinned", "yellow")).toBe("yellow");
		expect(displayStatus("passed", "rolled_back")).toBe("rolled_back");
		expect(displayStatus("repair_open", "rolled_back")).toBe("rolled_back");
		expect(displayStatus("upgrading", "yellow")).toBe("upgrading");
		expect(displayStatus("pinned", "green")).toBe("pinned");
	});
});

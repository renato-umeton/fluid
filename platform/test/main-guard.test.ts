import { describe, expect, it } from "vitest";
import { filterPushEvent } from "../src/events/filter.ts";
import { decideMainPush, keptBranchFor, mainMoveName } from "../src/forks/main-guard.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const ZERO = "0".repeat(40);

function mainPush(before: string, after: string) {
	return {
		type: "cf.artifacts.repo.pushed",
		source: { namespace: "fluid", repoName: "user-s-1a2b", type: "artifacts" },
		payload: { ref: "refs/heads/main", before, after, commits: [] },
	};
}

describe("filterPushEvent on main", () => {
	it("does not gate a push to main but hands it to the main guard", () => {
		const result = filterPushEvent(mainPush(A, B));
		expect(result.gate).toBe(false);
		if (result.gate) return;
		expect(result.reason).toMatch(/production branch/);
		expect(result.guard).toEqual({ repo: "user-s-1a2b", before: A, after: B });
	});

	it("hands a deleted main to the guard too", () => {
		const result = filterPushEvent(mainPush(A, ZERO));
		expect(!result.gate && result.guard).toEqual({ repo: "user-s-1a2b", before: A, after: ZERO });
	});

	it("never guards main of a repo that is not a user fork", () => {
		const event = { ...mainPush(A, B), source: { namespace: "fluid", repoName: "stock", type: "artifacts" } };
		const result = filterPushEvent(event);
		expect(!result.gate && result.guard).toBeFalsy();
	});
});

describe("decideMainPush", () => {
	const base = { before: A, after: B, granted: true, approved: false, mainNow: B };

	it("allows every push on a fork that never had an outside token", () => {
		expect(decideMainPush({ ...base, granted: false })).toMatchObject({ action: "allow" });
	});

	it("allows a move the platform approved before pushing", () => {
		expect(decideMainPush({ ...base, approved: true })).toMatchObject({ action: "allow" });
	});

	it("restores main and keeps the pushed commits on a work branch", () => {
		expect(decideMainPush(base)).toEqual({ action: "restore", to: A, keep: `work/outside-main-${B.slice(0, 7)}`, reason: expect.stringMatching(/outside the gate/) });
	});

	it("restores a deleted main with nothing to keep", () => {
		expect(decideMainPush({ ...base, after: ZERO, mainNow: null })).toMatchObject({ action: "restore", to: A, keep: null });
	});

	it("does nothing when main already moved on (a later push decides)", () => {
		expect(decideMainPush({ ...base, mainNow: C })).toMatchObject({ action: "skip", reason: expect.stringMatching(/moved on/) });
	});

	it("cannot restore when main had no earlier commit", () => {
		expect(decideMainPush({ ...base, before: ZERO })).toMatchObject({ action: "skip", reason: expect.stringMatching(/no earlier commit/) });
	});
});

describe("main move records", () => {
	it("name the repo and both ends of the move", () => {
		expect(mainMoveName("user-a", A, B)).toBe(`mainmove_user-a_${A}_${B}`);
		expect(mainMoveName("user-a", null, B)).toBe(`mainmove_user-a_${ZERO}_${B}`);
	});

	it("are different for the same commit reached from another commit", () => {
		expect(mainMoveName("user-a", A, B)).not.toBe(mainMoveName("user-a", C, B));
	});

	it("keep outside commits on a branch the gate reads", () => {
		expect(keptBranchFor(B)).toBe(`work/outside-main-${B.slice(0, 7)}`);
	});
});

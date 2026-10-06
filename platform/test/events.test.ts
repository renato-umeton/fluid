import { describe, expect, it } from "vitest";
import { filterPushEvent, gateInstanceId, gateModeFor } from "../src/events/filter.ts";

const SHA = "51e4fce944f2e5d131e3e6b7b8457ecc3a34e6a2";

function push(overrides: { namespace?: string; repoName?: string; ref?: string; after?: string; type?: string } = {}) {
	return {
		type: overrides.type ?? "cf.artifacts.repo.pushed",
		source: { namespace: overrides.namespace ?? "fluid", repoName: overrides.repoName ?? "user-s-1a2b", type: "artifacts" },
		metadata: { eventSchemaVersion: 1 },
		payload: { ref: overrides.ref ?? "refs/heads/work/redcap", before: "0".repeat(40), after: overrides.after ?? SHA, commits: [] },
	};
}

describe("filterPushEvent", () => {
	it("gates a push to a work branch of a user fork", () => {
		expect(filterPushEvent(push())).toEqual({ gate: true, trigger: { repo: "user-s-1a2b", branch: "work/redcap", commit: SHA, mode: "merge" } });
	});

	it.each([
		["another namespace", push({ namespace: "argos" }), /namespace/],
		["the stock repo", push({ repoName: "stock" }), /not a user fork/],
		["a ledger repo", push({ repoName: "ledger-s-1" }), /not a user fork/],
		["the gate's own push to main", push({ ref: "refs/heads/main" }), /production branch/],
		["a tag push", push({ ref: "refs/tags/v1.2.0" }), /tag push/],
		["an upgrade branch", push({ ref: "refs/heads/upgrade/v1.2.0" }), /Upgrade workflow/],
		["a replay branch", push({ ref: "refs/heads/replay/v1.2.0" }), /Upgrade workflow/],
		["a deleted branch", push({ after: "0".repeat(40) }), /deleted/],
		["a repair branch (the repair workflow gates it; applying it is explicit)", push({ ref: "refs/heads/repair/51e4fce" }), /repair workflow/],
		["a contest branch (the contest gates it)", push({ ref: "refs/heads/work/contest-1a2b3c4d5e6f-model-a" }), /contest/],
		["a contest import from the inbox (the contest gates it)", push({ ref: "refs/heads/work/inbox/contest-1a2b3c4d5e6f/mine" }), /contest/],
		["another event type", push({ type: "cf.artifacts.repo.created" }), /event type/],
		["garbage", null, /not an object/],
	])("ignores %s", (_label, body, reason) => {
		const result = filterPushEvent(body);
		expect(result.gate).toBe(false);
		if (!result.gate) expect(result.reason).toMatch(reason);
	});

	it("keeps repair branches in check mode when gated directly", () => {
		expect(gateModeFor("repair/51e4fce")).toBe("check");
		expect(gateModeFor("work/x")).toBe("merge");
	});
});

describe("contest branches in an inbox", () => {
	it("still imports work/contest-<id>/<name> from the inbox", () => {
		const result = filterPushEvent(push({ repoName: "inbox-user-s-1a2b", ref: "refs/heads/work/contest-1a2b3c4d5e6f/mine" }));
		expect(result.gate).toBe(false);
		if (!result.gate) expect(result.import).toEqual({ inbox: "inbox-user-s-1a2b", fork: "user-s-1a2b", branch: "work/contest-1a2b3c4d5e6f/mine", commit: SHA });
	});
});

describe("gateInstanceId", () => {
	it("is stable for the same push and distinct across branches", () => {
		const a = gateInstanceId("user-a", "work/x", SHA);
		expect(a).toBe(gateInstanceId("user-a", "work/x", SHA));
		expect(a).not.toBe(gateInstanceId("user-a", "repair/x", SHA));
		expect(a).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
	});
});

import { describe, expect, it } from "vitest";
// @ts-expect-error plain ES module from the static UI
import { mockReplayPlan } from "../public/js/mock-replay.js";

const catalog = [
	{ key: "redcap", replay: "redcap", replayReason: "REDCap connector added again" },
	{ key: "plain-wording", replay: "framing", sameLine: true, replayReason: "framing line set to this fork's wording" },
	{ key: "budget-variance" },
];
const wish = (key: string, id: string) => ({ key, record: { id, request: `request ${id}` } });

describe("mockReplayPlan", () => {
	it("replays a fork whose wishes are all replayable, and marks the one stock also changed", () => {
		const plan = mockReplayPlan([wish("redcap", "int_a"), wish("plain-wording", "int_b")], catalog, "v1.1.0");
		expect(plan).toEqual(expect.objectContaining({ tag: "v1.1.0", path: "replay", carried: 2, total: 2 }));
		expect(plan.wishes.map((w: { status: string; stockAlsoChanged: string[] }) => [w.status, w.stockAlsoChanged])).toEqual([["replayed", []], ["replayed", ["app/cards.ts"]]]);
	});

	it("merges a fork with a model change and says why", () => {
		const plan = mockReplayPlan([wish("redcap", "int_a"), wish("budget-variance", "int_c")], catalog, "v1.1.0");
		expect(plan).toEqual(expect.objectContaining({ path: "merge", carried: 0, total: 2, reason: "1 of 2 wishes can be replayed; int_c cannot, so this fork upgrades by merge" }));
		expect(plan.wishes.map((w: { status: string }) => w.status)).toEqual(["replayed", "fallback"]);
	});

	it("has nothing to say for a fork with no wishes", () => {
		expect(mockReplayPlan([], catalog, "v1.1.0")).toBeNull();
	});
});

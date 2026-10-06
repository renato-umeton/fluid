import { describe, expect, it } from "vitest";
// @ts-expect-error plain ES module from the static UI
import { baselineText, forkSummaryText, upgradePathCounts, wishesHeading } from "../public/js/fleet-summary.js";

describe("forkSummaryText", () => {
	it("describes a failed work branch as a change, not an upgrade", () => {
		const fork = { status: "repair_open", pinnedTag: "v1.5.0", lastRun: { kind: "repair", tag: null, failedBranch: "work/seed-lower-tau-47" } };
		const text = forkSummaryText(fork, "v1.9.0", true);
		expect(text).toBe("A change on work/seed-lower-tau-47 failed the gate. A repair branch is open for review; main is unchanged and stays pinned to v1.5.0.");
	});

	it("describes a failed upgrade as an upgrade to its tag", () => {
		const fork = { status: "repair_open", pinnedTag: "v1.5.0", lastRun: { kind: "repair", tag: "v1.10.0", failedBranch: "upgrade/v1.10.0" } };
		expect(forkSummaryText(fork, "v1.10.0", true)).toBe("Upgrade to v1.10.0 failed the gate. A repair branch is open for review; the fork stays pinned to v1.5.0.");
	});

	it("falls back to the latest upstream tag while an upgrade runs", () => {
		expect(forkSummaryText({ status: "upgrading", pinnedTag: "v1.5.0", lastRun: null }, "v1.10.0", false)).toBe("Upgrade agent is merging upstream v1.10.0 into upgrade/v1.10.0.");
	});
});

describe("intent replay in the fleet", () => {
	const replay = { tag: "v1.11.0", path: "replay", carried: 2, total: 2, wishes: [] };

	it("heads the wish list with the count carried to the tag", () => {
		expect(wishesHeading(replay)).toBe("Wishes carried to v1.11.0: 2 of 2");
		expect(wishesHeading({ tag: "v1.11.0", path: "merge", carried: 0, total: 3, reason: "1 of 3 wishes can be replayed", wishes: [] })).toBe("Upgrade to v1.11.0 took the merge path: 1 of 3 wishes can be replayed");
		expect(wishesHeading(null)).toBeNull();
	});

	it("says a replayed upgrade rebuilt the fork from fresh upstream code", () => {
		const fork = { status: "passed", pinnedTag: "v1.11.0", lastRun: { kind: "upgrade", tag: "v1.11.0", applied: true, path: "replay", replay } };
		expect(forkSummaryText(fork, "v1.11.0", false)).toBe("Upgrade to v1.11.0 rebuilt this fork from fresh upstream code by replaying 2 of 2 wishes. All three tiers passed and it was applied.");
		const waiting = { ...fork, lastRun: { ...fork.lastRun, applied: false } };
		expect(forkSummaryText(waiting, "v1.11.0", false)).toBe("Upgrade to v1.11.0 rebuilt this fork from fresh upstream code by replaying 2 of 2 wishes. All three tiers passed. Waiting for the user's one-tap approval (auto_upgrade is off).");
	});

	it("counts forks upgraded to a tag by replay and by merge", () => {
		const up = (tag: string, path: string | null, status = "passed") => ({ lastRun: { kind: "upgrade", tag, status, ...(path ? { path } : {}) } });
		const forks = [up("v1.11.0", "replay"), up("v1.11.0", "replay"), up("v1.11.0", "merge"), up("v1.11.0", null), up("v1.10.0", "replay"), up("v1.11.0", "replay", "gating"), { lastRun: null }];
		expect(upgradePathCounts(forks, "v1.11.0")).toEqual({ replay: 2, merge: 2 });
	});
});

describe("baselineText", () => {
	it("says nothing for a fork with no baseline", () => {
		expect(baselineText({ baseline: null })).toBeNull();
	});

	it("reports a passing baseline with its commit", () => {
		expect(baselineText({ baseline: { passed: true, commit: "abcdef1234", stockTag: "v1.5.0", at: "2026-10-04T12:00:00Z" } })).toBe("Baseline: the end-to-end suite passed on main at abcdef1 (upstream v1.5.0).");
	});

	it("flags a failing baseline without rolling anything back", () => {
		const text = baselineText({ baseline: { passed: false, commit: "abcdef1234", stockTag: "v1.5.0", failure: { tier: "platform", scenario: "platform-fork-config", step: "ui", detail: "valid equals" } } });
		expect(text).toBe("Baseline flagged: platform scenario platform-fork-config failed at step ui (valid equals) on main at abcdef1. Nothing was rolled back; review the fork.");
	});
});

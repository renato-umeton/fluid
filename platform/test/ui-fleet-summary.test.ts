import { describe, expect, it } from "vitest";
// @ts-expect-error plain ES module from the static UI
import { baselineText, forkSummaryText } from "../public/js/fleet-summary.js";

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

	it("falls back to the latest stock tag while an upgrade runs", () => {
		expect(forkSummaryText({ status: "upgrading", pinnedTag: "v1.5.0", lastRun: null }, "v1.10.0", false)).toBe("Upgrade agent is merging stock v1.10.0 into upgrade/v1.10.0.");
	});
});

describe("baselineText", () => {
	it("says nothing for a fork with no baseline", () => {
		expect(baselineText({ baseline: null })).toBeNull();
	});

	it("reports a passing baseline with its commit", () => {
		expect(baselineText({ baseline: { passed: true, commit: "abcdef1234", stockTag: "v1.5.0", at: "2026-10-04T12:00:00Z" } })).toBe("Baseline: the end-to-end suite passed on main at abcdef1 (stock v1.5.0).");
	});

	it("flags a failing baseline without rolling anything back", () => {
		const text = baselineText({ baseline: { passed: false, commit: "abcdef1234", stockTag: "v1.5.0", failure: { tier: "platform", scenario: "platform-fork-config", step: "ui", detail: "valid equals" } } });
		expect(text).toBe("Baseline flagged: platform scenario platform-fork-config failed at step ui (valid equals) on main at abcdef1. Nothing was rolled back; review the fork.");
	});
});

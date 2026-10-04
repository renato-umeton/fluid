import { describe, expect, it } from "vitest";
// @ts-expect-error plain ES module from the static UI
import { forkSummaryText } from "../public/js/fleet-summary.js";

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

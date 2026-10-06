import { describe, expect, it } from "vitest";
import { replayEnabled, upgradeInstanceId, upgradeTargets } from "../src/workflows/upgrade.ts";

const fork = (repo: string, extra: Record<string, unknown> = {}) => ({ repo, status: "pinned", pinnedTag: "v1.1.0", lastRun: null, pendingUpgrade: null, ...extra });

describe("upgradeInstanceId", () => {
	it("is the same for a tag and fork on every release run", () => {
		expect(upgradeInstanceId("v1.2.0", "user-a")).toBe(upgradeInstanceId("v1.2.0", "user-a"));
		expect(upgradeInstanceId("v1.2.0", "user-a")).not.toBe(upgradeInstanceId("v1.3.0", "user-a"));
		expect(upgradeInstanceId("v1.2.0", "user-a")).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
	});
});

describe("replayEnabled", () => {
	it("tries intent replay first unless the release turns it off", () => {
		expect(replayEnabled(undefined)).toBe(true);
		expect(replayEnabled(true)).toBe(true);
		expect(replayEnabled(false)).toBe(false);
	});
});

describe("upgradeTargets", () => {
	it("skips forks already on the tag, waiting to approve it, or already upgraded or repaired at it", () => {
		const targets = upgradeTargets("v1.2.0", [
			fork("user-new"),
			fork("user-on", { pinnedTag: "v1.2.0" }),
			fork("user-waiting", { status: "passed", pendingUpgrade: { tag: "v1.2.0" } }),
			fork("user-repair", { status: "repair_open", lastRun: { kind: "repair", tag: "v1.2.0" } }),
			fork("user-older-repair", { status: "repair_open", lastRun: { kind: "repair", tag: "v1.1.0" } }),
			fork("user-prov", { status: "provisioning" }),
		]);
		expect(targets).toEqual(["user-new", "user-older-repair"]);
	});
});

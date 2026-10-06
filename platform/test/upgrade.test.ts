import { describe, expect, it } from "vitest";
import { replayEnabled, replayFirst, upgradeInstanceId, upgradeTargets } from "../src/workflows/upgrade.ts";

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

describe("replayFirst", () => {
	const summary = { tag: "v1.2.0", path: "replay" as const, carried: 1, total: 1, wishes: [] };
	const used = { used: true as const, branch: "replay/v1.2.0", commit: "c".repeat(40), autoUpgrade: true, summary };
	function deps(land: () => Promise<{ passed: true; outcome: "applied" | "ready" } | { passed: false; why: string }>, attempt: () => Promise<unknown> = async () => used) {
		const calls: string[] = [];
		return {
			calls,
			deps: {
				attempt: attempt as never,
				land: async () => {
					calls.push("land");
					return land();
				},
				fallback: async (_a: unknown, why: string) => {
					calls.push(`fallback: ${why}`);
					return { ...summary, path: "merge" as const, carried: 0, reason: why };
				},
				merge: async (s: { reason?: string } | null) => {
					calls.push(`merge: ${s?.reason ?? "none"}`);
					return { repo: "user-a", outcome: "pinned" };
				},
			},
		};
	}

	it("lands a replay that passes and never merges", async () => {
		const t = deps(async () => ({ passed: true, outcome: "applied" }));
		expect(await replayFirst(t.deps)).toEqual({ outcome: "applied", path: "replay" });
		expect(t.calls).toEqual(["land"]);
	});

	it("falls back to the merge path when the replay gate fails, or the attempt stops (main moved, a step gave up)", async () => {
		for (const why of ["Tier 1: inv-x failed", "the replay attempt stopped: main kept moving during the upgrade"]) {
			const t = deps(async () => ({ passed: false, why }));
			expect(await replayFirst(t.deps)).toEqual({ repo: "user-a", outcome: "pinned" });
			expect(t.calls).toEqual(["land", `fallback: ${why}`, `merge: ${why}`]);
		}
	});

	it("merges straight away when replay did not apply", async () => {
		const t = deps(async () => ({ passed: true, outcome: "applied" }), async () => ({ used: false, summary: { ...summary, path: "merge", reason: "model change" } }));
		await replayFirst(t.deps);
		expect(t.calls).toEqual(["merge: model change"]);
	});

	it("does not merge on top of a replay that already landed and then failed", async () => {
		const t = deps(async () => {
			throw new Error("yellow start failed");
		});
		await expect(replayFirst(t.deps)).rejects.toThrow("yellow start failed");
		expect(t.calls).toEqual(["land"]);
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

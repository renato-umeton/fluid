import { describe, expect, it } from "vitest";
import { GATE_STEP, GIT_STEP } from "../src/workflows/common.ts";
import { attemptReplay, FAN_OUT, replayEnabled, replayFirst, upgradeInstanceId, upgradeTargets } from "../src/workflows/upgrade.ts";

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

// The v1.12.0 rehearsal saw Artifacts return 500s for about 30 seconds while
// 211 upgrades started. Every git or gate step in the upgrade must keep
// retrying well past such a burst before it gives up.
describe("retry budgets for the upgrade fan-out", () => {
	function totalWaitSeconds(config: { retries: { limit: number; delay: string; backoff: string } }): number {
		const delay = Number(/^(\d+) seconds?$/.exec(config.retries.delay)![1]);
		let total = 0;
		for (let attempt = 0; attempt < config.retries.limit; attempt++) total += config.retries.backoff === "exponential" ? delay * 2 ** attempt : delay;
		return total;
	}

	it("gives git steps more than a minute of retries", () => {
		expect(totalWaitSeconds(GIT_STEP)).toBeGreaterThan(60);
	});

	it("gives gate steps more than a minute of retries", () => {
		expect(totalWaitSeconds(GATE_STEP)).toBeGreaterThan(60);
	});

	it("pauses at least two seconds between batches of new upgrades", () => {
		expect(Number(/^(\d+) seconds?$/.exec(FAN_OUT.pause)![1])).toBeGreaterThanOrEqual(2);
	});
});

describe("attemptReplay", () => {
	const used = { used: true as const, branch: "replay/v1.2.0", commit: "c".repeat(40), autoUpgrade: true, summary: { tag: "v1.2.0", path: "replay" as const, carried: 1, total: 1, wishes: [] } };

	// A workflow step that runs its callback again on a throw, up to its retry limit, as the runtime does.
	function retryingStep() {
		const names: string[] = [];
		const tries: Record<string, number> = {};
		const step = {
			do: async (name: string, ...rest: unknown[]) => {
				names.push(name);
				const run = rest.at(-1) as () => Promise<unknown>;
				const config = rest.length > 1 ? (rest[0] as { retries?: { limit: number } }) : {};
				const limit = config.retries?.limit ?? 0;
				for (let attempt = 0; ; attempt++) {
					tries[name] = (tries[name] ?? 0) + 1;
					try {
						return await run();
					} catch (error) {
						if (attempt >= limit) throw error;
					}
				}
			},
			sleep: async () => undefined,
			waitForEvent: async () => ({ payload: null, type: "" }),
		};
		return { step: step as never, names, tries };
	}

	it("retries a transient error inside the replay step and uses the replay", async () => {
		const t = retryingStep();
		let calls = 0;
		const logged: string[] = [];
		const result = await attemptReplay(
			t.step,
			async () => {
				calls++;
				if (calls === 1) throw new Error("HTTP Error: 500 Internal Server Error");
				return used;
			},
			async (reason) => {
				logged.push(reason);
			},
		);
		expect(result).toEqual(used);
		expect(t.tries["replay wishes"]).toBe(2);
		expect(logged).toEqual([]);
		expect(t.names).toEqual(["replay wishes"]);
	});

	it("falls back to merge with the reason logged once the replay step gives up after its retries", async () => {
		const t = retryingStep();
		const logged: string[] = [];
		const result = await attemptReplay(
			t.step,
			async () => {
				throw new Error("HTTP Error: 500 Internal Server Error");
			},
			async (reason) => {
				logged.push(reason);
			},
		);
		expect(result).toEqual({ used: false, summary: null });
		expect(t.tries["replay wishes"]).toBe(GIT_STEP.retries.limit + 1);
		expect(logged).toEqual(["HTTP Error: 500 Internal Server Error"]);
		expect(t.names).toEqual(["replay wishes", "replay could not run"]);
	});

	it("returns a replay that does not apply from inside the step, without retrying or logging a failure", async () => {
		const t = retryingStep();
		const logged: string[] = [];
		const notApplicable = { used: false as const, summary: null };
		const result = await attemptReplay(
			t.step,
			async () => notApplicable,
			async (reason) => {
				logged.push(reason);
			},
		);
		expect(result).toEqual(notApplicable);
		expect(t.tries["replay wishes"]).toBe(1);
		expect(logged).toEqual([]);
	});
});

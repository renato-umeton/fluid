import { describe, expect, it, vi } from "vitest";
import { Fleet, FLEET_STREAM_LIMITS } from "../src/durable/fleet.ts";
import { UserLedger, LEDGER_COMMIT_INTERVAL_MS } from "../src/durable/user-ledger.ts";
import { construct } from "./helpers/durable.ts";

const fork = (repo: string, userId = repo.replace(/^user-/, "")) => ({ repo, userId, persona: "p", pinnedTag: "v1.1.0" });

describe("Fleet.count", () => {
	it("leaves out forks whose provisioning failed", () => {
		const { instance: fleet } = construct(Fleet);
		fleet.register({ ...fork("user-a"), status: "pinned" });
		fleet.register({ ...fork("user-b"), status: "failed" });
		expect(fleet.count()).toBe(1);
	});
});

describe("Fleet.claimProvisioning", () => {
	it("claims a new fork", () => {
		const { instance: fleet } = construct(Fleet);
		expect(fleet.claimProvisioning({ ...fork("user-a"), maxTotal: 10 }).outcome).toBe("claimed");
	});

	it("refuses a second claim while the first is provisioning", () => {
		const { instance: fleet } = construct(Fleet);
		fleet.claimProvisioning({ ...fork("user-a"), maxTotal: 10 });
		expect(fleet.claimProvisioning({ ...fork("user-a"), maxTotal: 10 }).outcome).toBe("busy");
	});

	it("lets a workflow retry resume its own provisioning", () => {
		const { instance: fleet } = construct(Fleet);
		fleet.claimProvisioning({ ...fork("user-a") });
		expect(fleet.claimProvisioning({ ...fork("user-a"), resume: true }).outcome).toBe("claimed");
	});

	it("takes over a provisioning claim that went stale", () => {
		const { instance: fleet } = construct(Fleet);
		const t0 = Date.parse("2026-10-03T10:00:00Z");
		fleet.claimProvisioning({ ...fork("user-a") }, t0);
		expect(fleet.claimProvisioning({ ...fork("user-a") }, t0 + 11 * 60_000).outcome).toBe("claimed");
	});

	it("reports an existing fork instead of claiming it", () => {
		const { instance: fleet } = construct(Fleet);
		fleet.register({ ...fork("user-a"), status: "pinned" });
		expect(fleet.claimProvisioning({ ...fork("user-a"), maxTotal: 10 }).outcome).toBe("exists");
	});

	it("retries a fork whose provisioning failed", () => {
		const { instance: fleet } = construct(Fleet);
		fleet.register({ ...fork("user-a"), status: "failed" });
		expect(fleet.claimProvisioning({ ...fork("user-a"), maxTotal: 10 }).outcome).toBe("claimed");
	});

	it("refuses a new fork when the fleet is full", () => {
		const { instance: fleet } = construct(Fleet);
		fleet.claimProvisioning({ ...fork("user-a"), maxTotal: 2 });
		fleet.claimProvisioning({ ...fork("user-b"), maxTotal: 2 });
		expect(fleet.claimProvisioning({ ...fork("user-c"), maxTotal: 2 }).outcome).toBe("full");
	});

	it("does not count failed forks toward the cap", () => {
		const { instance: fleet } = construct(Fleet);
		fleet.register({ ...fork("user-a"), status: "failed" });
		fleet.register({ ...fork("user-b"), status: "failed" });
		expect(fleet.claimProvisioning({ ...fork("user-c"), maxTotal: 2 }).outcome).toBe("claimed");
	});
});

describe("Fleet stream", () => {
	const open = (fleet: Fleet, client: string) => fleet.fetch(new Request("https://fleet/stream", { headers: { "x-fluid-client": client } }));

	it("serves a subscriber", async () => {
		const { instance: fleet } = construct(Fleet);
		expect((await open(fleet, "1.2.3.4")).status).toBe(200);
	});

	it("limits subscribers per client", async () => {
		const { instance: fleet } = construct(Fleet);
		for (let i = 0; i < FLEET_STREAM_LIMITS.perClient; i++) await open(fleet, "1.2.3.4");
		expect((await open(fleet, "1.2.3.4")).status).toBe(429);
	});

	it("limits subscribers overall", async () => {
		const { instance: fleet } = construct(Fleet);
		for (let i = 0; i < FLEET_STREAM_LIMITS.total; i++) await open(fleet, `10.0.0.${i}`);
		expect((await open(fleet, "10.1.0.1")).status).toBe(503);
	});

	it("drops a subscriber that stops reading", async () => {
		const { instance: fleet } = construct(Fleet);
		await open(fleet, "1.2.3.4");
		for (let i = 0; i < 2000; i++) fleet.register({ ...fork(`user-x${i % 50}`), status: "pinned" });
		await new Promise((r) => setTimeout(r, 0));
		expect(fleet.subscriberCount()).toBe(0);
	});

	it("keeps a subscriber that reads", async () => {
		const { instance: fleet } = construct(Fleet);
		const res = await open(fleet, "1.2.3.4");
		const reader = res.body!.getReader();
		let reading = true;
		const drain = (async () => {
			while (reading) if ((await reader.read()).done) break;
		})();
		for (let i = 0; i < 2000; i++) {
			fleet.register({ ...fork(`user-x${i % 50}`), status: "pinned" });
			if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
		}
		expect(fleet.subscriberCount()).toBe(1);
		reading = false;
		void drain;
	});
});

function ledgerEnv(options: { hasFork: boolean }) {
	const create = vi.fn(async () => {
		throw new Error("should not create a ledger repo");
	});
	const fleet = { forksOfUser: async () => (options.hasFork ? [fork("user-u1", "u1")] : []) };
	return {
		create,
		env: {
			ARTIFACTS: { create, get: async () => Promise.reject(Object.assign(new Error("not found"), { code: "NOT_FOUND" })) },
			FLEET: { idFromName: (name: string) => name, get: () => fleet },
		},
	};
}

const record = (id: string) => ({ answer_id: id, intent: "research", confidence: 0.9, signals: [], override: null, attestation: null, sources: [], fork_commit: "x", stock_tag: "v1.1.0" });

describe("UserLedger", () => {
	it("does not create a ledger repo for a user without a fork", async () => {
		const { env, create } = ledgerEnv({ hasFork: false });
		const { instance: ledger } = construct(UserLedger, env);
		await ledger.append("u1", "stock", record("a1"));
		const result = await ledger.commitPending();
		expect({ commit: result.commit, created: create.mock.calls.length }).toEqual({ commit: null, created: 0 });
	});

	it("stops the daily alarm when the user has no fork", async () => {
		const { env } = ledgerEnv({ hasFork: false });
		const { instance: ledger, state } = construct(UserLedger, env);
		await ledger.append("u1", "stock", record("a1"));
		state.alarmAt = null;
		await ledger.alarm();
		expect(state.alarmAt).toBeNull();
	});

	it("stops the daily alarm when nothing is waiting to be committed", async () => {
		const { env } = ledgerEnv({ hasFork: true });
		const { instance: ledger, state } = construct(UserLedger, env);
		await ledger.alarm();
		expect(state.alarmAt).toBeNull();
	});

	it("names the question an answer belongs to, following a re-ask to its first answer", async () => {
		const { env } = ledgerEnv({ hasFork: true });
		const { instance: ledger } = construct(UserLedger, env);
		await ledger.append("u1", "user-u1", record("a1"));
		await ledger.append("u1", "user-u1", { ...record("a2"), reask_of: "a1" });
		expect([ledger.questionOf("a1"), ledger.questionOf("a2"), ledger.questionOf("nope")]).toEqual(["a1", "a1", null]);
	});

	it("schedules the first commit when a record arrives", async () => {
		const { env } = ledgerEnv({ hasFork: true });
		const { instance: ledger, state } = construct(UserLedger, env);
		const before = Date.now();
		await ledger.append("u1", "user-u1", record("a1"));
		expect(state.alarmAt).toBeGreaterThanOrEqual(before + LEDGER_COMMIT_INTERVAL_MS);
	});
});

describe("Fleet pending upgrades", () => {
	it("keeps a waiting one-tap upgrade apart from lastRun", () => {
		const { instance: fleet } = construct(Fleet);
		fleet.register({ ...fork("user-a"), status: "pinned" });
		fleet.update("user-a", { status: "passed", pendingUpgrade: { tag: "v1.2.0", commit: "c".repeat(40), runId: "run_u" } });
		fleet.update("user-a", { lastRun: { runId: "run_g", kind: "gate", status: "passed", at: "now" } });
		expect(fleet.get("user-a")?.pendingUpgrade).toEqual({ tag: "v1.2.0", commit: "c".repeat(40), runId: "run_u" });
		fleet.update("user-a", { pendingUpgrade: null, pinnedTag: "v1.2.0" });
		expect(fleet.get("user-a")?.pendingUpgrade).toBeNull();
	});
});

describe("Fleet.safetyFallback", () => {
	const t0 = Date.parse("2026-10-03T00:00:00Z");
	const day = 86_400_000;
	const safety = (tag: string, graceUntil: string) => ({ tag, notes: "", safety: true, date: "2026-10-01T00:00:00.000Z", graceDays: 14, graceUntil, commit: null });

	function fleetWith(pinnedTag: string) {
		const { instance: fleet } = construct(Fleet);
		fleet.register({ ...fork("user-a"), pinnedTag, status: "repair_open" });
		fleet.addRelease(safety("v1.3.0", new Date(t0 + 2 * day).toISOString()));
		return fleet;
	}

	it("serves the fork itself during the grace period", () => {
		expect(fleetWith("v1.2.0").safetyFallback("user-a", t0)).toBeNull();
	});

	it("serves stock at the safety tag once the grace period is over and the fork is still pinned below it", () => {
		expect(fleetWith("v1.2.0").safetyFallback("user-a", t0 + 3 * day)).toEqual({ tag: "v1.3.0", from: "v1.2.0", graceUntil: new Date(t0 + 2 * day).toISOString() });
	});

	it("does not fall back for a fork already on the safety tag", () => {
		expect(fleetWith("v1.3.0").safetyFallback("user-a", t0 + 3 * day)).toBeNull();
	});

	it("does not fall back when an upgrade to the safety tag passed and only waits for approval", () => {
		const fleet = fleetWith("v1.2.0");
		fleet.update("user-a", { pendingUpgrade: { tag: "v1.3.0", commit: "c".repeat(40), runId: "run_u" } });
		expect(fleet.safetyFallback("user-a", t0 + 3 * day)).toBeNull();
	});

	it("ignores feature releases and unknown forks", () => {
		const fleet = fleetWith("v1.2.0");
		fleet.addRelease({ tag: "v1.4.0", notes: "", safety: false, date: "", graceDays: null, graceUntil: null, commit: null });
		expect(fleet.safetyFallback("user-a", t0 + 3 * day)?.tag).toBe("v1.3.0");
		expect(fleet.safetyFallback("user-zz", t0 + 3 * day)).toBeNull();
	});
});

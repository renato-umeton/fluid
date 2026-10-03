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

	it("schedules the first commit when a record arrives", async () => {
		const { env } = ledgerEnv({ hasFork: true });
		const { instance: ledger, state } = construct(UserLedger, env);
		const before = Date.now();
		await ledger.append("u1", "user-u1", record("a1"));
		expect(state.alarmAt).toBeGreaterThanOrEqual(before + LEDGER_COMMIT_INTERVAL_MS);
	});
});

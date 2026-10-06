import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { INBOX_GRACE_MS, inboxCleanupDelayMs, inboxCleanupDue, outsideGrantKey, type OutsideGrant } from "../src/forks/outside.ts";
import { InboxCleanupWorkflow } from "../src/workflows/inbox-cleanup.ts";
import { apiEnv, post, workerContext } from "./helpers/api-env.ts";

const grant = (over: Partial<OutsideGrant> = {}): OutsideGrant => ({ repo: "user-a", inbox: "inbox-user-a", userId: "a", tokenId: "tok_1", firstAt: "", mintedAt: "", expiresAt: "2026-10-06T13:00:00.000Z", ...over });

describe("inbox expiry", () => {
	it("deletes the inbox only while the token it was scheduled for is still the live one", () => {
		expect(inboxCleanupDue(grant(), { inbox: "inbox-user-a", tokenId: "tok_1" })).toBe(true);
		expect(inboxCleanupDue(grant({ tokenId: "tok_2" }), { inbox: "inbox-user-a", tokenId: "tok_1" })).toBe(false);
		expect(inboxCleanupDue(null, { inbox: "inbox-user-a", tokenId: "tok_1" })).toBe(false);
	});

	it("waits until the token expired plus a grace period for the last import", () => {
		const expires = Date.parse("2026-10-06T13:00:00.000Z");
		expect(inboxCleanupDelayMs("2026-10-06T13:00:00.000Z", expires - 60_000)).toBe(60_000 + INBOX_GRACE_MS);
		expect(inboxCleanupDelayMs("2026-10-06T13:00:00.000Z", expires + 10 * INBOX_GRACE_MS)).toBe(0);
	});
});

describe("fork deletion removes the inbox and its grant", () => {
	it("in the admin delete route", async () => {
		const t = apiEnv();
		t.artifacts.add("user-a");
		t.artifacts.add("inbox-user-a");
		t.fleet.register({ repo: "user-a", userId: "a", persona: "p", pinnedTag: "v1" });
		t.fleet.setValue(outsideGrantKey("user-a"), grant() as never);
		const res = await worker.fetch(post("/api/admin/forks/user-a/delete", { "x-fluid-admin": "admin-token" }), t.env, workerContext().ctx);
		expect(await res.json()).toMatchObject({ deleted: true, inboxDeleted: true });
		expect(t.artifacts.repos.has("inbox-user-a")).toBe(false);
		expect(t.fleet.getValue(outsideGrantKey("user-a"))).toBeNull();
	});

	it("in the cleanup of seeded forks", async () => {
		const t = apiEnv();
		const repo = "user-seed-abc123-1";
		t.artifacts.add(repo);
		t.artifacts.add(`inbox-${repo}`);
		t.fleet.register({ repo, userId: "seed-abc123-1", persona: "p", pinnedTag: "v1", seeded: true });
		t.fleet.setValue(outsideGrantKey(repo), grant({ repo, inbox: `inbox-${repo}` }) as never);
		const res = await worker.fetch(post("/api/admin/fleet/cleanup", { "x-fluid-admin": "admin-token" }), t.env, workerContext().ctx);
		expect(await res.json()).toMatchObject({ deleted: 1 });
		expect(t.artifacts.repos.has(`inbox-${repo}`)).toBe(false);
		expect(t.fleet.getValue(outsideGrantKey(repo))).toBeNull();
	});
});

describe("InboxCleanupWorkflow", () => {
	function run(t: ReturnType<typeof apiEnv>) {
		const workflow = new InboxCleanupWorkflow();
		(workflow as unknown as { env: Env }).env = t.env;
		const step = { sleep: async () => undefined, do: async (_name: string, ...rest: unknown[]) => (rest.at(-1) as () => Promise<unknown>)() };
		return workflow.run({ payload: { fork: "user-a", inbox: "inbox-user-a", tokenId: "tok_1", expiresAt: "2026-10-06T13:00:00.000Z" }, timestamp: new Date() } as never, step as never);
	}

	it("deletes the inbox and grant, and releases its lease", async () => {
		const t = apiEnv();
		t.artifacts.add("inbox-user-a");
		t.fleet.setValue(outsideGrantKey("user-a"), grant() as never);
		expect(await run(t)).toEqual({ deleted: true });
		expect(t.artifacts.repos.has("inbox-user-a")).toBe(false);
		expect(t.fleet.getValue(`lock:${outsideGrantKey("user-a")}`)).toBeNull();
	});

	it("leaves a lease that another holder took after its own expired", async () => {
		const t = apiEnv();
		const lock = `lock:${outsideGrantKey("user-a")}`;
		t.artifacts.add("inbox-user-a");
		t.fleet.setValue(outsideGrantKey("user-a"), grant() as never);
		const remove = t.artifacts.binding.delete;
		t.artifacts.binding.delete = async (name: string) => {
			t.fleet.setValue(lock, { until: 0, owner: "expired" } as never);
			expect(t.fleet.tryLock(lock, 30_000, "minting")).toBe(true);
			return remove(name);
		};
		await run(t);
		expect(t.fleet.getValue(lock)).toMatchObject({ owner: "minting" });
	});
});

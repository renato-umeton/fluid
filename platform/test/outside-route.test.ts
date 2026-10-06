import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { inboxRepoName, outsideGrantKey } from "../src/forks/outside.ts";
import { apiEnv, cookieFor, post, workerContext } from "./helpers/api-env.ts";

const USER = "s-1a2b";
const FORK = `user-${USER}`;
const INBOX = `inbox-${FORK}`;
const ctx = workerContext().ctx;

async function setup() {
	const t = apiEnv();
	t.artifacts.add(FORK);
	t.fleet.register({ repo: FORK, userId: USER, persona: "hospitalist-researcher", pinnedTag: "v1.10.0", status: "pinned" });
	return t;
}

async function mint(t: Awaited<ReturnType<typeof setup>>, headers: Record<string, string>, repo = FORK) {
	return worker.fetch(post(`/api/forks/${repo}/token`, headers), t.env, ctx);
}

describe("POST /api/forks/:repo/token", () => {
	let logs: string[];
	beforeEach(() => {
		logs = [];
		vi.spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));
		vi.spyOn(console, "error").mockImplementation((...args) => void logs.push(args.join(" ")));
		vi.spyOn(console, "warn").mockImplementation((...args) => void logs.push(args.join(" ")));
	});

	it("creates the inbox as a fork of the user's fork and scopes the token to the inbox only", async () => {
		const t = await setup();
		const res = await mint(t, { cookie: await cookieFor({ userId: USER }) });
		expect(res.status).toBe(201);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ repo: FORK, inbox: INBOX, remote: `https://acct.artifacts.cloudflare.net/git/fluid/${INBOX}.git`, branchPrefix: "work/" });
		expect(t.artifacts.repos.get(INBOX)!.forkedFrom).toBe(FORK);
		expect(t.artifacts.repos.get(INBOX)!.tokens).toEqual([{ id: `tok_${INBOX}_1`, scope: "write", ttl: 3600, revoked: false }]);
		expect(t.artifacts.repos.get(FORK)!.tokens).toEqual([]);
		expect(t.fleet.getValue(outsideGrantKey(FORK))).toMatchObject({ repo: FORK, inbox: INBOX, tokenId: `tok_${INBOX}_1` });
	});

	it("never logs the token", async () => {
		const t = await setup();
		const body = (await (await mint(t, { cookie: await cookieFor({ userId: USER }) })).json()) as { token: string };
		expect(logs.join("\n")).not.toContain(body.token.split("?")[0]);
	});

	it("replaces the inbox with a fresh fork of the fork's main on the next request, which ends the old token", async () => {
		const t = await setup();
		const cookie = await cookieFor({ userId: USER });
		await mint(t, { cookie });
		t.artifacts.repos.get(INBOX)!.tokens[0]!.scope = "old inbox";
		expect((await mint(t, { cookie })).status).toBe(201);
		expect(t.artifacts.deleted).toEqual([INBOX]);
		expect(t.artifacts.repos.get(INBOX)!.forkedFrom).toBe(FORK);
		expect(t.artifacts.repos.get(INBOX)!.tokens).toEqual([{ id: `tok_${INBOX}_1`, scope: "write", ttl: 3600, revoked: false }]);
	});

	it("revokes the previous token on the old inbox before deleting it", async () => {
		const t = await setup();
		const cookie = await cookieFor({ userId: USER });
		await mint(t, { cookie });
		const old = t.artifacts.repos.get(INBOX)!;
		const revokedAtDelete: boolean[] = [];
		const remove = t.artifacts.binding.delete;
		t.artifacts.binding.delete = async (name: string) => (revokedAtDelete.push(old.tokens[0]!.revoked), remove(name));
		expect((await mint(t, { cookie })).status).toBe(201);
		expect(revokedAtDelete).toEqual([true]);
		expect(t.artifacts.repos.get(INBOX)).not.toBe(old);
	});

	it("still replaces the inbox when the previous token cannot be revoked", async () => {
		const t = await setup();
		const cookie = await cookieFor({ userId: USER });
		await mint(t, { cookie });
		t.artifacts.repos.get(INBOX)!.revokeResult = false;
		expect((await mint(t, { cookie })).status).toBe(201);
		expect(t.artifacts.deleted).toEqual([INBOX]);
		expect(logs.join("\n")).toMatch(/previous outside token .* not revoked/);
	});

	it("mints when the grant names an inbox that no longer exists", async () => {
		const t = await setup();
		t.fleet.setValue(outsideGrantKey(FORK), { repo: FORK, inbox: INBOX, userId: USER, tokenId: "tok_gone", firstAt: "", mintedAt: "", expiresAt: null } as never);
		expect((await mint(t, { cookie: await cookieFor({ userId: USER }) })).status).toBe(201);
		expect(t.artifacts.repos.get(INBOX)!.forkedFrom).toBe(FORK);
	});

	it("schedules the inbox's deletion after the token expires", async () => {
		const t = await setup();
		const { created, ctx: withExports } = workerContext();
		await worker.fetch(post(`/api/forks/${FORK}/token`, { cookie: await cookieFor({ userId: USER }) }), t.env, withExports);
		expect(created).toEqual([{ workflow: "InboxCleanupWorkflow", id: expect.stringMatching(/^inboxgc-/), params: { fork: FORK, inbox: INBOX, tokenId: `tok_${INBOX}_1`, expiresAt: "2026-10-06T13:00:00.000Z" } }]);
	});

	it("refuses without a session", async () => {
		const t = await setup();
		expect((await mint(t, {})).status).toBe(401);
	});

	it("refuses another user's fork", async () => {
		const t = await setup();
		const res = await mint(t, { cookie: await cookieFor({ userId: "s-other" }) });
		expect(res.status).toBe(403);
		expect(t.artifacts.repos.has(INBOX)).toBe(false);
	});

	it("refuses a yellow run's test session", async () => {
		const t = await setup();
		const res = await mint(t, { cookie: await cookieFor({ userId: "e2e-run", e2e: { repo: FORK, runId: "run_1", exp: Date.now() + 60_000 } }) });
		expect(res.status).toBe(403);
	});

	it("refuses the admin header without the owner's session", async () => {
		const t = await setup();
		expect((await mint(t, { "x-fluid-admin": "admin-token" })).status).toBe(401);
	});

	it("refuses a fork that is not in the fleet", async () => {
		const t = await setup();
		const res = await mint(t, { cookie: await cookieFor({ userId: "s-none" }) }, "user-s-none");
		expect(res.status).toBe(404);
	});

	it("limits tokens to 3 per hour per user", async () => {
		const t = await setup();
		const cookie = await cookieFor({ userId: USER });
		for (let i = 0; i < 3; i++) expect((await mint(t, { cookie })).status).toBe(201);
		const res = await mint(t, { cookie });
		expect(res.status).toBe(429);
		expect(res.headers.get("retry-after")).toBeTruthy();
	});

	it("refuses while another request for the same fork is minting", async () => {
		const t = await setup();
		expect(t.fleet.tryLock(`lock:${outsideGrantKey(FORK)}`, 30_000, "other")).toBe(true);
		const res = await mint(t, { cookie: await cookieFor({ userId: USER }) });
		expect(res.status).toBe(409);
		expect(t.artifacts.repos.has(INBOX)).toBe(false);
	});
});

describe("inbox names", () => {
	it("prefix the fork name and stay valid repo names", () => {
		expect(inboxRepoName(FORK)).toBe(INBOX);
		expect(inboxRepoName(`user-${"a".repeat(48)}`)).toMatch(/^inbox-user-a{48}$/);
	});
});

describe("Fleet locks", () => {
	it("let one holder in until released or expired", async () => {
		const { fleet } = apiEnv();
		expect(fleet.tryLock("lock:x", 1000, "a", 0)).toBe(true);
		expect(fleet.tryLock("lock:x", 1000, "b", 500)).toBe(false);
		expect(fleet.tryLock("lock:x", 1000, "b", 1001)).toBe(true);
		expect(fleet.unlock("lock:x", "b")).toBe(true);
		expect(fleet.tryLock("lock:x", 1000, "c", 1002)).toBe(true);
	});

	it("are released only by their owner, so a late unlock after expiry leaves the next holder's lease", async () => {
		const { fleet } = apiEnv();
		expect(fleet.tryLock("lock:x", 1000, "slow", 0)).toBe(true);
		expect(fleet.tryLock("lock:x", 1000, "next", 1001)).toBe(true);
		expect(fleet.unlock("lock:x", "slow")).toBe(false);
		expect(fleet.tryLock("lock:x", 1000, "third", 1500)).toBe(false);
		expect(fleet.unlock("lock:x", "next")).toBe(true);
		expect(fleet.tryLock("lock:x", 1000, "third", 1500)).toBe(true);
	});
});

describe("the mint lease", () => {
	it("is not released by a mint whose lease expired and was taken over meanwhile", async () => {
		const t = await setup();
		const lock = `lock:${outsideGrantKey(FORK)}`;
		const fork = t.artifacts.binding.get;
		// While the mint works, its lease expires and another holder takes it.
		t.artifacts.binding.get = async (name: string) => {
			if (name === FORK) {
				t.fleet.setValue(lock, { until: 0, owner: "expired" } as never);
				expect(t.fleet.tryLock(lock, 30_000, "next")).toBe(true);
			}
			return fork(name);
		};
		expect((await mint(t, { cookie: await cookieFor({ userId: USER }) })).status).toBe(409);
		expect(t.fleet.getValue(lock)).toMatchObject({ owner: "next" });
	});

	it("writes no grant when the lease was taken over, revokes its own token, and leaves the inbox to the new holder", async () => {
		const t = await setup();
		const lock = `lock:${outsideGrantKey(FORK)}`;
		const get = t.artifacts.binding.get;
		t.artifacts.binding.get = async (name: string) => {
			const handle = await get(name);
			if (name !== INBOX) return handle;
			return { ...handle, createToken: async (scope: string, ttl: number) => {
				const token = await handle.createToken(scope, ttl);
				// While this mint creates its token, its lease expires and another request takes it.
				t.fleet.setValue(lock, { until: 0, owner: "expired" } as never);
				expect(t.fleet.tryLock(lock, 30_000, "next")).toBe(true);
				return token;
			} };
		};
		const res = await mint(t, { cookie: await cookieFor({ userId: USER }) });
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toMatch(/another token request/);
		expect(t.fleet.getValue(outsideGrantKey(FORK))).toBeNull();
		expect(t.artifacts.repos.get(INBOX)!.tokens[0]!.revoked).toBe(true);
		expect(t.artifacts.repos.has(INBOX)).toBe(true);
	});

	it("deletes the fresh inbox when the lease is gone and nobody else holds it", async () => {
		const t = await setup();
		const lock = `lock:${outsideGrantKey(FORK)}`;
		const get = t.artifacts.binding.get;
		t.artifacts.binding.get = async (name: string) => {
			const handle = await get(name);
			if (name !== INBOX) return handle;
			return { ...handle, createToken: async (scope: string, ttl: number) => {
				const token = await handle.createToken(scope, ttl);
				t.fleet.deleteValue(lock);
				return token;
			} };
		};
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect((await mint(t, { cookie: await cookieFor({ userId: USER }) })).status).toBe(409);
		expect(t.fleet.getValue(outsideGrantKey(FORK))).toBeNull();
		expect(t.artifacts.repos.has(INBOX)).toBe(false);
	});

	it("is released by the mint that holds it", async () => {
		const t = await setup();
		expect((await mint(t, { cookie: await cookieFor({ userId: USER }) })).status).toBe(201);
		expect(t.fleet.getValue(`lock:${outsideGrantKey(FORK)}`)).toBeNull();
	});
});

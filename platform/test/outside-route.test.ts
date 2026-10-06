import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { inboxRepoName, outsideGrantKey } from "../src/forks/outside.ts";
import { apiEnv, cookieFor, post } from "./helpers/api-env.ts";

const USER = "s-1a2b";
const FORK = `user-${USER}`;
const INBOX = `inbox-${FORK}`;
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

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

	it("reuses the inbox and revokes the previous token on the next request", async () => {
		const t = await setup();
		const cookie = await cookieFor({ userId: USER });
		await mint(t, { cookie });
		expect((await mint(t, { cookie })).status).toBe(201);
		expect(t.artifacts.repos.get(INBOX)!.tokens.map((x) => x.revoked)).toEqual([true, false]);
	});

	it("still answers when the previous token was already gone", async () => {
		const t = await setup();
		const cookie = await cookieFor({ userId: USER });
		await mint(t, { cookie });
		t.artifacts.repos.get(INBOX)!.revokeResult = false;
		expect((await mint(t, { cookie })).status).toBe(201);
		expect(logs.join("\n")).toMatch(/previous token .* not revoked/);
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
		expect(t.fleet.tryLock(`lock:${outsideGrantKey(FORK)}`, 30_000)).toBe(true);
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
		expect(fleet.tryLock("lock:x", 1000, 0)).toBe(true);
		expect(fleet.tryLock("lock:x", 1000, 500)).toBe(false);
		expect(fleet.tryLock("lock:x", 1000, 1001)).toBe(true);
		fleet.unlock("lock:x");
		expect(fleet.tryLock("lock:x", 1000, 1002)).toBe(true);
	});
});

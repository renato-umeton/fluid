import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { contestLockKey } from "../src/contest/plan.ts";
import { WISH_BRANCHES } from "../src/contest/read-wishes.ts";
import { runsStub } from "../src/stubs.ts";
import { apiEnv, cookieFor, post, workerContext } from "./helpers/api-env.ts";

const USER = "s-1a2b";
const FORK = `user-${USER}`;

function setup() {
	const t = apiEnv();
	t.artifacts.add(FORK);
	t.fleet.register({ repo: FORK, userId: USER, persona: "hospitalist-researcher", pinnedTag: "v1.10.0", status: "pinned" });
	return { ...t, ...workerContext() };
}

async function start(t: ReturnType<typeof setup>, body: Record<string, unknown>, user = USER) {
	return worker.fetch(post("/api/contests", { cookie: await cookieFor({ userId: user }) }, { repo: FORK, request: "Add a plain-language summary line to research answers", ...body }), t.env, t.ctx);
}

describe("POST /api/contests", () => {
	it("starts one contest run with its contestants and opens the fork's contest", async () => {
		const t = setup();
		const res = await start(t, { size: 3, includeAgent: true });
		expect(res.status).toBe(202);
		const body = (await res.json()) as { runId: string; contestId: string; agentBranch: string; joinUntil: string };
		expect(body.runId).toBe(`run_contest_${body.contestId}`);
		expect(body.agentBranch).toBe(`work/contest-${body.contestId}/my-entry`);
		expect(Date.parse(body.joinUntil)).toBeGreaterThan(Date.now());
		expect(t.created).toEqual([{ workflow: "ContestWorkflow", id: body.runId, params: expect.objectContaining({ runId: body.runId, contestId: body.contestId, repo: FORK, size: 3, includeAgent: true }) }]);
		const run = await runsStub(t.env, body.runId).get();
		expect((run!.contestants as { label: string }[]).map((c) => c.label)).toEqual(["model-a", "model-b", "agent"]);
		expect(t.fleet.contestState(FORK)).toMatchObject({ contestId: body.contestId, status: "open", includeAgent: true, agentJoined: false });
		expect(t.fleet.getValue(contestLockKey(FORK))).toMatchObject({ owner: body.runId });
	});

	it("runs one contest per fork at a time", async () => {
		const t = setup();
		expect((await start(t, {})).status).toBe(202);
		const again = await start(t, {});
		expect(again.status).toBe(409);
		expect(((await again.json()) as { error: string }).error).toMatch(/already running/);
	});

	it("refuses a size other than 2 or 3, and another user's fork", async () => {
		const t = setup();
		expect((await start(t, { size: 5 })).status).toBe(400);
		expect((await start(t, {}, "s-other")).status).toBe(403);
	});

	it("releases the fork, closes the contest, and refunds the quota when the workflow cannot start", async () => {
		const t = setup();
		const broken = { ...t, ctx: { waitUntil: () => undefined, exports: new Proxy({}, { get: () => ({ create: async () => { throw new Error("workflows unavailable"); } }) }) } as unknown as ExecutionContext };
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const res = await start(broken, { size: 3 });
		expect(res.status).toBe(500);
		expect(t.fleet.contestState(FORK)?.status).toBe("done");
		expect(t.fleet.getValue(contestLockKey(FORK))).toBeNull();
		for (let i = 0; i < 3; i++) {
			expect((await start(t, { size: 3 })).status).toBe(202);
			t.fleet.deleteValue(contestLockKey(FORK));
		}
	});

	it("counts a contest as N customizations and releases the fork when the quota refuses", async () => {
		const t = setup();
		for (let i = 0; i < 3; i++) {
			expect((await start(t, { size: 3 })).status).toBe(202);
			t.fleet.deleteValue(contestLockKey(FORK));
		}
		const refused = await start(t, { size: 2 });
		expect(refused.status).toBe(429);
		expect(((await refused.json()) as { error: string }).error).toMatch(/counts as 2 customizations/);
		expect(t.fleet.tryLock(contestLockKey(FORK), 1000, "next")).toBe(true);
	});
});

describe("GET /api/forks/:repo/wishes", () => {
	const get = (cookie?: string) => new Request(`https://fluid.test/api/forks/${FORK}/wishes`, { headers: { "cf-connecting-ip": "203.0.113.9", ...(cookie ? { cookie } : {}) } });

	function primed() {
		const t = setup();
		WISH_BRANCHES.prime(FORK, { main: "m".repeat(40), branches: [{ branch: "work/raise-tau-1a2b", head: "a".repeat(40), records: [] }], leftOut: 0, scanned: 1 });
		t.fleet.noteWish(FORK, { id: "run_customize_x", runId: "run_customize_x", kind: "customize", branch: "work/secret-plan-9f9f", intentId: "int_x", request: "Something private I am still deciding", status: "planned; waiting for your test decisions", at: new Date().toISOString() });
		return t;
	}

	it("shows branches to anyone, but the notes of runs not pushed yet only to the owner", async () => {
		const t = primed();
		const anon = (await (await worker.fetch(get(), t.env, t.ctx)).json()) as { wishes: { branch: string; request: string | null }[]; notesIncluded: boolean };
		expect(anon.notesIncluded).toBe(false);
		expect(anon.wishes.map((w) => w.branch)).toEqual(["work/raise-tau-1a2b"]);
		expect(JSON.stringify(anon)).not.toContain("Something private");
		const own = (await (await worker.fetch(get(await cookieFor({ userId: USER })), t.env, t.ctx)).json()) as { wishes: { branch: string; request: string | null }[]; notesIncluded: boolean };
		expect(own.notesIncluded).toBe(true);
		expect(own.wishes.map((w) => w.request)).toContain("Something private I am still deciding");
		const other = (await (await worker.fetch(get(await cookieFor({ userId: "s-other" })), t.env, t.ctx)).json()) as { notesIncluded: boolean };
		expect(other.notesIncluded).toBe(false);
	});
});

describe("POST /api/contests/:runId/pick", () => {
	const entrant = (label: string, over: Record<string, unknown> = {}) => ({ label, ready: true, problem: null, gatePassed: true, firstFailure: null, wishPassed: 1, wishTotal: 1, failingWish: [], outsideChanges: 0, filesChanged: 1, finishedAt: "t", ...over });

	async function waiting(t: ReturnType<typeof setup>) {
		const runId = "run_contest_1a2b3c4d5e6f";
		await runsStub(t.env, runId).create({ id: runId, kind: "contest", repo: FORK, status: "waiting", fields: { contestId: "1a2b3c4d5e6f", winner: "model-a", entrants: [entrant("model-a"), entrant("model-b", { outsideChanges: 2 }), entrant("agent", { gatePassed: false, firstFailure: "invariant: inv-x" })] } });
		return runId;
	}

	it("sends the pick to the contest and refuses a second one", async () => {
		const t = setup();
		const runId = await waiting(t);
		const cookie = await cookieFor({ userId: USER });
		const res = await worker.fetch(post(`/api/contests/${runId}/pick`, { cookie }, { label: "model-b" }), t.env, t.ctx);
		expect(res.status).toBe(200);
		expect(t.sent).toEqual([{ workflow: "ContestWorkflow", id: runId, event: { type: "contest-pick", payload: { label: "model-b" } } }]);
		expect((await worker.fetch(post(`/api/contests/${runId}/pick`, { cookie }, { label: "model-a" }), t.env, t.ctx)).status).toBe(409);
	});

	it("refuses a contestant that did not pass", async () => {
		const t = setup();
		const runId = await waiting(t);
		const res = await worker.fetch(post(`/api/contests/${runId}/pick`, { cookie: await cookieFor({ userId: USER }) }, { label: "agent" }), t.env, t.ctx);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("agent cannot ship: it failed the gate: invariant: inv-x");
		expect(t.sent).toEqual([]);
	});

	it("only the fork's owner picks", async () => {
		const t = setup();
		const runId = await waiting(t);
		expect((await worker.fetch(post(`/api/contests/${runId}/pick`, { cookie: await cookieFor({ userId: "s-other" }) }, { label: "model-a" }), t.env, t.ctx)).status).toBe(403);
	});
});

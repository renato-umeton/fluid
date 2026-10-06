import { describe, expect, it } from "vitest";
import { CONTEST_LIMITS, contestLockKey } from "../src/contest/plan.ts";
import { ContestWorkflow, releaseContest, renewContest, shipTarget } from "../src/workflows/contest.ts";
import { runsStub } from "../src/stubs.ts";
import { apiEnv, workerContext } from "./helpers/api-env.ts";

const FORK = "user-s-1a2b";
const ID = "1a2b3c4d5e6f";
const RUN = `run_contest_${ID}`;
const params = { runId: RUN, contestId: ID, repo: FORK, request: "r", userId: "s-1a2b", persona: null, size: 3, includeAgent: true };

describe("shipTarget", () => {
	const list = [
		{ label: "model-a", status: "evaluated", branch: `work/contest-${ID}-model-a`, commit: "a".repeat(40) },
		{ label: "agent", status: "evaluated", branch: `work/inbox/contest-${ID}/mine`, commit: "b".repeat(40) },
		{ label: "model-b", status: "no change" },
		{ label: "model-c", status: "checking", branch: `work/contest-${ID}-model-c`, commit: "c".repeat(40) },
	];

	it("ships a platform contestant's checked commit with source contest", () => {
		expect(shipTarget(list, "model-a")).toEqual({ ok: true, branch: `work/contest-${ID}-model-a`, commit: "a".repeat(40), source: "contest" });
	});

	it("ships the owner's agent as an import, so the merge gate drafts a missing record and opens no repair", () => {
		expect(shipTarget(list, "agent")).toMatchObject({ ok: true, commit: "b".repeat(40), source: "import" });
	});

	it("refuses a contestant with no checked commit", () => {
		expect(shipTarget(list, "model-b")).toEqual({ ok: false, error: "model-b has no checked commit to ship" });
		expect(shipTarget(list, "model-c")).toMatchObject({ ok: false });
		expect(shipTarget(list, "nobody")).toMatchObject({ ok: false });
	});
});

describe("a contest abandoned before its workflow ran", () => {
	/** Runs the workflow with a step stub that records step names and runs every step. */
	async function run(env: Env) {
		const workflow = new ContestWorkflow();
		Object.assign(workflow, { env, ctx: workerContext().ctx });
		const names: string[] = [];
		const step = { do: async (name: string, ...rest: unknown[]) => (names.push(name), (rest.at(-1) as () => Promise<unknown>)()), sleep: async () => undefined, waitForEvent: async () => { throw new Error("no event"); } };
		const output = await workflow.run({ payload: params, timestamp: new Date() } as never, step as never);
		return { output, names };
	}

	it("exits at its first step when the route already failed the run, without reopening or locking anything", async () => {
		const t = apiEnv();
		await runsStub(t.env, RUN).create({ id: RUN, kind: "contest", repo: FORK, status: "failed", fields: { contestId: ID } });
		t.fleet.openContest(FORK, { contestId: ID, runId: RUN, status: "done", includeAgent: true, joinUntil: null, agentJoined: false });
		t.fleet.tryLock(contestLockKey(FORK), CONTEST_LIMITS.lockTtlMs, "run_contest_ffffffffffff");
		const { output, names } = await run(t.env);
		expect(output).toMatchObject({ winner: null, shipped: null, abandoned: true });
		expect(names).toEqual(["check the contest is still open"]);
		expect(t.fleet.contestState(FORK)?.status).toBe("done");
		expect(t.fleet.getValue(contestLockKey(FORK))).toMatchObject({ owner: "run_contest_ffffffffffff" });
		expect((await runsStub(t.env, RUN).get())!.status).toBe("failed");
	});

	it("exits when the fork's contest is done, even if the run record still says running", async () => {
		const t = apiEnv();
		await runsStub(t.env, RUN).create({ id: RUN, kind: "contest", repo: FORK, status: "running", fields: { contestId: ID } });
		t.fleet.openContest(FORK, { contestId: ID, runId: RUN, status: "done", includeAgent: true, joinUntil: null, agentJoined: false });
		const { output, names } = await run(t.env);
		expect(output).toMatchObject({ abandoned: true });
		expect(names).toEqual(["check the contest is still open"]);
		expect(t.fleet.contestState(FORK)?.status).toBe("done");
		expect(t.fleet.getValue(contestLockKey(FORK))).toBeNull();
	});

	it("exits when the fork has moved on to another contest", async () => {
		const t = apiEnv();
		await runsStub(t.env, RUN).create({ id: RUN, kind: "contest", repo: FORK, status: "running", fields: { contestId: ID } });
		t.fleet.openContest(FORK, { contestId: "ffffffffffff", runId: "run_contest_ffffffffffff", status: "open", includeAgent: false, joinUntil: null, agentJoined: false });
		const { names } = await run(t.env);
		expect(names).toEqual(["check the contest is still open"]);
		expect(t.fleet.contestState(FORK)).toMatchObject({ contestId: "ffffffffffff", status: "open" });
	});
});

describe("contest lease on every exit path", () => {
	it("release closes the contest and frees the fork only for this run", async () => {
		const t = apiEnv();
		t.fleet.openContest(FORK, { contestId: ID, runId: RUN, status: "waiting", includeAgent: true, joinUntil: null, agentJoined: false });
		t.fleet.tryLock(contestLockKey(FORK), CONTEST_LIMITS.lockTtlMs, RUN);
		await releaseContest(t.env, params);
		expect(t.fleet.contestState(FORK)?.status).toBe("done");
		expect(t.fleet.getValue(contestLockKey(FORK))).toBeNull();
	});

	it("release leaves a newer contest's lease alone", async () => {
		const t = apiEnv();
		t.fleet.tryLock(contestLockKey(FORK), CONTEST_LIMITS.lockTtlMs, "run_contest_ffffffffffff");
		await releaseContest(t.env, params);
		expect(t.fleet.getValue(contestLockKey(FORK))).toMatchObject({ owner: "run_contest_ffffffffffff" });
	});

	it("renewing at a phase pushes the lease out by a full term", async () => {
		const t = apiEnv();
		t.fleet.tryLock(contestLockKey(FORK), 1000, RUN);
		await renewContest(t.env, params);
		expect((t.fleet.getValue(contestLockKey(FORK)) as { until: number }).until).toBeGreaterThan(Date.now() + CONTEST_LIMITS.lockTtlMs - 5000);
	});
});

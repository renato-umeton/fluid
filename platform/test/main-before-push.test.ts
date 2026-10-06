// A push to main that lands and then reports a failure is retried: the gate's
// retried merge step, or a second one-tap. main is then already at the gated
// commit, and the yellow run must start from main's head before the push (its
// rollback target for a fork with no green commit yet), not from the gated
// commit's first parent, which may be a branch commit that was never on main.
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { checkoutBranch, commitChanges, initRepo, writeFiles, type Workspace } from "../src/git/ops.ts";
import { runsStub } from "../src/stubs.ts";
import { GateWorkflow } from "../src/workflows/gate.ts";
import { apiEnv, cookieFor, post, workerContext } from "./helpers/api-env.ts";

// One in-memory repository stands in for the fork's remote; the first push to main fails after it landed.
const remote: { ws: Workspace | null; failNextPush: boolean } = { ws: null, failNextPush: false };
vi.mock("../src/git/ops.ts", async (importOriginal) => {
	const ops = await importOriginal<typeof import("../src/git/ops.ts")>();
	return {
		...ops,
		cloneRepo: async () => remote.ws!,
		fetchBranch: async () => undefined,
		pushBranch: async () => {
			if (remote.failNextPush) {
				remote.failNextPush = false;
				throw new Error("connection reset after the push");
			}
			return { ok: true };
		},
	};
});

const USER = "s-1";
const REPO = `user-${USER}`;

/** main at `before`; a branch of two commits, so the head's first parent was never on main. */
async function forkWithBranch(branch: string) {
	const ws = await initRepo();
	await writeFiles(ws, { "fluid.toml": 'stock_tag = "v1.1.0"\n' });
	const before = await commitChanges(ws, { message: "main" });
	await checkoutBranch(ws, branch, { create: true, from: "main" });
	await writeFiles(ws, { "app/a.ts": "1\n" });
	const middle = await commitChanges(ws, { message: "one" });
	await writeFiles(ws, { "app/b.ts": "2\n" });
	const head = await commitChanges(ws, { message: "two" });
	await checkoutBranch(ws, "main");
	return { ws, before, middle, head };
}

function setup() {
	const t = apiEnv();
	t.artifacts.add(REPO);
	t.fleet.register({ repo: REPO, userId: USER, persona: "hospitalist-researcher", pinnedTag: "v1.1.0", status: "pinned" });
	return t;
}

describe("the gate's merge step retried after its push to main landed", () => {
	beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => undefined));

	it("reports main's head from before the push as previous", async () => {
		const t = setup();
		const { ws, before, middle, head } = await forkWithBranch("work/x");
		remote.ws = ws;
		const runId = "run_gate_retry";
		await runsStub(t.env, runId).create({ id: runId, kind: "gate", repo: REPO, status: "running" });
		const gate = new GateWorkflow();
		Object.assign(gate, { env: t.env, ctx: workerContext().ctx });
		const advance = (gate as unknown as { advanceMain: (...a: unknown[]) => Promise<{ previous?: string | null; landed?: boolean }> }).advanceMain.bind(gate);
		const p = { repo: REPO, branch: "work/x", commit: head, mode: "merge", source: "direct" };
		remote.failNextPush = true;
		await expect(advance(p, runId, null, "direct")).rejects.toThrow(/connection reset/);
		const retried = await advance(p, runId, null, "direct");
		expect(retried).toMatchObject({ landed: true, previous: before });
		expect(retried.previous).not.toBe(middle);
	});
});

describe("a second one-tap after the first one's push landed", () => {
	beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => undefined));

	it("starts yellow with main's head from before the push as the last green commit", async () => {
		const t = setup();
		const { ws, before, head } = await forkWithBranch("upgrade/v1.2.0");
		remote.ws = ws;
		const upgradeRun = "run_upgrade_tap";
		await runsStub(t.env, upgradeRun).create({ id: upgradeRun, kind: "upgrade", repo: REPO, status: "passed" });
		t.fleet.update(REPO, { pendingUpgrade: { tag: "v1.2.0", commit: head, runId: upgradeRun, branch: "upgrade/v1.2.0" } });
		const { ctx } = workerContext();
		const cookie = await cookieFor({ userId: USER });
		remote.failNextPush = true;
		expect((await worker.fetch(post(`/api/forks/${REPO}/upgrade`, { cookie }), t.env, ctx)).status).toBe(500);
		const again = await worker.fetch(post(`/api/forks/${REPO}/upgrade`, { cookie }), t.env, ctx);
		expect(again.status).toBe(200);
		expect((await t.fleet.get(REPO))!.health).toMatchObject({ health: "yellow", commit: head, lastGreenCommit: before });
	});
});

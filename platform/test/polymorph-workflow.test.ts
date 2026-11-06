// The fluid-rotate workflow and what starts it: one fork's rotation logged as
// a run, the fleet-wide instance the schedule starts, and the helper every
// other caller starts a rotation with. Rotations run through the platform's
// own code on in-memory repos and a fake Worker Loader, so the timeouts leave
// room for a loaded machine.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import config from "../cloudflare.config.ts";
import worker from "../src/index.ts";
import * as entry from "../src/index.ts";
import { runsStub } from "../src/stubs.ts";
import { GATE_STEP, type RotateParams } from "../src/workflows/common.ts";
import { RotateWorkflow, rotationId, startRotation } from "../src/workflows/rotate.ts";
import { FAN_OUT } from "../src/workflows/upgrade.ts";
import { apiEnv, post } from "./helpers/api-env.ts";
import { POLYMORPH_TEST_SECRET, PUBLISHED, REFLECTIVE, TAG, polymorphPlatform, type PolymorphPlatform } from "./helpers/polymorph-platform.ts";
import { fakeSteps, fakeWorkflows } from "./helpers/workflows.ts";

const SLOW_MS = 120_000;
const NO_MODEL = {
	LlmHost: () => ({
		complete: async () => {
			throw new Error("these tests never use the model");
		},
	}),
};

let p: PolymorphPlatform;

beforeAll(() => {
	p = polymorphPlatform({ "user-1": PUBLISHED, "user-reflective": REFLECTIVE });
	for (const repo of Object.keys(p.heads)) p.t.fleet.register({ repo, userId: repo.replace(/^user-/, ""), persona: "p", pinnedTag: TAG, status: "pinned" });
});

afterAll(() => p?.cleanup());

afterEach(() => {
	vi.restoreAllMocks();
});

/** Runs one RotateWorkflow instance to its end; a scheduled instance has no payload. */
async function runRotate(env: Env, payload: RotateParams | undefined, instanceId = "rot-test", workflows = fakeWorkflows(NO_MODEL)) {
	const workflow = Object.assign(new RotateWorkflow(), { env, ctx: workflows.ctx });
	const steps = fakeSteps();
	const event = { payload, timestamp: new Date(), instanceId, workflowName: "fluid-rotate", ...(payload === undefined ? { schedule: { cron: "0 */6 * * *", scheduledTime: Date.now() } } : {}) };
	const output = await workflow.run(event as never, steps.step as never);
	return { output, workflows, steps };
}

describe("RotateWorkflow with a repo", () => {
	it(
		"rotates that fork in one step that retries like a gate, and logs the run",
		async () => {
			const runId = "run_rotate_one";
			const { output, steps } = await runRotate(p.t.env, { repo: "user-1", reason: "admin", runId });
			expect(output).toMatchObject({ outcome: "rotated", repo: "user-1", reason: "admin", epoch: 1, sha: p.heads["user-1"] });
			expect(steps.done.filter((entry) => entry.name === "rotate")).toEqual([{ name: "rotate", config: GATE_STEP }]);
			expect(p.t.fleet.morphState("user-1")).toMatchObject({ epoch: 1, sha: p.heads["user-1"] });
			const run = (await runsStub(p.t.env, runId).get())!;
			expect(run).toMatchObject({ id: runId, kind: "rotate", repo: "user-1", status: "passed", reason: "admin", outcome: "rotated", epoch: 1, commit: p.heads["user-1"] });
			expect(run.steps.map((s) => [s.name, s.status])).toEqual([["Rotate to the next renamed copy", "done"]]);
			expect(run.steps[0]!.detail).toMatch(/epoch 1/);
			// The fingerprint names the copy only where the platform keeps it.
			expect(JSON.stringify(run)).not.toContain(p.t.fleet.morphState("user-1")!.fingerprint);
		},
		SLOW_MS,
	);

	it(
		"logs a refused rotation as failed, with the gate's first failures",
		async () => {
			const runId = "run_rotate_refused";
			const { output } = await runRotate(p.t.env, { repo: "user-reflective", reason: "schedule", runId });
			expect(output).toMatchObject({ outcome: "refused", epoch: 1 });
			const run = (await runsStub(p.t.env, runId).get())!;
			expect(run).toMatchObject({ kind: "rotate", status: "failed", outcome: "refused", epoch: 1 });
			expect(run.steps.at(-1)).toMatchObject({ name: "Rotate to the next renamed copy", status: "failed" });
			expect((run.failures as unknown[]).length).toBeGreaterThan(0);
			expect(JSON.stringify(run)).not.toMatch(/\$[0-9a-z]{8}/);
		},
		SLOW_MS,
	);

	it("logs a skipped rotation as cancelled, saying why", async () => {
		const runId = "run_rotate_skipped";
		const { output } = await runRotate(p.t.env, { repo: "user-unknown", reason: "admin", runId });
		expect(output).toMatchObject({ outcome: "skipped", why: "the fork is not in the fleet" });
		expect(await runsStub(p.t.env, runId).get()).toMatchObject({ kind: "rotate", repo: "user-unknown", status: "cancelled", outcome: "skipped", cancelReason: "the fork is not in the fleet" });
	});

	it("names its run after its instance when no run id is given", async () => {
		await runRotate(p.t.env, { repo: "user-unknown", reason: "tripwire" }, "rot-named");
		expect(await runsStub(p.t.env, "run_rot-named").get()).toMatchObject({ kind: "rotate", reason: "tripwire", status: "cancelled" });
	});
});

describe("RotateWorkflow without a repo", () => {
	/** A fleet of `count` forks, every fifth one still being provisioned; no repos, since no child runs here. */
	function fleetOf(count: number, options: { secret?: boolean } = {}) {
		const t = apiEnv();
		if (options.secret !== false) Object.assign(t.env, { POLYMORPH_SECRET: POLYMORPH_TEST_SECRET });
		const repos = Array.from({ length: count }, (_, i) => `user-f${i}`);
		repos.forEach((repo, i) => t.fleet.register({ repo, userId: repo.slice(5), persona: "p", pinnedTag: TAG, status: i % 5 === 0 ? "provisioning" : "pinned" }));
		return { t, rotated: repos.filter((_, i) => i % 5 !== 0) };
	}

	it.each([
		["a scheduled instance, which has no params", undefined],
		["an instance with empty params", {}],
	] as const)("starts one child for every fork not being provisioned, in paced batches, for %s", async (_case, payload) => {
		const { t, rotated } = fleetOf(30);
		const { output, workflows, steps } = await runRotate(t.env, payload as RotateParams | undefined, "sched-1");
		const runId = "run_sched-1";
		const children = workflows.of("RotateWorkflow");
		expect(children.map((child) => (child.params as RotateParams).repo)).toEqual(rotated);
		for (const child of children) {
			const repo = (child.params as RotateParams).repo!;
			expect(child.id).toMatch(new RegExp(`^${rotationId(repo, "f")}[0-9a-f]{8}$`));
			expect(child.params).toEqual({ repo, reason: "schedule", runId: `run_${child.id}` });
		}
		expect(new Set(children.map((child) => child.id)).size).toBe(children.length);
		expect(workflows.batches.map((batch) => batch.ids.length)).toEqual([FAN_OUT.batchSize, rotated.length - FAN_OUT.batchSize]);
		expect(steps.slept).toHaveLength(1);
		expect(output).toEqual({ started: rotated.length });
		expect(await runsStub(t.env, runId).get()).toMatchObject({ kind: "rotate", repo: null, status: "passed", reason: "schedule", forks: rotated.length });
	});

	it("starts no child twice when its fan-out runs again, as a retried step does", async () => {
		const { t, rotated } = fleetOf(7);
		const workflows = fakeWorkflows(NO_MODEL);
		await runRotate(t.env, undefined, "sched-3", workflows);
		await runRotate(t.env, undefined, "sched-3", workflows);
		expect(workflows.of("RotateWorkflow").map((child) => (child.params as RotateParams).repo)).toEqual(rotated);
	});

	it("starts children that rotate for an admin when an admin asked for the whole fleet", async () => {
		const { t, rotated } = fleetOf(3);
		const { workflows } = await runRotate(t.env, { reason: "admin", runId: "run_rotate_fleet" });
		expect(workflows.of("RotateWorkflow").map((child) => child.params)).toEqual(rotated.map((repo) => ({ repo, reason: "admin", runId: expect.stringMatching(/^run_rot-/) })));
	});

	it("starts nothing on a platform without a secret, saying why", async () => {
		const { t } = fleetOf(4, { secret: false });
		const { output, workflows } = await runRotate(t.env, undefined, "sched-2");
		expect(workflows.created).toEqual([]);
		expect(output).toEqual({ started: 0 });
		expect(await runsStub(t.env, "run_sched-2").get()).toMatchObject({ status: "cancelled", cancelReason: "POLYMORPH_SECRET is not set or is shorter than 16 characters" });
	});
});

describe("startRotation", () => {
	it("starts one rotation per fork and key, however often it is asked", async () => {
		const workflows = fakeWorkflows();
		const binding = workflows.exports.RotateWorkflow as never;
		const first = await startRotation(p.t.env, binding, { repo: "user-1", reason: "tripwire", key: "c2-a1b2c3d4" });
		const again = await startRotation(p.t.env, binding, { repo: "user-1", reason: "tripwire", key: "c2-a1b2c3d4" });
		await startRotation(p.t.env, binding, { repo: "user-1", reason: "landed", key: "l0123456789abcdef" });
		const id = rotationId("user-1", "c2-a1b2c3d4");
		expect([first, again]).toEqual([{ id, created: true }, { id, created: false }]);
		expect(workflows.of("RotateWorkflow")).toEqual([
			{ workflow: "RotateWorkflow", id, params: { repo: "user-1", reason: "tripwire", runId: `run_${id}` } },
			{ workflow: "RotateWorkflow", id: rotationId("user-1", "l0123456789abcdef"), params: { repo: "user-1", reason: "landed", runId: `run_${rotationId("user-1", "l0123456789abcdef")}` } },
		]);
		expect(id).toMatch(/^rot-[0-9a-f]{8}-c2-a1b2c3d4$/);
	});

	it("starts nothing without a secret, since the rotation would only skip", async () => {
		const workflows = fakeWorkflows();
		expect(await startRotation(p.withoutSecret().env, workflows.exports.RotateWorkflow as never, { repo: "user-1", reason: "landed", key: "install" })).toBeNull();
		expect(workflows.created).toEqual([]);
	});

	it("logs a failure to start and never throws, so whatever asked for the rotation still finishes", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const failing = { create: async () => Promise.reject(new Error("workflows unavailable")) };
		expect(await startRotation(p.t.env, failing as never, { repo: "user-1", reason: "install", key: "install" })).toBeNull();
		expect(await startRotation(p.t.env, undefined, { repo: "user-1", reason: "install", key: "install" })).toBeNull();
		expect(error.mock.calls.map(([line]) => String(line))).toEqual([expect.stringMatching(/rotation rot-[0-9a-f]{8}-install of user-1 \(install\) did not start: workflows unavailable$/), expect.stringMatching(/did not start: .*RotateWorkflow/)]);
	});
});

describe("POST /api/admin/fleet/rotate", () => {
	const admin = { "x-fluid-admin": "admin-token" };
	const rotate = async (headers: Record<string, string>, body: unknown) => {
		const workflows = fakeWorkflows(NO_MODEL);
		const response = await worker.fetch(post("/api/admin/fleet/rotate", headers, body), p.t.env, workflows.ctx);
		return { response, workflows };
	};

	it("starts a rotation of one fork and answers with its run id, which already has a run", async () => {
		const { response, workflows } = await rotate(admin, { repo: "user-1" });
		expect(response.status).toBe(202);
		const body = (await response.json()) as { runId: string };
		expect(body).toEqual({ runId: expect.stringMatching(/^run_rotate_[0-9a-f]{12}$/), repo: "user-1" });
		expect(workflows.of("RotateWorkflow")).toEqual([{ workflow: "RotateWorkflow", id: body.runId, params: { runId: body.runId, repo: "user-1", reason: "admin" } }]);
		expect(await runsStub(p.t.env, body.runId).get()).toMatchObject({ id: body.runId, kind: "rotate", repo: "user-1", status: "running", reason: "admin" });
	});

	it("starts one rotation for the whole fleet when no repo is named", async () => {
		const { response, workflows } = await rotate(admin, {});
		expect(response.status).toBe(202);
		const { runId } = (await response.json()) as { runId: string };
		expect(workflows.of("RotateWorkflow")).toEqual([{ workflow: "RotateWorkflow", id: runId, params: { runId, reason: "admin" } }]);
		expect(await runsStub(p.t.env, runId).get()).toMatchObject({ kind: "rotate", repo: null, reason: "admin" });
	});

	it("refuses without the admin token, and refuses a fork that is not in the fleet or a name that is not a repo", async () => {
		const cases: [Record<string, string>, unknown, number][] = [
			[{}, { repo: "user-1" }, 403],
			[{ "x-fluid-admin": "not-the-token" }, {}, 403],
			[admin, { repo: "user-unknown" }, 404],
			[admin, { repo: "../stock" }, 400],
			[admin, { repo: 7 }, 400],
		];
		for (const [headers, body, status] of cases) {
			const { response, workflows } = await rotate(headers, body);
			expect([response.status, workflows.created]).toEqual([status, []]);
		}
	});
});

describe("fluid-rotate in the platform's config", () => {
	const declared = (config as unknown as { worker: { exports: Record<string, { type: string; name?: string; schedules?: unknown }>; env: Record<string, unknown> } }).worker;

	it("is declared with its six-hour schedule", () => {
		expect(declared.exports.RotateWorkflow).toEqual({ type: "workflow", name: "fluid-rotate", schedules: "0 */6 * * *" });
	});

	it("declares every workflow the entry module exports, and no polymorph secret, so a platform without one still deploys", () => {
		const workflows = Object.keys(entry).filter((name) => name.endsWith("Workflow"));
		expect(workflows).toContain("RotateWorkflow");
		expect(workflows.filter((name) => declared.exports[name]?.type !== "workflow")).toEqual([]);
		expect(Object.keys(declared.exports).filter((name) => declared.exports[name]!.type === "workflow").sort()).toEqual(workflows.sort());
		expect(Object.keys(declared.env)).not.toContain("POLYMORPH_SECRET");
	});
});

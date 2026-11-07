// The fluid-rotate workflow and what starts it: one fork's rotation logged as
// a run, the fleet-wide instance the schedule starts, and the helper every
// other caller starts a rotation with. Rotations run through the platform's
// own code on in-memory repos and a fake Worker Loader, so the timeouts leave
// room for a loaded machine.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import config from "../cloudflare.config.ts";
import { seedPlan } from "../src/fleet/seed-catalog.ts";
import worker from "../src/index.ts";
import * as entry from "../src/index.ts";
import { forkRepoName } from "../src/lib/names.ts";
import { runsStub } from "../src/stubs.ts";
import { deriveSeed, fingerprint } from "../src/polymorph/names.ts";
import { SCAN_LIMITS } from "../src/polymorph/tokens.ts";
import { copyKey, fleetKey, GATE_STEP, installKey, landedKey, LIVE_ROTATION_WINDOW_MS, rotationId, startRotation, tripKey, type RotateParams } from "../src/workflows/common.ts";
import { SeedForkWorkflow } from "../src/workflows/fleet.ts";
import { GateWorkflow } from "../src/workflows/gate.ts";
import { RotateWorkflow } from "../src/workflows/rotate.ts";
import { clearRuntimeCache } from "../src/runtime/loader.ts";
import { FAN_OUT } from "../src/workflows/upgrade.ts";
import { apiEnv, cookieFor, post } from "./helpers/api-env.ts";
import { POLYMORPH_TEST_SECRET, PUBLISHED, REFLECTIVE, TAG, polymorphPlatform, type PolymorphPlatform } from "./helpers/polymorph-platform.ts";
import { fakeSteps, fakeWorkflows } from "./helpers/workflows.ts";

// Provisioning forks stock and pushes over git, which these tests do not run. A stand-in claims the fork
// and pins it in Fleet as provisionFork does, so what the route and the seed workflow do after it shows.
vi.mock("../src/forks/provision.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/forks/provision.ts")>();
	return {
		...real,
		provisionFork: async (env: Env, input: { userId: string; persona: { id: string }; seeded?: boolean; resume?: boolean; stockTag?: string; maxTotal?: number }) => {
			const repo = `user-${input.userId}`;
			const fleet = real.fleetStub(env);
			const claim = await fleet.claimProvisioning({ repo, userId: input.userId, persona: input.persona.id, pinnedTag: input.stockTag ?? "v1.0.0", seeded: input.seeded, maxTotal: input.maxTotal, resume: input.resume });
			if (claim.outcome === "claimed") await fleet.update(repo, { status: "pinned" });
			return { repo, status: (await fleet.get(repo))?.status ?? null };
		},
	};
});

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
	p = polymorphPlatform({
		"user-1": PUBLISHED,
		"user-reflective": REFLECTIVE,
		"user-landed": { ...PUBLISHED, "app/landed.ts": "export const landed = 1;\n" },
		"user-unmoved": { ...PUBLISHED, "app/unmoved.ts": "export const unmoved = 1;\n" },
		"user-waits": { ...PUBLISHED, "app/waits.ts": "export const waits = 1;\n" },
		"user-always-busy": { ...PUBLISHED, "app/busy.ts": "export const busy = 1;\n" },
		"user-stale": { ...PUBLISHED, "app/stale.ts": "export const stale = 1;\n" },
		"user-stale-busy": { ...PUBLISHED, "app/stale.ts": "export const stale = 2;\n" },
		// More JavaScript in one module than the renamer reads: no new copy of it can be made.
		"user-stale-outgrown": { ...PUBLISHED, "app/big.js": `// ${"x".repeat(SCAN_LIMITS.moduleChars)}\nexport const stale = 3;\n` },
	});
	for (const repo of Object.keys(p.heads)) p.t.fleet.register({ repo, userId: repo.replace(/^user-/, ""), persona: "p", pinnedTag: TAG, status: "pinned" });
});

afterAll(() => p?.cleanup());

afterEach(() => {
	vi.restoreAllMocks();
});

/** Runs one RotateWorkflow instance to its end; a scheduled instance has no payload. */
async function runRotate(env: Env, payload: RotateParams | undefined, instanceId = "rot-test", workflows = fakeWorkflows(NO_MODEL), steps = fakeSteps()) {
	const workflow = Object.assign(new RotateWorkflow(), { env, ctx: workflows.ctx });
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

	it(
		"keeps the copy's fingerprint out of what anyone reading the run by its id sees, even when the gate refused the copy",
		async () => {
			const repo = "user-reflective";
			// An install rotation's run id is rot-<fork hash>-i<registration time>: anyone who knows the fork can work it out.
			const runId = `run_${rotationId(repo, installKey(p.t.fleet.get(repo)!))}`;
			const epoch = (p.t.fleet.morphState(repo)?.epoch ?? 0) + 1;
			const refused = await fingerprint(await deriveSeed(POLYMORPH_TEST_SECRET, repo, p.heads[repo]!, epoch));
			const { output } = await runRotate(p.t.env, { repo, reason: "install", runId }, runId.slice("run_".length));
			expect(output).toMatchObject({ outcome: "refused", epoch });
			const response = await worker.fetch(new Request(`https://fluid.test/api/runs/${runId}`), p.t.env, fakeWorkflows(NO_MODEL).ctx);
			expect(response.status).toBe(200);
			const shown = await response.text();
			expect(shown).toContain("polymorph-equivalence");
			expect(shown).not.toContain(refused);
		},
		SLOW_MS,
	);

	it(
		"waits for a fork that is busy, a minute at a time, and rotates it once it is free",
		async () => {
			p.t.fleet.update("user-waits", { status: "gating" });
			// The fork's gate finishes while the workflow sleeps.
			const steps = fakeSteps({ onSleep: () => p.t.fleet.update("user-waits", { status: "pinned" }) });
			const { output } = await runRotate(p.t.env, { repo: "user-waits", reason: "landed", runId: "run_rotate_waits" }, "rot-waits", fakeWorkflows(NO_MODEL), steps);
			expect(output).toMatchObject({ outcome: "rotated", repo: "user-waits", reason: "landed", epoch: 1 });
			expect(steps.slept).toEqual(["wait while busy 1"]);
			expect(steps.done.filter((entry) => entry.name.startsWith("rotate"))).toEqual([
				{ name: "rotate", config: GATE_STEP },
				{ name: "rotate 1", config: GATE_STEP },
			]);
			expect(await runsStub(p.t.env, "run_rotate_waits").get()).toMatchObject({ status: "passed", outcome: "rotated" });
		},
		SLOW_MS,
	);

	it("gives up to the schedule after five waits for a fork that stays busy", async () => {
		p.t.fleet.update("user-always-busy", { status: "gating" });
		const steps = fakeSteps();
		const { output } = await runRotate(p.t.env, { repo: "user-always-busy", reason: "install", runId: "run_rotate_busy" }, "rot-busy", fakeWorkflows(NO_MODEL), steps);
		expect(output).toEqual({ outcome: "skipped", repo: "user-always-busy", reason: "install", why: "the fork is gating", busy: true });
		expect(steps.slept).toEqual(["wait while busy 1", "wait while busy 2", "wait while busy 3", "wait while busy 4", "wait while busy 5"]);
		expect(await runsStub(p.t.env, "run_rotate_busy").get()).toMatchObject({ status: "cancelled", cancelReason: "the fork is gating" });
	});

	/** Stores a copy made under another secret, which the platform's seed no longer makes, marks the fork busy, and returns the copy. */
	function staleCopyOnBusyFork(repo: string) {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const stale = { epoch: 1, sha: p.heads[repo]!, fingerprint: "a1b2c3d4", namesHash: "0badc0de", names: ["researchNeedsAttestation"], variant: "5eed0001" };
		if (!p.t.fleet.setMorph(repo, stale, { from: null })) throw new Error(`${repo}: no copy stored`);
		p.t.fleet.update(repo, { status: "gating" });
		return stale;
	}

	it(
		"keeps the stale copy while it waits for the busy fork, and rotates the fork once it is free",
		async () => {
			const repo = "user-stale";
			const stale = staleCopyOnBusyFork(repo);
			const kept: unknown[] = [];
			const steps = fakeSteps({
				onSleep: () => {
					kept.push(p.t.fleet.morphState(repo));
					p.t.fleet.update(repo, { status: "pinned" });
				},
			});
			const { output } = await runRotate(p.t.env, { repo, reason: "mismatch", runId: "run_rotate_stale" }, "rot-stale", fakeWorkflows(NO_MODEL), steps);
			expect(kept).toEqual([expect.objectContaining(stale)]);
			expect(output).toMatchObject({ outcome: "rotated", repo, epoch: 2 });
			expect(output).not.toHaveProperty("cleared");
			const run = (await runsStub(p.t.env, "run_rotate_stale").get())!;
			expect(run).toMatchObject({ status: "passed", outcome: "rotated", epoch: 2 });
			expect(run).not.toHaveProperty("cleared");
			expect(run.steps.at(-1)!.detail).toMatch(/and the fork serves it now$/);
			expect(p.t.fleet.securityEvents(repo).map((event) => event.kind)).toEqual(["rotated"]);
		},
		SLOW_MS,
	);

	it("keeps the stale copy through every try while the fork stays busy, and says nothing was cleared", async () => {
		const repo = "user-stale-busy";
		const stale = staleCopyOnBusyFork(repo);
		const { output } = await runRotate(p.t.env, { repo, reason: "mismatch", runId: "run_rotate_stale_busy" }, "rot-stale-busy");
		expect(output).toEqual({ outcome: "skipped", repo, reason: "mismatch", why: "the fork is gating", busy: true });
		expect(p.t.fleet.morphState(repo)).toMatchObject(stale);
		const run = (await runsStub(p.t.env, "run_rotate_stale_busy").get())!;
		expect(run).toMatchObject({ status: "cancelled", cancelReason: "the fork is gating" });
		expect(run).not.toHaveProperty("cleared");
		expect(p.t.fleet.securityEvents(repo)).toEqual([]);
	});

	it(
		"clears the stale copy when the try on the free fork after a busy wait stores no new copy, and says so on the run",
		async () => {
			const repo = "user-stale-outgrown";
			staleCopyOnBusyFork(repo);
			const steps = fakeSteps({ onSleep: () => p.t.fleet.update(repo, { status: "pinned" }) });
			const { output } = await runRotate(p.t.env, { repo, reason: "mismatch", runId: "run_rotate_stale_outgrown" }, "rot-stale-outgrown", fakeWorkflows(NO_MODEL), steps);
			expect(steps.slept).toEqual(["wait while busy 1"]);
			expect(output).toMatchObject({ outcome: "skipped", repo, reason: "mismatch", why: expect.stringMatching(/^the gate made no renamed copy of main: /), cleared: true });
			expect(output).not.toHaveProperty("busy");
			expect(p.t.fleet.morphState(repo)).toBeNull();
			const run = (await runsStub(p.t.env, "run_rotate_stale_outgrown").get())!;
			expect(run).toMatchObject({ status: "cancelled", outcome: "skipped", cleared: true });
			expect(run.steps.at(-1)!.detail).toMatch(/; the stored copy no longer builds, so it was cleared and the fork answers as one with no copy$/);
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
		expect(await runsStub(t.env, "run_sched-2").get()).toMatchObject({ status: "cancelled", cancelReason: "POLYMORPH_SECRET is not set or is shorter than 32 characters" });
	});
});

describe("tripKey", () => {
	it("names the live path's tripwire rotation of a fork by the ten-minute window alone, so a new copy starts no new rotation in it", () => {
		const at = Date.parse("2026-11-06T10:07:00Z");
		const window = Math.floor(at / LIVE_ROTATION_WINDOW_MS).toString(36);
		expect(tripKey(at)).toBe(`t${window}`);
		expect(tripKey(at + 2 * 60_000)).toBe(`t${window}`);
		expect(tripKey(at + 3 * 60_000)).not.toBe(`t${window}`);
		// No other key starts with "t", so a tripwire rotation never shares an instance with another kind.
		const others = [copyKey({ epoch: 3 }, at), installKey({ createdAt: new Date(at).toISOString() }), landedKey("0123456789abcdef0123"), fleetKey("run_sched-1")];
		expect(others.map((key) => key[0])).toEqual(["c", "i", "l", "f"]);
	});
});

describe("copyKey", () => {
	it("names the live path's mismatch rotation of a stored copy by the copy's epoch and the ten-minute window, and nothing about its fingerprint", () => {
		const at = Date.parse("2026-11-06T10:07:00Z");
		const window = Math.floor(at / LIVE_ROTATION_WINDOW_MS).toString(36);
		expect(copyKey({ epoch: 3, fingerprint: "a1b2c3d4" }, at)).toBe(`c3-t${window}`);
		expect(copyKey({ epoch: 3, fingerprint: "0f0f0f0f" }, at + 2 * 60_000)).toBe(`c3-t${window}`);
		expect(copyKey({ epoch: 3, fingerprint: "a1b2c3d4" }, at + 3 * 60_000)).not.toBe(`c3-t${window}`);
	});
});

describe("startRotation", () => {
	it("starts one rotation per fork and key, however often it is asked", async () => {
		const workflows = fakeWorkflows();
		const binding = workflows.exports.RotateWorkflow as never;
		const first = await startRotation(p.t.env, binding, { repo: "user-1", reason: "tripwire", key: "k1" });
		const again = await startRotation(p.t.env, binding, { repo: "user-1", reason: "tripwire", key: "k1" });
		await startRotation(p.t.env, binding, { repo: "user-1", reason: "landed", key: "l0123456789abcdef" });
		const id = rotationId("user-1", "k1");
		expect([first, again]).toEqual([{ id, created: true }, { id, created: false }]);
		expect(workflows.of("RotateWorkflow")).toEqual([
			{ workflow: "RotateWorkflow", id, params: { repo: "user-1", reason: "tripwire", runId: `run_${id}` } },
			{ workflow: "RotateWorkflow", id: rotationId("user-1", "l0123456789abcdef"), params: { repo: "user-1", reason: "landed", runId: `run_${rotationId("user-1", "l0123456789abcdef")}` } },
		]);
		expect(id).toMatch(/^rot-[0-9a-f]{8}-k1$/);
	});

	it("starts nothing without a secret, since the rotation would only skip", async () => {
		const workflows = fakeWorkflows();
		expect(await startRotation(p.withoutSecret().env, workflows.exports.RotateWorkflow as never, { repo: "user-1", reason: "landed", key: "install" })).toBeNull();
		expect(workflows.created).toEqual([]);
	});

	it("logs a failure to start and never throws, so whatever asked for the rotation still finishes", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const failing = { create: async () => Promise.reject(new Error("workflows unavailable")) };
		expect(await startRotation(p.t.env, failing as never, { repo: "user-1", reason: "install", key: "k-failing" })).toBeNull();
		expect(error.mock.calls.map(([line]) => String(line))).toEqual([expect.stringMatching(/rotation rot-[0-9a-f]{8}-k-failing of user-1 \(install\) did not start: workflows unavailable$/)]);
	});

	it("awaits no second create for a rotation this isolate started, until the loader starts over", async () => {
		const creates: string[] = [];
		const binding = { create: async ({ id }: { id: string }) => (creates.push(id), creates.length > 1 ? Promise.reject(new Error(`instance ${id} already exists`)) : { id }) };
		const key = "k-memo";
		const id = rotationId("user-1", key);
		expect(await startRotation(p.t.env, binding as never, { repo: "user-1", reason: "tripwire", key })).toEqual({ id, created: true });
		for (let i = 0; i < 3; i++) expect(await startRotation(p.t.env, binding as never, { repo: "user-1", reason: "tripwire", key })).toEqual({ id, created: false });
		expect(creates).toEqual([id]);
		// A new isolate knows nothing of it: the binding answers that the instance exists.
		clearRuntimeCache();
		expect(await startRotation(p.t.env, binding as never, { repo: "user-1", reason: "tripwire", key })).toEqual({ id, created: false });
		expect(creates).toEqual([id, id]);
	});

	it("remembers no rotation that failed to start, so the next request tries again", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		let fail = true;
		const binding = { create: async ({ id }: { id: string }) => (fail ? Promise.reject(new Error("workflows unavailable")) : { id }) };
		expect(await startRotation(p.t.env, binding as never, { repo: "user-1", reason: "tripwire", key: "k-retry" })).toBeNull();
		fail = false;
		expect(await startRotation(p.t.env, binding as never, { repo: "user-1", reason: "tripwire", key: "k-retry" })).toEqual({ id: rotationId("user-1", "k-retry"), created: true });
	});

	it("throws when the platform has a secret but no rotate workflow binding, a mistake no request should hide", async () => {
		await expect(startRotation(p.t.env, undefined as never, { repo: "user-1", reason: "install", key: "k-unbound" })).rejects.toThrow(/no RotateWorkflow binding/);
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

describe("the gate workflow after a merge mode pass", () => {
	/**
	 * Gates the fork's head in merge mode through GateWorkflow. The git work
	 * around the gate (checking the change, moving main) is stood in for, with
	 * what it decided given; the tiers run for real.
	 */
	async function mergeGate(repo: string, workflows: ReturnType<typeof fakeWorkflows>, moved: Record<string, unknown>) {
		const gate = Object.assign(new GateWorkflow(), { env: p.t.env, ctx: workflows.ctx });
		Object.assign(gate, { checkChange: async () => ({ status: "ok", appendOnly: [], platformClaims: [] }), advanceMain: async () => moved });
		const payload = { repo, branch: "work/change", commit: p.heads[repo]!, mode: "merge", source: "customize", runId: `run_gate_${repo}` };
		const steps = fakeSteps();
		const output = await gate.run({ payload, timestamp: new Date(), instanceId: `gate-${repo}`, workflowName: "fluid-gate" } as never, steps.step as never);
		return { output, steps };
	}

	it(
		"starts a landed rotation once the change is on main and the fork is pinned again, and one only per landed commit",
		async () => {
			const repo = "user-landed";
			const head = p.heads[repo]!;
			const statuses: string[] = [];
			const workflows = fakeWorkflows(NO_MODEL, { onCreate: (instance) => instance.workflow === "RotateWorkflow" && statuses.push(p.t.fleet.get(repo)!.status) });
			const landed = { ok: true, oid: head, regate: null, previous: head, landed: true };
			const { output } = await mergeGate(repo, workflows, landed);
			expect(output).toMatchObject({ merged: true });
			const [rotation, ...more] = workflows.of("RotateWorkflow");
			expect(more).toEqual([]);
			expect(rotation).toEqual({ workflow: "RotateWorkflow", id: rotationId(repo, `l${head.slice(0, 16)}`), params: { repo, reason: "landed", runId: `run_${rotation!.id}` } });
			// While the fork is gating a rotation skips, so it must start after the gate set the fork back to pinned.
			expect(statuses).toEqual(["pinned"]);
			// The same commit landing again (a replayed run) starts no second rotation.
			await mergeGate(repo, workflows, landed);
			expect(workflows.of("RotateWorkflow")).toHaveLength(1);
		},
		SLOW_MS,
	);

	it(
		"starts none when the pass moved nothing onto main",
		async () => {
			const workflows = fakeWorkflows(NO_MODEL);
			const { output } = await mergeGate("user-unmoved", workflows, { ok: true, oid: p.heads["user-unmoved"], regate: null });
			expect(output).toMatchObject({ merged: true });
			expect(workflows.of("RotateWorkflow")).toEqual([]);
		},
		SLOW_MS,
	);
});

describe("a new fork", () => {
	/** Records each rotation created, with the fork's status at that moment. */
	function watched() {
		const statuses: string[] = [];
		const workflows = fakeWorkflows(NO_MODEL, {
			onCreate: (instance) => {
				if (instance.workflow === "RotateWorkflow") statuses.push(p.t.fleet.get((instance.params as RotateParams).repo!)!.status);
			},
		});
		return { workflows, statuses };
	}

	it("installs as a renamed copy when POST /api/forks provisions it: one install rotation, started once the fork is pinned", async () => {
		const { workflows, statuses } = watched();
		const cookie = await cookieFor({ userId: "s-new1" });
		expect((await worker.fetch(post("/api/forks", { cookie }), p.t.env, workflows.ctx)).status).toBe(201);
		const id = rotationId("user-s-new1", installKey(p.t.fleet.get("user-s-new1")!));
		expect(workflows.of("RotateWorkflow")).toEqual([{ workflow: "RotateWorkflow", id, params: { repo: "user-s-new1", reason: "install", runId: `run_${id}` } }]);
		expect(statuses).toEqual(["pinned"]);
		// Asking again for the fork the session already has provisions nothing, and starts nothing.
		expect((await worker.fetch(post("/api/forks", { cookie }), p.t.env, workflows.ctx)).status).toBe(201);
		expect(workflows.of("RotateWorkflow")).toHaveLength(1);
	});

	it("installs a fork deleted and created again under the same name as a renamed copy again", async () => {
		const { workflows } = watched();
		const cookie = await cookieFor({ userId: "s-again" });
		const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-06T10:00:00Z"));
		await worker.fetch(post("/api/forks", { cookie }), p.t.env, workflows.ctx);
		const first = installKey(p.t.fleet.get("user-s-again")!);
		p.t.fleet.remove("user-s-again");
		now.mockReturnValue(Date.parse("2026-11-06T11:00:00Z"));
		await worker.fetch(post("/api/forks", { cookie }), p.t.env, workflows.ctx);
		const second = installKey(p.t.fleet.get("user-s-again")!);
		expect(second).not.toBe(first);
		expect(workflows.of("RotateWorkflow").map((instance) => instance.id)).toEqual([rotationId("user-s-again", first), rotationId("user-s-again", second)]);
	});

	it("installs as a renamed copy when the seed workflow has provisioned it and pinned it", async () => {
		const { workflows, statuses } = watched();
		// A seeded fork with no customization: provisioned, then pinned.
		const spec = seedPlan("poly", 40).find((candidate) => candidate.kinds.join() === "none");
		if (!spec) throw new Error("the seed plan has no fork without customizations");
		const seed = Object.assign(new SeedForkWorkflow(), { env: p.t.env, ctx: workflows.ctx });
		const steps = fakeSteps();
		await seed.run({ payload: { batch: "poly", index: spec.index, count: 40, stockTag: TAG }, timestamp: new Date(), instanceId: `seed-poly-${spec.index}`, workflowName: "fluid-seed-fork" } as never, steps.step as never);
		const repo = forkRepoName(spec.userId);
		const id = rotationId(repo, installKey(p.t.fleet.get(repo)!));
		expect(workflows.of("RotateWorkflow")).toEqual([{ workflow: "RotateWorkflow", id, params: { repo, reason: "install", runId: `run_${id}` } }]);
		expect(statuses).toEqual(["pinned"]);
		expect(steps.names()).toEqual(["provision", "ready", "rotate the new fork"]);
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

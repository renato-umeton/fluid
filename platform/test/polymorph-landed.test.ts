// A commit that lands on main runs plain until a rotation stores a verified
// copy of it. Besides a merge mode gate (polymorph-workflow.test.ts), main
// moves when an auto upgrade lands, when its owner approves a pending upgrade
// with one tap, and when a yellow soak rolls it back: each starts a "landed"
// rotation of the new main, once the fork's status is one a rotation does not
// wait out. The gates and git work around these steps are stood in for; what
// starts after them is the platform's own code.
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { checkoutBranch, commitChanges, initRepo, writeFiles, type Workspace } from "../src/git/ops.ts";
import type { GateResult } from "../src/gate/tiers.ts";
import { runsStub } from "../src/stubs.ts";
import { landedKey, rotationId, type RotateParams } from "../src/workflows/common.ts";
import { UpgradeWorkflow } from "../src/workflows/upgrade.ts";
import { errorResult, YellowWorkflow } from "../src/workflows/yellow.ts";
import { apiEnv, cookieFor, post } from "./helpers/api-env.ts";
import { POLYMORPH_TEST_SECRET } from "./helpers/polymorph-platform.ts";
import { fakeWorkflows } from "./helpers/workflows.ts";

// One in-memory repository stands in for the fork's remote: a clone is that repository, and a push changes nothing.
const remote: { ws: Workspace | null } = { ws: null };
vi.mock("../src/git/ops.ts", async (importOriginal) => {
	const ops = await importOriginal<typeof import("../src/git/ops.ts")>();
	return { ...ops, cloneRepo: async () => remote.ws!, fetchBranch: async () => undefined, pushBranch: async () => ({ ok: true }) };
});

const TAG = "v1.2.0";

/** A fork in the fleet on a platform with a polymorph secret, and the rotations started, each with the fork's status at that moment. */
function setup(repo: string) {
	const t = apiEnv();
	Object.assign(t.env, { POLYMORPH_SECRET: POLYMORPH_TEST_SECRET });
	t.artifacts.add(repo);
	t.fleet.register({ repo, userId: repo.slice("user-".length), persona: "hospitalist-researcher", pinnedTag: "v1.1.0", status: "pinned" });
	const statuses: string[] = [];
	const workflows = fakeWorkflows({}, { onCreate: (instance) => instance.workflow === "RotateWorkflow" && statuses.push(t.fleet.get(repo)!.status) });
	const rotations = () => workflows.of("RotateWorkflow").map((instance) => ({ id: instance.id, params: instance.params as RotateParams }));
	return { t, workflows, statuses, rotations };
}

/** A step stand-in that runs every step, except the named ones, whose results are given. */
function stepsWith(given: Record<string, unknown>) {
	const names: string[] = [];
	const step = {
		do: async (name: string, ...rest: unknown[]) => {
			names.push(name);
			if (name in given) return given[name];
			return structuredClone(await (rest.at(-1) as () => Promise<unknown>)());
		},
		sleep: async () => undefined,
		waitForEvent: async () => {
			throw new Error("these tests send no events");
		},
	};
	return { step, names };
}

const landedRotation = (repo: string, commit: string) => ({ id: rotationId(repo, landedKey(commit)), params: { repo, reason: "landed", runId: `run_${rotationId(repo, landedKey(commit))}` } });

describe("an auto upgrade", () => {
	const repo = "user-s-up";
	const runId = "run_upgrade_landed";
	const commit = "a".repeat(40);
	const passed: GateResult = { repo, ref: `upgrade/${TAG}`, commit, stockTag: TAG, stockCommit: null, at: new Date().toISOString(), passed: true, tiers: { invariant: null, functional: null, user: null }, failures: [], durationMs: 1 };

	/** Lands (or not) a gated upgrade the way the workflow's gateAndLand does, with the gate and the move of main given. */
	async function gateAndLand(applied: Record<string, unknown>) {
		const setUp = setup(repo);
		await runsStub(setUp.t.env, runId).create({ id: runId, kind: "upgrade", repo, status: "running" });
		const upgrade = Object.assign(new UpgradeWorkflow(), { env: setUp.t.env, ctx: setUp.workflows.ctx });
		const { step, names } = stepsWith({ gate: passed, apply: applied });
		const params = { runId, repo, tag: TAG, safety: false, graceUntil: null };
		const outcome = await (upgrade as unknown as { gateAndLand: (s: unknown, p: unknown, i: unknown) => Promise<unknown> }).gateAndLand(step, params, { branch: `upgrade/${TAG}`, commit, autoUpgrade: true, prefix: "", tiersPrefix: "", extra: {} });
		return { ...setUp, outcome, names };
	}

	it("starts a landed rotation of the new main once the fork shows the upgrade passed", async () => {
		const { outcome, rotations, statuses, names } = await gateAndLand({ applied: true, regate: null, previous: "b".repeat(40), landed: true });
		expect(outcome).toEqual({ passed: true, outcome: "applied" });
		expect(rotations()).toEqual([landedRotation(repo, commit)]);
		expect(statuses).toEqual(["passed"]);
		expect(names.indexOf("rotate the new main")).toBeGreaterThan(names.indexOf("finish pass"));
	});

	it("starts none while the upgrade waits for its owner's one tap, since main has not moved", async () => {
		const { outcome, rotations } = await gateAndLand({ applied: false, regate: null });
		expect(outcome).toEqual({ passed: true, outcome: "ready" });
		expect(rotations()).toEqual([]);
	});
});

describe("a one-tap upgrade approval", () => {
	const repo = "user-s-tap";

	/** main at one commit, and the gated upgrade branch one commit ahead of it. */
	async function forkWithUpgrade() {
		const ws = await initRepo();
		await writeFiles(ws, { "fluid.toml": 'stock_tag = "v1.1.0"\n' });
		await commitChanges(ws, { message: "main" });
		await checkoutBranch(ws, `upgrade/${TAG}`, { create: true, from: "main" });
		await writeFiles(ws, { "fluid.toml": `stock_tag = "${TAG}"\n` });
		const head = await commitChanges(ws, { message: `upgrade to ${TAG}` });
		await checkoutBranch(ws, "main");
		return { ws, head };
	}

	it("starts a landed rotation of the new main once the fork shows the upgrade passed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { t, workflows, statuses, rotations } = setup(repo);
		const { ws, head } = await forkWithUpgrade();
		remote.ws = ws;
		const upgradeRun = "run_upgrade_tap_landed";
		await runsStub(t.env, upgradeRun).create({ id: upgradeRun, kind: "upgrade", repo, status: "passed" });
		t.fleet.update(repo, { pendingUpgrade: { tag: TAG, commit: head, runId: upgradeRun, branch: `upgrade/${TAG}` } });
		const response = await worker.fetch(post(`/api/forks/${repo}/upgrade`, { cookie: await cookieFor({ userId: "s-tap" }) }), t.env, workflows.ctx);
		expect(response.status).toBe(200);
		expect(rotations()).toEqual([landedRotation(repo, head)]);
		expect(statuses).toEqual(["passed"]);
		vi.restoreAllMocks();
	});
});

describe("a yellow rollback", () => {
	const repo = "user-s-back";
	const runId = "run_yel-landed";
	const yellow = "d".repeat(40);
	const params = { runId, repo, commit: yellow, previous: "e".repeat(40), source: "gate" as const };

	/** Fails the soak with the rollback's outcome given, as YellowWorkflow.fail does after a failed pass. */
	async function fail(rolledBack: Record<string, unknown>) {
		const setUp = setup(repo);
		await runsStub(setUp.t.env, runId).create({ id: runId, kind: "yellow", repo, status: "running" });
		const workflow = Object.assign(new YellowWorkflow(), { env: setUp.t.env, ctx: setUp.workflows.ctx });
		const { step, names } = stepsWith({ "roll back": rolledBack });
		await (workflow as unknown as { fail: (s: unknown, p: unknown, r: unknown, b: unknown) => Promise<unknown> }).fail(step, params, errorResult(params, "a scenario failed"), null);
		return { ...setUp, names };
	}

	it("starts a landed rotation of the revert commit that moved main back", async () => {
		const revert = "c".repeat(40);
		const { rotations, statuses, names } = await fail({ action: "revert", reason: "", revertCommit: revert, relies: [] });
		expect(rotations()).toEqual([landedRotation(repo, revert)]);
		expect(statuses).toEqual(["pinned"]);
		expect(names.indexOf("rotate the rolled back main")).toBeGreaterThan(names.indexOf("roll back"));
	});

	it("starts none when the rollback left main where it was", async () => {
		const { rotations } = await fail({ action: "none", reason: "no green commit to go back to", revertCommit: null, relies: [] });
		expect(rotations()).toEqual([]);
	});
});

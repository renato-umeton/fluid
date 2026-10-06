// The replay's apply step pushed main and then threw. gateAndLand checks
// main ("check main"), finds the replay commit there, and lands the upgrade:
// the tag is pinned and the fork goes yellow.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutBranch, commitChanges, headCommit, initRepo, writeFiles, type Workspace } from "../src/git/ops.ts";
import { runsStub } from "../src/stubs.ts";
import { UpgradeWorkflow } from "../src/workflows/upgrade.ts";
import { apiEnv, workerContext } from "./helpers/api-env.ts";

// One in-memory repository stands in for the fork's remote: a clone is that
// repository, and the push "reaches" it (fastForward already moved main) and then fails.
const remote: { ws: Workspace | null } = { ws: null };
vi.mock("../src/git/ops.ts", async (importOriginal) => {
	const ops = await importOriginal<typeof import("../src/git/ops.ts")>();
	return {
		...ops,
		cloneRepo: async () => remote.ws!,
		fetchBranch: async () => undefined,
		pushBranch: async () => {
			throw new Error("connection reset after the push");
		},
	};
});

const REPO = "user-s-1";
const RUN = "run_upgrade_check_main";
const TAG = "v1.2.0";
const params = { runId: RUN, repo: REPO, tag: TAG, safety: false, graceUntil: null };

async function forkWithReplay() {
	const ws = await initRepo();
	await writeFiles(ws, { "fluid.toml": 'stock_tag = "v1.1.0"\n' });
	const before = await commitChanges(ws, { message: "main" });
	await checkoutBranch(ws, `replay/${TAG}`, { create: true, from: "main" });
	// The gated commit's first parent is a branch commit that was never on main, as after
	// main moved and was merged into the branch for another gate.
	await writeFiles(ws, { "fluid.toml": 'stock_tag = "v1.2.0"\n' });
	await commitChanges(ws, { message: "replay: stock" });
	await writeFiles(ws, { "app/wording.ts": "mine\n" });
	const replay = await commitChanges(ws, { message: "replay: wish" });
	await checkoutBranch(ws, "main");
	return { ws, before, replay };
}

const passedGate = (commit: string) => ({ repo: REPO, ref: `replay/${TAG}`, commit, stockTag: TAG, stockCommit: null, at: new Date().toISOString(), passed: true, tiers: { invariant: null, functional: null, user: null }, failures: [], durationMs: 1 });

describe("gateAndLand after an apply that pushed main and then threw", () => {
	let names: string[];
	beforeEach(() => {
		names = [];
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	async function land(options: { retryApply?: boolean } = {}) {
		const t = apiEnv();
		t.artifacts.add(REPO);
		t.fleet.register({ repo: REPO, userId: "s-1", persona: "hospitalist-researcher", pinnedTag: "v1.1.0", status: "pinned" });
		await runsStub(t.env, RUN).create({ id: RUN, kind: "upgrade", repo: REPO, status: "running" });
		const { ws, before, replay } = await forkWithReplay();
		remote.ws = ws;
		const { ctx, created } = workerContext();
		const workflow = new UpgradeWorkflow();
		Object.assign(workflow, { env: t.env, ctx });
		const step = {
			do: async (name: string, ...rest: unknown[]) => {
				names.push(name);
				if (name === "replay gate") return passedGate(replay);
				const run = rest.at(-1) as () => Promise<unknown>;
				// The apply step's retry (GIT_STEP retries), when asked for: the second try finds main already at the commit.
				if (name === "replay apply" && options.retryApply) return run().catch(() => run());
				return run();
			},
			sleep: async () => undefined,
		};
		const result = await (workflow as unknown as { gateAndLand: (s: unknown, p: unknown, i: unknown) => Promise<unknown> }).gateAndLand(step, params, { branch: `replay/${TAG}`, commit: replay, autoUpgrade: true, prefix: "replay ", tiersPrefix: "Replay: ", extra: { path: "replay" }, failSoft: true });
		return { t, ws, before, replay, result, created };
	}

	it("lands the upgrade instead of falling back to a merge", async () => {
		const { result, ws, replay } = await land();
		expect(result).toEqual({ passed: true, outcome: "applied" });
		expect(names).toEqual(expect.arrayContaining(["replay apply", "replay apply stopped", "replay check main", "replay go yellow", "replay finish pass"]));
		expect(await headCommit(ws, "main")).toBe(replay);
	});

	it("pins the tag and starts the fork yellow at the replay commit", async () => {
		const { t, replay, created } = await land();
		const entry = await t.fleet.get(REPO);
		expect(entry).toMatchObject({ pinnedTag: TAG, pendingUpgrade: null, status: "passed" });
		expect(entry!.health).toMatchObject({ health: "yellow", commit: replay });
		expect(created.filter((c) => c.workflow === "YellowWorkflow")).toHaveLength(1);
	});

	it("rolls back to main's head from before the push, not the replay commit's first parent", async () => {
		const { t, before } = await land();
		expect((await t.fleet.get(REPO))!.health.lastGreenCommit).toBe(before);
	});

	it("uses main's head from before the push when a retried apply finds main already at the commit", async () => {
		const { t, before, result } = await land({ retryApply: true });
		expect(result).toEqual({ passed: true, outcome: "applied" });
		expect(names).not.toContain("replay check main");
		expect((await t.fleet.get(REPO))!.health).toMatchObject({ health: "yellow", lastGreenCommit: before });
	});
});

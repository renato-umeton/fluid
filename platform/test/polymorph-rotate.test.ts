// Rotation moves a fork to its next renamed copy only after a check mode gate
// shows that copy answers every probe like the plain fork; otherwise the fork
// keeps the copy it has. Gates run through the platform's own code on
// in-memory repos and a fake Worker Loader, so the timeouts leave room for a
// loaded machine.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { deriveSeed, fingerprint, namesHash } from "../src/polymorph/names.ts";
import { PolymorphTransientError } from "../src/polymorph/install.ts";
import { rotateFork } from "../src/polymorph/rotate.ts";
import { SCAN_LIMITS } from "../src/polymorph/tokens.ts";
import { loadForkRuntime } from "../src/runtime/loader.ts";
import { LISTED, POLYMORPH_TEST_SECRET, PUBLISHED, REFLECTIVE, TAG, polymorphPlatform, type PolymorphPlatform } from "./helpers/polymorph-platform.ts";

const SLOW_MS = 120_000;
// A fork whose main moves on to a second commit while a rotation's gate runs.
const MOVING = { ...PUBLISHED, "app/moving.ts": "export const moving = 1;\n" };
const MOVED_ON = { ...MOVING, "app/moving.ts": "export const moving = 2;\n" };
const t0 = Date.parse("2026-11-06T10:00:00Z");
const iso = (at: number) => new Date(at).toISOString();

let p: PolymorphPlatform;

beforeAll(() => {
	p = polymorphPlatform({
		"user-1": PUBLISHED,
		"user-resecret": { ...PUBLISHED, "app/resecret.ts": "export const resecret = 1;\n" },
		"user-race": { ...PUBLISHED, "app/race.ts": "export const race = 1;\n" },
		"user-moving": MOVING,
		"user-reflective": REFLECTIVE,
		"user-busy": { ...PUBLISHED, "app/busy.ts": "export const busy = 1;\n" },
		"user-flaky": { ...PUBLISHED, "app/flaky.ts": "export const flaky = 1;\n" },
		// More JavaScript in one module than the renamer reads: the plain fork runs, no copy can be made.
		"user-big": { ...PUBLISHED, "app/big.js": `// ${"x".repeat(SCAN_LIMITS.moduleChars)}\nexport const big = 1;\n` },
		// Forks whose stored copy no longer builds, as after a change to the renamer's limits.
		"user-outgrown": { ...PUBLISHED, "app/big.js": `// ${"x".repeat(SCAN_LIMITS.moduleChars)}\nexport const outgrown = 1;\n` },
		"user-outgrown-2": { ...PUBLISHED, "app/big.js": `// ${"x".repeat(SCAN_LIMITS.moduleChars)}\nexport const outgrown = 2;\n` },
		"user-stale-busy": { ...PUBLISHED, "app/stale.ts": "export const stale = 1;\n" },
	});
	for (const repo of Object.keys(p.heads)) p.t.fleet.register({ repo, userId: repo.replace(/^user-/, ""), persona: "p", pinnedTag: TAG, status: "pinned" });
});

afterAll(() => p?.cleanup());

afterEach(() => {
	vi.restoreAllMocks();
});

const printOf = async (repo: string, epoch: number) => fingerprint(await deriveSeed(POLYMORPH_TEST_SECRET, repo, p.heads[repo]!, epoch));

describe("rotateFork", () => {
	it(
		"moves a fork to epoch 1, then to epoch 2, storing each verified copy's fingerprint and names hash",
		async () => {
			const fleet = p.t.fleet;
			const head = p.heads["user-1"]!;
			const hash = await namesHash(LISTED);
			expect(await rotateFork(p.deps, "user-1", "schedule")).toEqual({ outcome: "rotated", repo: "user-1", reason: "schedule", epoch: 1, sha: head, fingerprint: await printOf("user-1", 1), namesHash: hash });
			const second = await rotateFork(p.deps, "user-1", "tripwire");
			expect(second).toEqual({ outcome: "rotated", repo: "user-1", reason: "tripwire", epoch: 2, sha: head, fingerprint: await printOf("user-1", 2), namesHash: hash });
			expect(fleet.morphState("user-1")).toMatchObject({ epoch: 2, sha: head, fingerprint: await printOf("user-1", 2), namesHash: hash });
			expect(fleet.securityEvents("user-1").map((event) => [event.kind, event.detail])).toEqual([
				["rotated", { reason: "tripwire", epoch: 2, fingerprint: await printOf("user-1", 2) }],
				["rotated", { reason: "schedule", epoch: 1, fingerprint: await printOf("user-1", 1) }],
			]);
			// What production loads from the stored state is the copy the gate checked.
			const state = fleet.morphState("user-1")!;
			const loaded = await loadForkRuntime(p.deps, "user-1", "main", { morph: { epoch: state.epoch, onlyAt: state.sha, namesHash: state.namesHash, fingerprint: state.fingerprint } });
			expect(loaded.morph?.fingerprint).toBe(state.fingerprint);
		},
		SLOW_MS,
	);

	it(
		"stores nothing when another rotation moved the fork first, so a retired copy never comes back",
		async () => {
			const fleet = p.t.fleet;
			const setMorph = fleet.setMorph.bind(fleet);
			let release!: () => void;
			const held = new Promise<void>((resolve) => (release = resolve));
			let calls = 0;
			// The first rotation to finish its gate is held just before it stores, while two more rotate the fork.
			vi.spyOn(fleet, "setMorph").mockImplementation((async (...args: Parameters<typeof setMorph>) => {
				if (++calls === 1) await held;
				return setMorph(...args);
			}) as never);
			const slow = rotateFork(p.deps, "user-race", "schedule");
			await vi.waitFor(() => expect(calls).toBe(1), { timeout: SLOW_MS, interval: 20 });
			expect(await rotateFork(p.deps, "user-race", "landed")).toMatchObject({ outcome: "rotated", epoch: 1 });
			expect(await rotateFork(p.deps, "user-race", "tripwire")).toMatchObject({ outcome: "rotated", epoch: 2 });
			release();
			expect(await slow).toEqual({ outcome: "skipped", repo: "user-race", reason: "schedule", why: "another rotation moved the fork first" });
			expect(fleet.morphState("user-race")).toMatchObject({ epoch: 2, fingerprint: await printOf("user-race", 2) });
			expect(fleet.securityEvents("user-race").map((event) => event.detail?.epoch)).toEqual([2, 1]);
		},
		SLOW_MS,
	);

	it(
		"stores nothing when main moved while the gate ran, since the copy is of a commit main no longer serves",
		async () => {
			const get = p.loader.get.bind(p.loader);
			let moved = false;
			// The gate has resolved main when it asks for its first isolate; main moves on right then.
			vi.spyOn(p.loader, "get").mockImplementation((id, factory) => {
				if (!moved && id.startsWith("user-moving:")) {
					moved = true;
					p.t.artifacts.seed("user-moving", { commits: [MOVING, MOVED_ON] });
				}
				return get(id, factory);
			});
			expect(await rotateFork(p.deps, "user-moving", "schedule")).toEqual({ outcome: "skipped", repo: "user-moving", reason: "schedule", why: "main moved during the rotation" });
			expect(moved).toBe(true);
			expect(p.t.fleet.morphState("user-moving")).toBeNull();
			expect(p.t.fleet.securityEvents("user-moving")).toEqual([]);
		},
		SLOW_MS,
	);

	it(
		"leaves a fork plain, not on an unverified copy, when the platform secret changed after the rotation",
		async () => {
			const result = await rotateFork(p.deps, "user-resecret", "schedule");
			if (result.outcome !== "rotated") throw new Error(`expected a rotation, got ${result.outcome}`);
			const state = p.t.fleet.morphState("user-resecret")!;
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const newSecret = { ...p.deps, env: { ...p.t.env, POLYMORPH_SECRET: "a-new-platform-secret-after-rotation" } as unknown as Env };
			const loaded = await loadForkRuntime(newSecret, "user-resecret", "main", { morph: { epoch: state.epoch, onlyAt: state.sha, namesHash: state.namesHash, fingerprint: state.fingerprint } });
			expect([loaded.morph, loaded.isolateId]).toEqual([null, `user-resecret:${state.sha}`]);
			expect(String(warn.mock.calls[0]![0])).toContain(`is not the verified copy's (${state.fingerprint})`);
		},
		SLOW_MS,
	);

	it(
		"refuses a copy that answers differently, keeping the fork's current copy",
		async () => {
			const fleet = p.t.fleet;
			const current = { epoch: 1, sha: p.heads["user-reflective"]!, fingerprint: "a1b2c3d4", namesHash: "0badc0de" };
			fleet.setMorph("user-reflective", current, { from: null }, t0);
			const result = await rotateFork(p.deps, "user-reflective", "tripwire");
			if (result.outcome !== "refused") throw new Error(`expected a refusal, got ${result.outcome}`);
			expect([result.repo, result.reason, result.epoch, result.sha]).toEqual(["user-reflective", "tripwire", 2, p.heads["user-reflective"]]);
			expect(result.failures).toHaveLength(10);
			expect(result.failures.filter((failure) => failure.probe === "polymorph-equivalence").length).toBeGreaterThan(0);
			expect(result.more).toBeGreaterThan(0);
			expect(JSON.stringify(result)).not.toMatch(/\$[0-9a-z]{8}/);
			expect(fleet.morphState("user-reflective")).toEqual({ ...current, at: iso(t0) });
			expect(fleet.securityEvents("user-reflective").map((event) => [event.kind, event.detail])).toEqual([["rotation_refused", { reason: "tripwire", epoch: 2, failures: result.failures.length + result.more }]]);
		},
		SLOW_MS,
	);

	it("skips every fork when the platform has no secret, without running a gate", async () => {
		const built = p.loader.built.length;
		expect(await rotateFork(p.withoutSecret(), "user-1", "schedule")).toEqual({ outcome: "skipped", repo: "user-1", reason: "schedule", why: "POLYMORPH_SECRET is not set or is shorter than 16 characters" });
		expect(p.loader.built.length).toBe(built);
	});

	it("says the same when the secret is too short to count, without running a gate", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const built = p.loader.built.length;
		const short = { ...p.deps, env: { ...p.t.env, POLYMORPH_SECRET: "too-short-02" } as unknown as Env };
		expect(await rotateFork(short, "user-1", "schedule")).toEqual({ outcome: "skipped", repo: "user-1", reason: "schedule", why: "POLYMORPH_SECRET is not set or is shorter than 16 characters" });
		expect(p.loader.built.length).toBe(built);
	});

	it.each(["provisioning", "upgrading", "gating"] as const)("skips a fork that is %s, without running a gate", async (status) => {
		p.t.fleet.update("user-busy", { status });
		const built = p.loader.built.length;
		expect(await rotateFork(p.deps, "user-busy", "schedule")).toEqual({ outcome: "skipped", repo: "user-busy", reason: "schedule", why: `the fork is ${status}` });
		expect(p.loader.built.length).toBe(built);
		expect(p.t.fleet.morphState("user-busy")).toBeNull();
	});

	it("skips a repo that is not in the fleet", async () => {
		expect(await rotateFork(p.deps, "user-unknown", "admin")).toEqual({ outcome: "skipped", repo: "user-unknown", reason: "admin", why: "the fork is not in the fleet" });
	});

	it(
		"skips a fork when the gate could make no renamed copy, keeping its state",
		async () => {
			vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const result = await rotateFork(p.deps, "user-big", "schedule");
			expect(result).toMatchObject({ outcome: "skipped", repo: "user-big", reason: "schedule" });
			expect((result as { why: string }).why).toMatch(/no renamed copy/);
			expect(p.t.fleet.morphState("user-big")).toBeNull();
			expect(p.t.fleet.securityEvents("user-big")).toEqual([]);
		},
		SLOW_MS,
	);

	it(
		"skips with the loader's reason when the gate could make no renamed copy",
		async () => {
			vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const result = await rotateFork(p.deps, "user-big", "tripwire");
			expect(result).toMatchObject({ outcome: "skipped", repo: "user-big", reason: "tripwire" });
			expect((result as { why: string }).why).toMatch(/^the gate made no renamed copy of main: app\/big\.js: polymorph: the module has \d+ characters, more than/);
		},
		SLOW_MS,
	);

	it(
		"throws when Artifacts failed to read what the copy needs, so a workflow step retries it, and stores nothing",
		async () => {
			vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const git = p.t.artifacts.repos.get("user-flaky")!.git;
			const read = git.readFile.bind(git);
			// Only the copy reads the fork's end-to-end scenarios (as part of its contract); the gate itself does not.
			vi.spyOn(git, "readFile").mockImplementation(async (args: { ref: string; path: string }) => {
				if (args.path === "tests/user/e2e.json") throw new Error("Artifacts: 503 service unavailable");
				return read(args);
			});
			const failure = await rotateFork(p.deps, "user-flaky", "schedule").catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(PolymorphTransientError);
			expect((failure as Error).message).toMatch(/Artifacts: 503 service unavailable$/);
			expect(p.t.fleet.morphState("user-flaky")).toBeNull();
			expect(p.t.fleet.securityEvents("user-flaky")).toEqual([]);
		},
		SLOW_MS,
	);

	/** The copy a rotation would have stored for a fork at epoch 1, stored as if a gate had verified it. */
	async function storeVerified(repo: string) {
		const state = { epoch: 1, sha: p.heads[repo]!, fingerprint: await printOf(repo, 1), namesHash: await namesHash(LISTED) };
		if (!p.t.fleet.setMorph(repo, state, { from: null }, t0)) throw new Error(`${repo}: no copy stored`);
		return state;
	}

	it(
		"clears a stored copy that no longer builds when a mismatch rotation cannot replace it, and records that quietly",
		async () => {
			vi.spyOn(console, "warn").mockImplementation(() => undefined);
			await storeVerified("user-outgrown");
			const result = await rotateFork(p.deps, "user-outgrown", "mismatch");
			expect(result).toMatchObject({ outcome: "skipped", reason: "mismatch", cleared: true });
			expect(p.t.fleet.morphState("user-outgrown")).toBeNull();
			const events = p.t.fleet.securityEvents("user-outgrown");
			expect(events.map((event) => [event.kind, event.detail?.epoch, event.detail?.cause])).toEqual([["copy_cleared", 1, "unavailable"]]);
			expect(String(events[0]!.detail?.why)).toMatch(/app\/big\.js: polymorph: the module has \d+ characters/);
		},
		SLOW_MS,
	);

	it(
		"keeps a stored copy that no longer builds when the rotation is for any other reason",
		async () => {
			vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const state = await storeVerified("user-outgrown-2");
			for (const reason of ["schedule", "tripwire", "landed", "admin", "install"] as const) {
				expect(await rotateFork(p.deps, "user-outgrown-2", reason)).not.toHaveProperty("cleared");
			}
			expect(p.t.fleet.morphState("user-outgrown-2")).toEqual({ ...state, at: iso(t0) });
			expect(p.t.fleet.securityEvents("user-outgrown-2")).toEqual([]);
		},
		SLOW_MS,
	);

	it(
		"keeps a stored copy that still builds when a mismatch rotation skips because the fork is busy",
		async () => {
			const state = await storeVerified("user-stale-busy");
			p.t.fleet.update("user-stale-busy", { status: "gating" });
			const result = await rotateFork(p.deps, "user-stale-busy", "mismatch");
			expect(result).toMatchObject({ outcome: "skipped", repo: "user-stale-busy", reason: "mismatch", why: "the fork is gating" });
			expect(result).not.toHaveProperty("cleared");
			expect(p.t.fleet.morphState("user-stale-busy")).toEqual({ ...state, at: iso(t0) });
			expect(p.t.fleet.securityEvents("user-stale-busy")).toEqual([]);
		},
		SLOW_MS,
	);
});

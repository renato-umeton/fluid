// Rotation moves a fork to its next renamed copy only after a check mode gate
// shows that copy answers every probe like the plain fork; otherwise the fork
// keeps the copy it has. Gates run through the platform's own code on
// in-memory repos and a fake Worker Loader, so the timeouts leave room for a
// loaded machine.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { deriveSeed, fingerprint, namesHash } from "../src/polymorph/names.ts";
import { rotateFork } from "../src/polymorph/rotate.ts";
import { SCAN_LIMITS } from "../src/polymorph/tokens.ts";
import { loadForkRuntime } from "../src/runtime/loader.ts";
import { LISTED, POLYMORPH_TEST_SECRET, PUBLISHED, REFLECTIVE, TAG, polymorphPlatform, type PolymorphPlatform } from "./helpers/polymorph-platform.ts";

const SLOW_MS = 120_000;
const t0 = Date.parse("2026-11-06T10:00:00Z");
const iso = (at: number) => new Date(at).toISOString();

let p: PolymorphPlatform;

beforeAll(() => {
	p = polymorphPlatform({
		"user-1": PUBLISHED,
		"user-reflective": REFLECTIVE,
		"user-busy": { ...PUBLISHED, "app/busy.ts": "export const busy = 1;\n" },
		// More JavaScript in one module than the renamer reads: the plain fork runs, no copy can be made.
		"user-big": { ...PUBLISHED, "app/big.js": `// ${"x".repeat(SCAN_LIMITS.moduleChars)}\nexport const big = 1;\n` },
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
			const loaded = await loadForkRuntime(p.deps, "user-1", "main", { morph: { epoch: state.epoch, onlyAt: state.sha, namesHash: state.namesHash } });
			expect(loaded.morph?.fingerprint).toBe(state.fingerprint);
		},
		SLOW_MS,
	);

	it(
		"refuses a copy that answers differently, keeping the fork's current copy",
		async () => {
			const fleet = p.t.fleet;
			const current = { epoch: 1, sha: p.heads["user-reflective"]!, fingerprint: "a1b2c3d4", namesHash: "0badc0de" };
			fleet.setMorph("user-reflective", current, t0);
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
		expect(await rotateFork(p.withoutSecret(), "user-1", "schedule")).toEqual({ outcome: "skipped", repo: "user-1", reason: "schedule", why: "POLYMORPH_SECRET is not set" });
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
});

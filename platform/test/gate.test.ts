import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import synthetic from "../src/generated/synthetic.json";
import { capFailures, clipValue, emptyUserTier, gateBrief, prepareUserManifest, summarizeTier, verdict, type GateFailure, type RunnerManifestResult } from "../src/gate/tiers.ts";
import { setTomlValue } from "../src/lib/toml.ts";
import { APP_MODULE, ENTRY_MODULE, RUNNER_ENTRY_MODULE, buildModuleMap, buildRunnerModuleMap } from "../src/runtime/modules.ts";
import { materialize } from "./helpers/materialize.ts";

const files = stockSource.files as Record<string, string>;
const here = dirname(fileURLToPath(import.meta.url));
const forkDir = join(here, ".tmp-gate-fork");
const runnerDir = join(here, ".tmp-gate-runner");

type Runner = { runManifest(options: Record<string, unknown>): Promise<RunnerManifestResult> };
type App = { default: { ask(req: unknown, env: unknown): Promise<unknown> } };

let runner: Runner;
let app: App["default"];

beforeAll(async () => {
	app = (await materialize<App>(buildModuleMap(files), forkDir, APP_MODULE, [ENTRY_MODULE])).default;
	runner = await materialize<Runner>(buildRunnerModuleMap(files), runnerDir, "tests/runner.js", [RUNNER_ENTRY_MODULE]);
});
afterAll(() => {
	rmSync(forkDir, { recursive: true, force: true });
	rmSync(runnerDir, { recursive: true, force: true });
});

const invariants = JSON.parse(files["tests/invariants/manifest.json"]!);
const askVia = { ask: (req: unknown) => app.ask(req, { data: synthetic, fluidToml: files["fluid.toml"] }) };

async function runInvariants(fluidToml: string) {
	return runner.runManifest({ app: askVia, manifest: invariants, forkFiles: { "fluid.toml": fluidToml }, env: {}, samples: 1 });
}

describe("tier 1 through the stock runner", () => {
	it("passes stock as published", async () => {
		const result = await runInvariants(files["fluid.toml"]!);
		const { summary, failures } = summarizeTier("invariant", result);
		expect(summary.passed).toBe(true);
		expect(failures).toEqual([]);
	});

	it("fails a lowered tau on inv-tau-config-floor with the probe details", async () => {
		const result = await runInvariants(setTomlValue(files["fluid.toml"]!, "thresholds", "tau", 0.6));
		const { summary, failures } = summarizeTier("invariant", result);
		expect(summary.passed).toBe(false);
		expect(failures).toContainEqual(expect.objectContaining({ tier: "invariant", probe: "inv-tau-config-floor", path: "thresholds.tau", op: "gte", expected: 0.85, actual: 0.6, sample: 1 }));
	});

	it("passes a raised tau", async () => {
		const { summary } = summarizeTier("invariant", await runInvariants(setTomlValue(files["fluid.toml"]!, "thresholds", "tau", 0.92)));
		expect(summary.passed).toBe(true);
	});
});

describe("prepareUserManifest", () => {
	it("forces the user tier and drops disabled probes with a log entry", () => {
		const prepared = prepareUserManifest(
			JSON.stringify({ tier: "invariant", probes: [{ id: "a", request: { question: "q", context: {} }, assert: [{ path: "mode", exists: true }], intentId: "int_1" }, { id: "b", disabled: true, disabledReason: "flaky", assert: [] }] }),
		);
		expect(prepared.manifest?.tier).toBe("user");
		expect(prepared.manifest?.probes.map((p) => p.id)).toEqual(["a"]);
		expect(prepared.manifest?.probes[0]).not.toHaveProperty("intentId");
		expect(prepared.disabled).toEqual([{ id: "b", reason: "flaky" }]);
	});

	it("returns no manifest when the fork has no user tests", () => {
		expect(prepareUserManifest(null)).toEqual({ manifest: null, disabled: [] });
	});

	it("reports invalid JSON", () => {
		expect(prepareUserManifest("{").error).toMatch(/invalid JSON/);
	});

	it("treats a manifest where every probe is disabled as nothing to run", () => {
		const prepared = prepareUserManifest(JSON.stringify({ probes: [{ id: "x", disabled: true }] }));
		expect(prepared.manifest).toBeNull();
		expect(emptyUserTier(prepared.disabled)).toMatchObject({ passed: true, total: 0, disabled: [{ id: "x" }] });
	});
});

describe("verdict", () => {
	const pass = { tier: "invariant" as const, passed: true, total: 1, failed: 0, probes: [] };
	it("passes when every tier passed", () => {
		expect(verdict({ invariant: pass, functional: { ...pass, tier: "functional" }, user: null }, [])).toBe(true);
	});
	it("fails when tier 2 failed", () => {
		expect(verdict({ invariant: pass, functional: { ...pass, tier: "functional", passed: false }, user: null }, [])).toBe(false);
	});
	it("fails when tier 1 never ran", () => {
		expect(verdict({ invariant: null, functional: { ...pass, tier: "functional" }, user: null }, [])).toBe(false);
	});
	it("fails a user tier failure", () => {
		expect(verdict({ invariant: pass, functional: { ...pass, tier: "functional" }, user: { ...pass, tier: "user", passed: false } }, [])).toBe(false);
	});
});

describe("failure shaping", () => {
	it("numbers samples from 1 and keeps only failing probes", () => {
		const { failures } = summarizeTier("functional", {
			tier: "functional",
			passed: true,
			total: 2,
			failed: 0,
			probes: [
				{ id: "ok-majority", passed: true, samples: 3, passedSamples: 2, failures: [{ sample: 2, path: "mode", op: "equals", expected: "research", actual: "multi" }] },
				{ id: "bad", passed: false, samples: 3, passedSamples: 0, failures: [{ sample: 0, path: "mode", op: "equals", expected: "a", actual: "b" }] },
			],
		});
		expect(failures).toEqual([{ tier: "functional", probe: "bad", sample: 1, samples: 3, path: "mode", op: "equals", expected: "a", actual: "b" }]);
	});

	it("clips large values and caps the list", () => {
		expect(String(clipValue("x".repeat(1000)))).toMatch(/1000 chars/);
		const many = Array.from({ length: 100 }, (_, i) => ({ probe: `p${i}` }) as GateFailure);
		expect(capFailures(many)).toHaveLength(40);
	});

	it("summarizes the first failure for the fleet entry", () => {
		const brief = gateBrief({
			repo: "user-x", ref: "work/a", commit: "c", stockTag: "v1.1.0", stockCommit: "s", at: "", passed: false, durationMs: 1,
			tiers: { invariant: null, functional: null, user: null },
			failures: [{ tier: "invariant", probe: "inv-tau-config-floor", sample: 1, samples: 1, path: "thresholds.tau", op: "gte", expected: 0.85, actual: 0.6 }],
		});
		expect(brief.firstFailure).toBe("invariant: inv-tau-config-floor (thresholds.tau gte)");
	});
});

import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import { buildE2ERunnerModuleMap, E2E_RUNNER_ENTRY_MODULE } from "../src/runtime/modules.ts";
import { configResult } from "../src/yellow/run.ts";
import { e2eFailures, failureRetryable, PLATFORM_SCENARIOS, prepareE2ETiers, runRetryable, stockManifestOf, tierLine, USER_E2E_LIMITS, type E2ETierResult } from "../src/yellow/tiers.ts";
import { materialize } from "./helpers/materialize.ts";
import app from "../../stock/app/index.ts";
import synthetic from "../src/generated/synthetic.json";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, ".tmp-e2e-runner");
type Runner = { runScenarios: (o: unknown) => Promise<E2ETierResult>; validateE2EManifest: (m: unknown) => void };
let runner: Runner;

beforeAll(async () => {
	runner = await materialize<Runner>(buildE2ERunnerModuleMap(stockSource.files as Record<string, string>), dir, "tests/e2e/runner.js", [E2E_RUNNER_ENTRY_MODULE]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const stockManifest = stockManifestOf((stockSource.files as Record<string, string>)["tests/e2e/manifest.json"] ?? null)!;
const user = (scenarios: unknown[]) => JSON.stringify({ suite: "e2e", scenarios });
const scenario = (id: string, extra: Record<string, unknown> = {}) => ({ id, steps: [{ id: "i", kind: "intents", assert: [{ path: "count", gte: 1 }] }], ...extra });

describe("e2e tier merge", () => {
	it("runs the stock suite when the pinned tag has one", () => {
		const prepared = prepareE2ETiers({ stock: stockManifest, userText: null });
		expect(prepared.tiers.map((t) => t.tier)).toEqual(["stock"]);
	});

	it("runs the basic platform scenarios when the pinned tag has no stock suite", () => {
		expect(stockManifestOf(null)).toBeNull();
		expect(stockManifestOf(JSON.stringify({ suite: "e2e", scenarios: [] }))).toBeNull();
		const prepared = prepareE2ETiers({ stock: null, userText: null });
		expect(prepared.tiers).toEqual([{ tier: "platform", manifest: PLATFORM_SCENARIOS }]);
	});

	it("adds the fork's own scenarios as the user tier", () => {
		const prepared = prepareE2ETiers({ stock: stockManifest, userText: user([scenario("t-int_1-e2e-redcap")]) });
		expect(prepared.tiers.map((t) => t.tier)).toEqual(["stock", "user"]);
		expect(prepared.tiers[1]!.manifest.scenarios.map((s) => s.id)).toEqual(["t-int_1-e2e-redcap"]);
	});

	it("never lets a user scenario replace a stock or platform scenario id", () => {
		const prepared = prepareE2ETiers({ stock: stockManifest, userText: user([scenario("e2e-clinical-contract", { steps: [] }), scenario("platform-clinical-contract"), scenario("mine")]) });
		expect(prepared.tiers[0]!.manifest).toBe(stockManifest);
		expect(prepared.tiers[1]!.manifest.scenarios.map((s) => s.id)).toEqual(["mine"]);
		expect(prepared.user.rejected.map((r) => r.id)).toEqual(["e2e-clinical-contract", "platform-clinical-contract"]);
		expect(prepared.user.rejected[0]!.reason).toMatch(/stock scenario id/);
	});

	it("skips and logs disabled user scenarios", () => {
		const prepared = prepareE2ETiers({ stock: null, userText: user([scenario("off", { disabled: true, disabledReason: "flaky on Fridays" }), scenario("on", { intentId: "int_1" })]) });
		expect(prepared.user.disabled).toEqual([{ id: "off", reason: "flaky on Fridays" }]);
		expect(prepared.tiers[1]!.manifest.scenarios).toEqual([scenario("on")]);
	});

	it("caps the user tier and reports a file that does not parse", () => {
		const many = Array.from({ length: USER_E2E_LIMITS.maxScenarios + 3 }, (_, i) => scenario(`s${i}`));
		expect(prepareE2ETiers({ stock: null, userText: user(many) }).user.dropped).toBe(3);
		expect(prepareE2ETiers({ stock: null, userText: "{oops" }).user.error).toMatch(/invalid JSON/);
		expect(prepareE2ETiers({ stock: null, userText: "{}" }).user.error).toMatch(/scenarios must be an array/);
	});
});

describe("platform scenarios", () => {
	it("are valid for the stock runner and pass against stock", async () => {
		expect(() => runner.validateE2EManifest(PLATFORM_SCENARIOS)).not.toThrow();
		const records = new Map<string, Record<string, unknown>>();
		const toml = 'stock_tag = "v1.5.0"\n[thresholds]\ntau = 0.85\n';
		const live = { commit: "f".repeat(40), stockTag: "v1.5.0" };
		const host = {
			ask: async (request: unknown) => {
				const card = await app.ask(request as never, { fluidToml: toml, forkCommit: live.commit, data: synthetic as never });
				records.set(card.ledger.answer_id, { ...card.ledger });
				return JSON.parse(JSON.stringify(card));
			},
			override: async (id: string, mode: string) => (records.has(id) ? (records.set(id, { ...records.get(id), override: mode }), records.get(id)) : null),
			ledger: async (id: string) => records.get(id) ?? null,
			intents: async () => [{ id: "int_1", files: [] }],
			config: async (file: string) => configResult(file, file === "fluid.toml" ? toml : null),
			connectors: async () => ["fhir"],
		};
		const result = await runner.runScenarios({ manifest: PLATFORM_SCENARIOS, host, live, tier: "platform" });
		expect(result.scenarios.filter((s) => !s.passed)).toEqual([]);
	});
});

describe("config checks", () => {
	it("validate fluid.toml and ui/preferences.json the way the platform reads them", () => {
		expect(configResult("fluid.toml", 'stock_tag = "v1.5.0"\n[thresholds]\ntau = 0.9\n')).toMatchObject({ present: true, valid: true });
		expect(configResult("fluid.toml", 'stock_tag = "v1.5.0"\n[thresholds]\ntau = 0.5\n')).toMatchObject({ valid: false, errors: [expect.stringMatching(/tau/)] });
		expect(configResult("fluid.toml", null)).toMatchObject({ present: false, valid: false });
		expect(configResult("ui/preferences.json", null)).toMatchObject({ present: false, valid: true });
		expect(configResult("ui/preferences.json", '{"font":"comic"}')).toMatchObject({ present: true, valid: false });
	});
});

describe("e2e failures", () => {
	const tier: E2ETierResult = {
		tier: "stock", passed: false, total: 2, failed: 1, skipped: 0,
		scenarios: [
			{ id: "ok", passed: true, durationMs: 1, steps: [] },
			{ id: "e2e-ledger-provenance", description: "provenance", passed: false, failedStep: "ask", durationMs: 2, steps: [{ id: "ask", kind: "ask", passed: false, latencyMs: 3, failures: [{ path: "ledger.fork_commit", op: "equals", expected: "abc", actual: "build-cache" }] }] },
		],
	};

	it("name the failing scenario and step", () => {
		expect(e2eFailures([tier])).toEqual([{ tier: "stock", scenario: "e2e-ledger-provenance", step: "ask", description: "provenance", path: "ledger.fork_commit", op: "equals", expected: "abc", actual: "build-cache" }]);
		expect(tierLine(tier)).toBe("1 / 2 scenarios passed; failing: e2e-ledger-provenance at ask");
	});

	it("report a user manifest that could not run", () => {
		expect(e2eFailures([{ tier: "user", passed: false, total: 0, failed: 1, skipped: 0, scenarios: [], error: "bad" }])[0]).toMatchObject({ scenario: "user-e2e-manifest-valid", actual: "bad" });
	});
});

describe("retryable failures", () => {
	const failingTier = (failures: Record<string, unknown>[], kind = "ask"): E2ETierResult => ({
		tier: "stock", passed: false, total: 1, failed: 1, skipped: 0,
		scenarios: [{ id: "s", passed: false, failedStep: "a", durationMs: 1, steps: [{ id: "a", kind, passed: false, latencyMs: 1, failures: failures as never }] }],
	});

	it("keeps the runner's own retryable mark", () => {
		expect(runRetryable([failingTier([{ path: "", op: "ask", expected: "no error", actual: "x", retryable: true }])])).toBe(true);
		expect(e2eFailures([failingTier([{ path: "", op: "ask", expected: "no error", actual: "x", retryable: true }])])[0]!.retryable).toBe(true);
	});

	it("infers it for runners published before the mark: host errors, timeouts, and latency are retryable", () => {
		expect(failureRetryable({ path: "", op: "ask", expected: "no error", actual: "Network connection lost" })).toBe(true);
		expect(failureRetryable({ path: "", op: "timeout", expected: "answer within 15000 ms", actual: "no answer" })).toBe(true);
		expect(failureRetryable({ path: "latencyMs", op: "latency", expected: "at most 8000 ms", actual: 9100 })).toBe(true);
	});

	it("never retries an assertion on the fork's output or an error the fork caused", () => {
		expect(failureRetryable({ path: "ledger.fork_commit", op: "equals", expected: "abc", actual: "build-cache" })).toBe(false);
		expect(failureRetryable({ path: "", op: "ask", expected: "no error", actual: "fork error: TypeError: x is undefined" })).toBe(false);
		expect(failureRetryable({ path: "", op: "ask", expected: "no error", actual: "boom", retryable: false })).toBe(false);
	});

	it("a run is retryable only when every failing step failed for a retryable reason", () => {
		const infra = failingTier([{ path: "", op: "ask", expected: "no error", actual: "Network connection lost" }]);
		const fork = failingTier([{ path: "mode", op: "equals", expected: "clinical", actual: "research" }]);
		expect(runRetryable([infra])).toBe(true);
		expect(runRetryable([infra, fork])).toBe(false);
		expect(runRetryable([failingTier([{ path: "", op: "ask", expected: "no error", actual: "x" }, { path: "mode", op: "equals", expected: "a", actual: "b" }])])).toBe(false);
		expect(runRetryable([{ tier: "user", passed: false, total: 0, failed: 1, skipped: 0, scenarios: [], error: "bad manifest" }])).toBe(false);
		expect(runRetryable([{ ...infra, passed: true, failed: 0, scenarios: [] }])).toBe(false);
	});
});

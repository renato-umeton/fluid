// The stock end-to-end suite against real fork code: seeded customizations
// must stay green after a release lands them, the admin-only test recipe must
// pass tiers 1 to 3 and still fail end to end, and suggested user scenarios
// must pass on the change they were suggested for.
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import synthetic from "../src/generated/synthetic.json";
import { protocolsFor, redcapChange, tauChange } from "../src/agents/recipes.ts";
import { mergeUserE2E, suggestScenarios } from "../src/agents/suggester.ts";
import { breakLedgerCommitChange, BROKEN_FORK_COMMIT, isAdminTestRequest, matchAdminTestRecipe } from "../src/agents/test-recipe.ts";
import { uiChange } from "../src/agents/ui-recipe.ts";
import { seedChange, type SeedKind } from "../src/fleet/seed-catalog.ts";
import { summarizeTier, type RunnerManifestResult } from "../src/gate/tiers.ts";
import { APP_MODULE, E2E_RUNNER_ENTRY_MODULE, ENTRY_MODULE, RUNNER_ENTRY_MODULE, buildE2ERunnerModuleMap, buildModuleMap, buildRunnerModuleMap } from "../src/runtime/modules.ts";
import { configResult } from "../src/yellow/run.ts";
import { prepareE2ETiers, stockManifestOf, type E2ETierResult } from "../src/yellow/tiers.ts";
import { materialize } from "./helpers/materialize.ts";

const files = stockSource.files as Record<string, string>;
const here = dirname(fileURLToPath(import.meta.url));
const stockE2E = stockManifestOf(files["tests/e2e/manifest.json"] ?? null)!;
const protocols = protocolsFor(synthetic.personas, "research-coordinator");
const LIVE = { commit: "1".repeat(40), stockTag: "v1.0.0" };

type E2ERunner = { runScenarios(options: Record<string, unknown>): Promise<E2ETierResult>; validateE2EManifest(m: unknown): void };
type ProbeRunner = { runManifest(options: Record<string, unknown>): Promise<RunnerManifestResult> };
let e2e: E2ERunner;
let probes: ProbeRunner;
let counter = 0;
const dirs: string[] = [];

beforeAll(async () => {
	const a = join(here, ".tmp-yellow-e2e-runner");
	const b = join(here, ".tmp-yellow-probe-runner");
	dirs.push(a, b);
	e2e = await materialize<E2ERunner>(buildE2ERunnerModuleMap(files), a, "tests/e2e/runner.js", [E2E_RUNNER_ENTRY_MODULE]);
	probes = await materialize<ProbeRunner>(buildRunnerModuleMap(files), b, "tests/runner.js", [RUNNER_ENTRY_MODULE]);
});
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function forkApp(forkFiles: Record<string, string>) {
	const dir = join(here, `.tmp-yellow-fork-${counter++}`);
	dirs.push(dir);
	const mod = await materialize<{ default: { ask(req: unknown, env: unknown): Promise<Record<string, unknown>> } }>(buildModuleMap(forkFiles), dir, APP_MODULE, [ENTRY_MODULE]);
	return { ask: (req: unknown) => mod.default.ask(req, { data: synthetic, fluidToml: forkFiles["fluid.toml"], forkCommit: LIVE.commit }) };
}

/** A host like the platform's: the fork's app, an in-memory ledger for the test user, and the platform's config checks. */
async function hostFor(forkFiles: Record<string, string>) {
	const app = await forkApp(forkFiles);
	const records = new Map<string, Record<string, unknown>>();
	return {
		ask: async (request: unknown) => {
			const card = await app.ask(request);
			const ledger = card.ledger as Record<string, unknown>;
			records.set(ledger.answer_id as string, { ...ledger });
			return JSON.parse(JSON.stringify(card));
		},
		override: async (id: string, mode: string) => {
			const record = records.get(id);
			if (!record) return null;
			records.set(id, { ...record, override: mode });
			return records.get(id);
		},
		ledger: async (id: string) => records.get(id) ?? null,
		intents: async () => [{ id: "int_onboarding", files: ["fluid.toml"] }],
		config: async (file: string) => configResult(file, forkFiles[file] ?? null),
		connectors: async () => Object.keys(forkFiles).filter((p) => /^connectors\/[^/]+\.ts$/.test(p)).map((p) => p.slice(11, -3)).filter((n) => n !== "types"),
	};
}

async function runTiers(forkFiles: Record<string, string>, userText: string | null = null) {
	const host = await hostFor(forkFiles);
	const prepared = prepareE2ETiers({ stock: stockE2E, userText });
	const out: E2ETierResult[] = [];
	for (const { tier, manifest } of prepared.tiers) out.push(await e2e.runScenarios({ manifest, host, live: LIVE, tier }));
	return out;
}

const failing = (tiers: E2ETierResult[]) => tiers.flatMap((t) => t.scenarios.filter((s) => !s.passed).map((s) => `${t.tier}:${s.id}@${s.failedStep}`));

describe("stock e2e suite on seeded customizations", () => {
	const kinds: Exclude<SeedKind, "none" | "lower-tau">[] = ["redcap", "budget-summary", "plain-wording", "raise-tau", "compact-research"];
	it.each(kinds)("%s stays green", async (kind) => {
		const change = seedChange(kind, files, { personas: synthetic.personas, persona: "research-coordinator" });
		expect(failing(await runTiers({ ...files, ...change.files }))).toEqual([]);
	});

	it("runs the REDCap scenario when the fork has the connector, and skips it on stock", async () => {
		const redcap = await runTiers({ ...files, ...redcapChange({ indexSource: files["app/index.ts"]!, protocols }).files });
		expect(redcap[0]!.scenarios.find((s) => s.id === "e2e-redcap-enrollment")).toMatchObject({ passed: true });
		expect(redcap[0]!.scenarios.find((s) => s.id === "e2e-redcap-enrollment")?.skipped).toBeUndefined();
		const stock = await runTiers(files);
		expect(stock[0]!.scenarios.find((s) => s.id === "e2e-redcap-enrollment")?.skipped).toMatch(/no redcap connector/);
	});
});

describe("admin-only test recipe", () => {
	it("is recognized only with its marker", () => {
		expect(isAdminTestRequest("[admin test] break ledger fork_commit")).toBe(true);
		expect(matchAdminTestRecipe("[admin test] break ledger fork_commit")).toBe("break-ledger-commit");
		expect(matchAdminTestRecipe("break ledger fork_commit")).toBeNull();
		expect(isAdminTestRequest("Add a REDCap connector")).toBe(false);
	});

	it("passes tiers 1 and 2 but fails the end-to-end suite on ledger provenance", async () => {
		const change = breakLedgerCommitChange(files["app/index.ts"]!);
		const fork = { ...files, ...change.files };
		const app = await forkApp(fork);
		const run = (manifest: unknown) => probes.runManifest({ app, manifest, forkFiles: { "fluid.toml": fork["fluid.toml"] }, env: {}, samples: 1 });
		expect(summarizeTier("invariant", await run(JSON.parse(files["tests/invariants/manifest.json"]!))).failures).toEqual([]);
		expect(summarizeTier("functional", await run(JSON.parse(files["tests/functional/manifest.json"]!))).failures).toEqual([]);
		const tiers = await runTiers(fork);
		expect(failing(tiers)).toEqual(expect.arrayContaining(["stock:e2e-ledger-provenance@ask", "stock:e2e-override-writes-ledger@record"]));
		const provenance = tiers[0]!.scenarios.find((s) => s.id === "e2e-ledger-provenance")!;
		expect(provenance.steps[0]!.failures[0]).toMatchObject({ path: "ledger.fork_commit", expected: LIVE.commit, actual: BROKEN_FORK_COMMIT });
	});
});

describe("suggested user scenarios", () => {
	it("REDCap: research enrollment, then an override to clinical that leaks nothing", async () => {
		const change = redcapChange({ indexSource: files["app/index.ts"]!, protocols });
		const suggestions = suggestScenarios({ change, intentId: "int_rc", invariants: null, protocols });
		expect(suggestions.map((s) => [s.id, s.kind, s.file])).toEqual([["t-int_rc-e2e-redcap-no-leak", "e2e", "tests/user/e2e.json"]]);
		const scenarios = suggestions.map((s) => ({ ...s.scenario!, intentId: "int_rc" }));
		const userText = mergeUserE2E(null, scenarios);
		expect(() => e2e.validateE2EManifest(JSON.parse(userText))).not.toThrow();
		const tiers = await runTiers({ ...files, ...change.files }, userText);
		expect(tiers.map((t) => t.tier)).toEqual(["stock", "user"]);
		expect(failing(tiers)).toEqual([]);
	});

	it("REDCap scenario catches enrollment leaking into a clinical answer", async () => {
		const change = redcapChange({ indexSource: files["app/index.ts"]!, protocols });
		const leaky = change.files["connectors/redcap.ts"]!.replace('if (card.mode === "research") return addEnrollment(card, list);', "return addEnrollment(card, list);");
		expect(leaky).not.toBe(change.files["connectors/redcap.ts"]);
		const userText = mergeUserE2E(null, suggestScenarios({ change, intentId: "int_rc", invariants: null, protocols }).map((s) => s.scenario!));
		const tiers = await runTiers({ ...files, ...change.files, "connectors/redcap.ts": leaky }, userText);
		expect(failing(tiers)).toContain("user:t-int_rc-e2e-redcap-no-leak@to-clinical");
	});

	it("UI preferences and raised tau get scenarios that pass on the change", async () => {
		const ui = uiChange(null, "Use Palatino fonts and add a tab with charts");
		const tau = tauChange(files["fluid.toml"]!, { kind: "tau", value: 0.9, direction: "raise" });
		for (const [change, extra] of [[ui, {}], [tau, { tau: 0.9 }]] as const) {
			const suggestions = suggestScenarios({ change, intentId: "int_s", invariants: null, ...extra });
			expect(suggestions).toHaveLength(1);
			const userText = mergeUserE2E(null, suggestions.map((s) => s.scenario!));
			expect(failing(await runTiers({ ...files, ...change.files }, userText))).toEqual([]);
		}
	});

	it("never overwrites another intent's scenario", () => {
		const first = mergeUserE2E(null, [{ id: "t-a-e2e-x", steps: [], intentId: "int_a" }]);
		expect(() => mergeUserE2E(first, [{ id: "t-a-e2e-x", steps: [], intentId: "int_b" }])).toThrow(/belongs to int_a/);
		expect(JSON.parse(mergeUserE2E(first, [{ id: "t-a-e2e-x", steps: [{ id: "s" }], intentId: "int_a" }])).scenarios).toHaveLength(1);
	});
});

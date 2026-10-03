import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import synthetic from "../src/generated/synthetic.json";
import { clusterRecords, eligibility, forksIn, proposalOf, deterministicLabel, type HarvestRecord } from "../src/agents/harvest-cluster.ts";
import { buildIntent, cleanText, slugify } from "../src/agents/intent.ts";
import { diffEntries, lineStats } from "../src/agents/diff.ts";
import { matchRecipe, protocolsFor, redcapChange, replanOnMovedMain, tauChange, tauTarget } from "../src/agents/recipes.ts";
import { planRepair } from "../src/agents/repair-plan.ts";
import { fallbackSuggestion, mergeUserManifest, suggestionsFromModel, suggestTests, touchedAreas, validateProbe } from "../src/agents/suggester.ts";
import { requestFor, seedChange, seedPlan, type SeedKind } from "../src/fleet/seed-catalog.ts";
import type { BuildTimeIntent } from "../src/forks/provision.ts";
import { summarizeTier, type RunnerManifestResult } from "../src/gate/tiers.ts";
import { APP_MODULE, ENTRY_MODULE, RUNNER_ENTRY_MODULE, buildModuleMap, buildRunnerModuleMap } from "../src/runtime/modules.ts";
import { materialize } from "./helpers/materialize.ts";

const files = stockSource.files as Record<string, string>;
const here = dirname(fileURLToPath(import.meta.url));
const invariants = JSON.parse(files["tests/invariants/manifest.json"]!);
const functional = JSON.parse(files["tests/functional/manifest.json"]!);
const protocols = protocolsFor(synthetic.personas, "research-coordinator");

type Runner = { runManifest(options: Record<string, unknown>): Promise<RunnerManifestResult> };
let runner: Runner;
let counter = 0;
const dirs: string[] = [];

beforeAll(async () => {
	const dir = join(here, ".tmp-agents-runner");
	dirs.push(dir);
	runner = await materialize<Runner>(buildRunnerModuleMap(files), dir, "tests/runner.js", [RUNNER_ENTRY_MODULE]);
});
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function forkApp(forkFiles: Record<string, string>) {
	const dir = join(here, `.tmp-agents-fork-${counter++}`);
	dirs.push(dir);
	const mod = await materialize<{ default: { ask(req: unknown, env: unknown): Promise<Record<string, unknown>> } }>(buildModuleMap(forkFiles), dir, APP_MODULE, [ENTRY_MODULE]);
	return { ask: (req: unknown) => mod.default.ask(req, { data: synthetic, fluidToml: forkFiles["fluid.toml"] }) };
}

async function gateTiers(forkFiles: Record<string, string>, userProbes: unknown[] = []) {
	const app = await forkApp(forkFiles);
	const run = (manifest: unknown, tier?: string) => runner.runManifest({ app, manifest, forkFiles: { "fluid.toml": forkFiles["fluid.toml"] }, env: {}, samples: 1, ...(tier ? { tier } : {}) });
	const inv = summarizeTier("invariant", await run(invariants));
	const fn = summarizeTier("functional", await run(functional));
	const user = userProbes.length ? summarizeTier("user", await run({ tier: "user", probes: userProbes }, "user")) : null;
	return { inv, fn, user, app };
}

describe("matchRecipe", () => {
	it.each([
		["Add a REDCap connector so research mode reports enrollment for my protocols", { kind: "redcap" }],
		["Lower my confidence threshold to 0.6", { kind: "tau", value: 0.6, direction: "lower" }],
		["lower my tau to .7", { kind: "tau", value: 0.7, direction: "lower" }],
		["Raise my confidence threshold to 0.9", { kind: "tau", value: 0.9, direction: "raise" }],
		["Make research answers shorter", null],
	])("%s", (request, expected) => {
		expect(matchRecipe(request)).toEqual(expected);
	});

	it("raises tau by a step when no number is given", () => {
		expect(tauTarget({ kind: "tau", value: Number.NaN, direction: "raise" }, 0.85)).toBe(0.9);
	});
});

describe("recipes through the stock gate", () => {
	it("REDCap: passes tiers 1 and 2, answers enrollment, and its suggested tests pass", async () => {
		const change = redcapChange({ indexSource: files["app/index.ts"]!, protocols });
		const fork = { ...files, ...change.files };
		const suggestions = suggestTests({ change, intentId: "int_x", invariants, protocols });
		expect(suggestions.map((s) => s.id)).toEqual(["t-int_x-redcap-enrollment-irb-2026-0142", "t-int_x-redcap-enrollment-irb-2026-0219", "t-int_x-redcap-clinical-untouched"]);
		expect(suggestions.every((s) => s.intentId === "int_x" && validateProbe(s.probe) === null)).toBe(true);
		const { inv, fn, user, app } = await gateTiers(fork, suggestions.map((s) => s.probe));
		expect(inv.failures).toEqual([]);
		expect(fn.failures).toEqual([]);
		expect(user?.failures).toEqual([]);
		const card = await app.ask({ question: "How many participants are enrolled in IRB-2026-0142?", context: {}, explicitMode: "research" });
		expect(card.enrollment).toEqual([expect.objectContaining({ protocolId: "IRB-2026-0142", enrolled: 67, target: 120 })]);
	});

	it("lower tau: fails inv-tau-config-floor and the suggester adds probes near the tau invariants", async () => {
		const change = tauChange(files["fluid.toml"]!, { kind: "tau", value: 0.6, direction: "lower" });
		const suggestions = suggestTests({ change, intentId: "int_t", invariants, previousToml: files["fluid.toml"] });
		expect(suggestions.length).toBeGreaterThan(0);
		expect(suggestions.every((s) => s.kind === "near-invariant" && s.id.startsWith("near-int_t-inv-tau"))).toBe(true);
		const { inv } = await gateTiers({ ...files, ...change.files });
		expect(inv.failures).toContainEqual(expect.objectContaining({ probe: "inv-tau-config-floor", actual: 0.6, expected: 0.85 }));
	});

	it("raise tau: passes", async () => {
		const change = tauChange(files["fluid.toml"]!, { kind: "tau", value: 0.9, direction: "raise" });
		const suggestions = suggestTests({ change, intentId: "int_r", invariants, previousToml: files["fluid.toml"] });
		const { inv, fn, user } = await gateTiers({ ...files, ...change.files }, suggestions.map((s) => s.probe));
		expect([inv.summary.passed, fn.summary.passed, user?.summary.passed ?? true]).toEqual([true, true, true]);
	});
});

describe("seeded customizations", () => {
	const cases: [SeedKind, boolean][] = [
		["redcap", true],
		["budget-summary", true],
		["plain-wording", true],
		["raise-tau", true],
		["lower-tau", false],
		["clinical-dose", false],
	];
	it.each(cases)("%s passes the floor: %s", async (kind, passes) => {
		const change = seedChange(kind as Exclude<SeedKind, "none">, files, { personas: synthetic.personas, persona: "department-administrator" });
		const { inv, fn } = await gateTiers({ ...files, ...change.files });
		expect(inv.summary.passed && fn.summary.passed).toBe(passes);
	});

	it("plans a mix with a few failing forks", () => {
		const plan = seedPlan("t1", 200);
		const count = (k: SeedKind) => plan.filter((s) => s.kinds.includes(k)).length;
		expect(plan).toHaveLength(200);
		expect(count("lower-tau") + count("clinical-dose")).toBeLessThanOrEqual(12);
		expect(count("lower-tau")).toBeGreaterThan(0);
		expect(count("plain-wording")).toBeGreaterThan(10);
		expect(count("redcap")).toBeGreaterThan(20);
		expect(new Set(plan.map((s) => s.userId)).size).toBe(200);
		expect(seedPlan("t1", 30).filter((s) => s.kinds.includes("lower-tau") || s.kinds.includes("clinical-dose"))).toHaveLength(2);
	});
});

describe("suggester details", () => {
	it("detects threshold changes, not unrelated toml edits", () => {
		const toml = files["fluid.toml"]!;
		expect(touchedAreas({ "fluid.toml": toml.replace("auto_upgrade = false", "auto_upgrade = true") }, toml).tau).toBe(false);
		expect(touchedAreas({ "intent/classifier.ts": "x" }, toml).intent).toBe(true);
	});

	it("keeps only valid model probes", () => {
		const out = suggestionsFromModel({ suggestions: [{ title: "ok", question: "q?", assert: [{ path: "mode", equals: "research" }] }, { title: "bad", question: "q?", assert: [{ path: "mode", bogus: 1 }] }] }, "int_m");
		expect(out.map((s) => s.title)).toEqual(["ok"]);
		expect(validateProbe(fallbackSuggestion("int_m", ["research"]).probe)).toBeNull();
	});

	it("namespaces every suggested test id by its intent", () => {
		const model = suggestionsFromModel({ suggestions: [{ title: "ok", question: "q?", assert: [{ path: "mode", equals: "research" }] }] }, "int_m");
		expect(model.map((s) => s.id)).toEqual(["t-int_m-agent-1"]);
		expect(fallbackSuggestion("int_m", ["research"]).id).toBe("t-int_m-card-contract");
		expect(model[0]!.probe.id).toBe(model[0]!.id);
	});

	it("merges accepted probes into the user manifest by id, replacing only the same intent's probes", () => {
		const probe = (id: string, question: string, intentId: string) => ({ id, intentId, request: { question, context: {} }, assert: [{ path: "mode", exists: true }] });
		const first = mergeUserManifest(null, [probe("a", "q", "int_1")]);
		const second = JSON.parse(mergeUserManifest(first, [probe("a", "q2", "int_1"), probe("b", "q", "int_1")]));
		expect(second.tier).toBe("user");
		expect(second.probes.map((p: { id: string }) => p.id)).toEqual(["a", "b"]);
		expect(second.probes[0].request.question).toBe("q2");
	});

	it("refuses to overwrite a probe that belongs to another intent or to the user", () => {
		const probe = (id: string, intentId?: string) => ({ id, ...(intentId ? { intentId } : {}), request: { question: "q", context: {} }, assert: [{ path: "mode", exists: true }] });
		const existing = mergeUserManifest(null, [probe("a", "int_1")]);
		expect(() => mergeUserManifest(existing, [probe("a", "int_2")])).toThrow(/belongs to int_1/);
		const handWritten = JSON.stringify({ tier: "user", probes: [probe("mine")] });
		expect(() => mergeUserManifest(handWritten, [probe("mine", "int_2")])).toThrow(/belongs to the user/);
	});

	it("keeps a disabled probe disabled when other probes are added", () => {
		const existing = JSON.stringify({ tier: "user", probes: [{ ...{ id: "old", intentId: "int_0", request: { question: "q", context: {} }, assert: [{ path: "mode", exists: true }] }, disabled: true, disabledReason: "flaky" }] });
		const merged = JSON.parse(mergeUserManifest(existing, [{ id: "new", intentId: "int_1", request: { question: "q", context: {} }, assert: [{ path: "mode", exists: true }] }]));
		expect(merged.probes[0]).toMatchObject({ id: "old", disabled: true, disabledReason: "flaky" });
	});
});

const rec = (repo: string, id: string, request: string, files: string[], agent = "seed-customization", modes = ["research"]): HarvestRecord => ({
	repo,
	intent: { id, author: "user:x", agent, request, purpose: "", modes_affected: modes, files, tests_added: [], stock_tag: "v1.1.0" },
});

describe("harvest clustering", () => {
	const records: HarvestRecord[] = [
		...[0, 1, 2, 3].map((i) => rec(`user-r${i}`, `int_${i}`, requestFor("redcap", i), ["connectors/redcap.ts", "app/index.ts"])),
		rec("user-b1", "int_b1", requestFor("budget-summary", 0), ["connectors/budget-summary.ts", "app/index.ts"], "seed-customization", ["administrative"]),
		rec("user-b2", "int_b2", requestFor("budget-summary", 1), ["connectors/budget-summary.ts", "app/index.ts"], "seed-customization", ["administrative"]),
		rec("user-t1", "int_t1", "Raise my confidence threshold to 0.9", ["fluid.toml"], "customization-agent", ["clinical", "research", "administrative"]),
		rec("user-t2", "int_t2", "Only answer in one mode when you are at least 0.9 confident", ["fluid.toml"], "seed-customization", ["clinical", "research", "administrative"]),
		rec("user-o", "int_o", "Provision a personal Fluid fork", ["fluid.toml"], "onboarding", []),
	];

	it("groups REDCap requests across wordings and ignores onboarding records", () => {
		const clusters = clusterRecords(records);
		expect(forksIn(clusters[0]!)).toEqual(["user-r0", "user-r1", "user-r2", "user-r3"]);
		expect(clusters.flatMap((c) => c.records).some((r) => r.intent.agent === "onboarding")).toBe(false);
		expect(deterministicLabel(clusters[0]!).toLowerCase()).toContain("redcap");
	});

	it("drafts only large clusters that stay off the floor", () => {
		const clusters = clusterRecords(records);
		expect(eligibility(clusters[0]!).eligible).toBe(true);
		const tau = clusters.find((c) => c.records.some((r) => r.repo === "user-t1"))!;
		expect(eligibility(tau)).toMatchObject({ eligible: false });
		const proposal = proposalOf(clusters[0]!, "REDCap enrollment connector", null);
		expect(proposal).toMatchObject({ count: 4, slug: "redcap-enrollment-connector", proposedFiles: ["app/index.ts", "connectors/redcap.ts"], referenceFork: "user-r0" });
	});
});

describe("harvest floor files", () => {
	const cluster = (files: string[]) => clusterRecords([0, 1, 2, 3].map((i) => rec(`user-f${i}`, `int_f${i}`, "Add a shared helper for research answers", files, "customization-agent", ["research"])))[0]!;

	it.each([["app/toml.ts"], ["app/types.ts"], ["tests/runner.ts"], ["tests/invariants/manifest.json"], ["policies/research.ts"], ["intent/classifier.ts"], ["fluid.toml"]])("never drafts a cluster that touches %s", (path) => {
		expect(eligibility(cluster(["connectors/helper.ts", path]))).toMatchObject({ eligible: false });
	});

	it("still drafts ordinary connector clusters", () => {
		expect(eligibility(cluster(["connectors/helper.ts", "app/index.ts"])).eligible).toBe(true);
	});
});

describe("repair planning", () => {
	const intents: BuildTimeIntent[] = [
		{ id: "int_tau", author: "user:x", agent: "customization-agent", request: "Lower my threshold to 0.6", purpose: "p", modes_affected: [], files: ["fluid.toml"], tests_added: [], stock_tag: "v1.1.0" },
		{ id: "int_dose", author: "user:x", agent: "seed-customization", request: "Quick dose", purpose: "Clinical dosing cards show a quick number", modes_affected: ["clinical"], files: ["policies/quick-dose.ts", "app/index.ts"], tests_added: [], stock_tag: "v1.1.0" },
	];
	const gate = (failures: unknown[]) => ({ failures, stockTag: "v1.1.0", ref: "work/x", commit: "c".repeat(40) }) as never;

	it("restores tau to the stock minimum and cites the intent that lowered it", () => {
		const plan = planRepair({ gate: gate([{ tier: "invariant", probe: "inv-tau-config-floor", sample: 1, samples: 1, path: "thresholds.tau", op: "gte", expected: 0.85, actual: 0.6 }]), intents, fluidToml: 'stock_tag = "v1.1.0"\n[thresholds]\ntau = 0.6\n', stockMinTau: 0.85, stockVersions: {} });
		expect(plan.rule).toBe("restore-tau");
		expect(plan.files["fluid.toml"]).toContain("tau = 0.85");
		expect(plan.intentRefs).toEqual(["int_tau"]);
	});

	it("reverts the files of a customization that broke the clinical floor", () => {
		const plan = planRepair({
			gate: gate([{ tier: "invariant", probe: "inv-chart-open-dosing-clinical", sample: 1, samples: 5, path: "computed_dose", op: "equals", expected: null, actual: { value: 7 } }]),
			intents,
			fluidToml: "",
			stockMinTau: 0.85,
			stockVersions: { "policies/quick-dose.ts": null, "app/index.ts": "stock index" },
		});
		expect(plan.rule).toBe("revert-customization");
		expect(plan.files).toEqual({ "policies/quick-dose.ts": null, "app/index.ts": "stock index" });
		expect(plan.intentRefs).toContain("int_dose");
	});

	it("explains without a fix when no rule applies", () => {
		const plan = planRepair({ gate: gate([{ tier: "user", probe: "t-mine", sample: 1, samples: 3, path: "body", op: "contains", expected: "x", actual: "y" }]), intents, fluidToml: "", stockMinTau: 0.85, stockVersions: {} });
		expect(plan.rule).toBe("none");
		expect(plan.fixSummary).toBeNull();
		expect(plan.explanation).toContain("t-mine");
	});
});

describe("intent records and diffs", () => {
	it("strips control characters and bounds the request", () => {
		expect(cleanText("a\u0000b\nc\u2028d", 100)).toBe("a b c d");
		const intent = buildIntent({ id: "int_1", userId: "u", agent: "customization-agent", request: "x".repeat(900), purpose: "p", modes: ["research", "bogus"], files: ["b", "a", "a"], stockTag: "v1.1.0" });
		expect(intent.request).toHaveLength(500);
		expect(intent.modes_affected).toEqual(["research"]);
		expect(intent.files).toEqual(["a", "b"]);
	});

	it("slugs requests for branch names", () => {
		expect(slugify("Add a REDCap connector so research mode reports enrollment!")).toBe("add-a-redcap-connector-so-research");
		expect(slugify("!!!")).toBe("change");
	});

	it("counts changed lines", () => {
		expect(lineStats("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({ additions: 2, deletions: 1 });
		expect(diffEntries({ x: "1\n", y: null }, { x: "1\n2\n", y: "new\n" }).map((d) => [d.path, d.status])).toEqual([["x", "modified"], ["y", "added"]]);
	});
});

describe("replanOnMovedMain", () => {
	const toml = files["fluid.toml"]!;
	const tau = tauChange(toml, { kind: "tau", value: 0.9, direction: "raise" });

	it("keeps the planned files when main did not touch them", () => {
		const result = replanOnMovedMain({ change: tau, request: "Raise my confidence threshold to 0.9", before: { "fluid.toml": toml }, current: { "fluid.toml": toml }, protocols });
		expect(result).toEqual({ files: tau.files, replanned: [] });
	});

	it("reapplies a recipe on main's current files instead of writing over them", () => {
		const moved = toml.replace("auto_upgrade = false", "auto_upgrade = true");
		const result = replanOnMovedMain({ change: tau, request: "Raise my confidence threshold to 0.9", before: { "fluid.toml": toml }, current: { "fluid.toml": moved }, protocols });
		expect("files" in result && result.files["fluid.toml"]).toContain("auto_upgrade = true");
		expect("files" in result && result.files["fluid.toml"]).toMatch(/tau = 0\.9/);
		expect("files" in result && result.replanned).toEqual(["fluid.toml"]);
	});

	it("refuses a model plan whose files changed on main", () => {
		const change = { summary: "s", purpose: "p", modes_affected: [], files: { "app/index.ts": "x" }, notes: {}, recipe: "model" as const };
		const result = replanOnMovedMain({ change, request: "r", before: { "app/index.ts": "a" }, current: { "app/index.ts": "b" }, protocols });
		expect(result).toEqual({ error: expect.stringContaining("app/index.ts") });
	});
});

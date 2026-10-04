import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import { evaluate, mergeUserResults, runUiConfigProbes, splitUserManifest, uiInvariant, UI_INVARIANT_ID } from "../src/gate/ui-check.ts";
import { prepareUserManifest } from "../src/gate/tiers.ts";
import { buildRunnerModuleMap, RUNNER_ENTRY_MODULE } from "../src/runtime/modules.ts";
import { materialize } from "./helpers/materialize.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, ".tmp-ui-gate-runner");
let stockEvaluate: (a: unknown, t: unknown, p: string) => unknown[];

beforeAll(async () => {
	const runner = await materialize<{ evaluate: typeof stockEvaluate }>(buildRunnerModuleMap(stockSource.files as Record<string, string>), dir, "tests/runner.js", [RUNNER_ENTRY_MODULE]);
	stockEvaluate = runner.evaluate;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const prefs = JSON.stringify({ font: "palatino", tabs: [{ title: "Charts", widgets: ["override-rate", "gate-history"] }] });
const probe = { id: "t-int_1-ui-preferences", kind: "config", file: "ui/preferences.json", assert: [{ path: "font", equals: "palatino" }, { path: "tabs", some: { path: "title", equals: "Charts" } }] };

describe("uiInvariant (tier 1, platform)", () => {
	it("is absent when the fork has no ui/preferences.json", () => {
		expect(uiInvariant(null)).toBeNull();
	});

	it("passes valid preferences", () => {
		expect(uiInvariant(prefs)).toEqual({ probe: { id: UI_INVARIANT_ID, passed: true, samples: 1, passedSamples: 1 }, failure: null });
	});

	it("fails invalid preferences with a clear probe failure", () => {
		const out = uiInvariant(JSON.stringify({ font: "Comic Sans", onload: "x" }))!;
		expect(out.probe.passed).toBe(false);
		expect(out.failure).toMatchObject({ tier: "invariant", probe: UI_INVARIANT_ID, file: "ui/preferences.json", op: "schema", expected: "valid UI preferences" });
		expect(String(out.failure!.actual)).toContain('unknown key "onload"');
		expect(String(out.failure!.actual)).toContain("font must be one of");
	});

	it("fails a file that is not JSON", () => {
		expect(String(uiInvariant("font = palatino")!.failure!.actual)).toContain("not valid JSON");
	});
});

describe("tier 3 config probes on ui/preferences.json (platform)", () => {
	it("splits them out of the manifest stock's runner sees", () => {
		const user = prepareUserManifest(JSON.stringify({ tier: "user", probes: [probe, { id: "ask", request: { question: "q", context: {} }, assert: [{ path: "mode", exists: true }] }] }));
		const split = splitUserManifest(user.manifest);
		expect(split.platform.map((p) => p.id)).toEqual([probe.id]);
		expect(split.runner!.probes.map((p) => p.id)).toEqual(["ask"]);
	});

	it("leaves no runner manifest when every probe is a ui probe", () => {
		const user = prepareUserManifest(JSON.stringify({ tier: "user", probes: [probe] }));
		expect(splitUserManifest(user.manifest).runner).toBeNull();
	});

	it("passes when the preferences hold", () => {
		const [r] = runUiConfigProbes([probe], prefs, 3);
		expect(r).toMatchObject({ id: probe.id, passed: true, samples: 3, passedSamples: 3, failures: [] });
	});

	it("fails with the path and values when a preference changed", () => {
		const [r] = runUiConfigProbes([probe], JSON.stringify({ font: "georgia" }));
		expect(r!.passed).toBe(false);
		expect(r!.failures).toEqual([
			{ path: "font", op: "equals", expected: "palatino", actual: "georgia", sample: 0 },
			{ path: "tabs", op: "some", expected: "an array", actual: undefined, sample: 0 },
		]);
	});

	it("fails when the file is missing", () => {
		expect(runUiConfigProbes([probe], null)[0]!.failures[0]!.actual).toContain("missing");
	});

	it("merges into one user tier result", () => {
		const platform = runUiConfigProbes([probe], prefs);
		const merged = mergeUserResults({ tier: "user", passed: false, total: 1, failed: 1, probes: [{ id: "ask", passed: false, samples: 1, passedSamples: 0, failures: [] }] }, platform);
		expect(merged).toMatchObject({ tier: "user", passed: false, total: 2, failed: 1 });
		expect(mergeUserResults(null, platform)).toMatchObject({ passed: true, total: 1, failed: 0 });
		expect(mergeUserResults(null, [])).toBeNull();
	});

	it.each([
		[{ path: "font", equals: "palatino" }],
		[{ path: "font", notEquals: "palatino" }],
		[{ path: "tabs", length_gte: 2 }],
		[{ path: "tabs", every: { path: "widgets", length_gte: 1 } }],
		[{ path: "tabs", some: { path: "widgets", contains: "gate-history" } }],
		[{ path: "accent", exists: false }],
		[{ path: "font", notMatches: "/comic/i" }],
		[{ path: "tabs.0.title", contains: "Chart" }],
	])("matches stock's runner semantics for %j", (assertion) => {
		const target = JSON.parse(prefs);
		expect(evaluate(assertion, target, "")).toEqual(stockEvaluate(assertion, target, ""));
	});
});

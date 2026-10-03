import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import synthetic from "../src/generated/synthetic.json";
import { APP_MODULE, ENTRY_MODULE, RUNNER_ENTRY_MODULE, buildModuleMap, buildRunnerModuleMap, entrySource, isRuntimePath, moduleName, transformTs } from "../src/runtime/modules.ts";

const files = stockSource.files as Record<string, string>;

describe("isRuntimePath", () => {
	it.each([
		["app/index.ts", true],
		["policies/registry.json", true],
		["connectors/redcap.js", true],
		["tests/runner.ts", false],
		["tests/user/manifest.json", false],
		["app/types.d.ts", false],
		["tests/invariants/manifest.json", false],
		["fluid.toml", false],
		[".intent/int_1.json", false],
		["app/index.test.ts", false],
		["README.md", false],
	])("%s -> %s", (path, expected) => {
		expect(isRuntimePath(path)).toBe(expected);
	});
});

describe("transformTs", () => {
	it("strips types and type-only imports but keeps ES imports and extensions", () => {
		const out = transformTs(
			'import { a, type B } from "./a.js";\nimport type { C } from "./c.js";\nexport const x: number = a as number;\nexport type { B };\nexport interface I { y: C }\n',
			"m.ts",
		);
		expect(out).toContain('import { a, } from "./a.js"');
		expect(out).not.toContain("./c.js");
		expect(out).not.toContain("interface");
		expect(out).toContain("export const x = a");
	});

	it("names the file when the source does not parse", () => {
		expect(() => transformTs("export const = ;", "app/broken.ts")).toThrow(/app\/broken\.ts/);
	});
});

describe("buildModuleMap", () => {
	const map = buildModuleMap(files);

	it("maps every runtime .ts file to a .js module", () => {
		expect(map.modules["intent/classifier.js"]).toHaveProperty("js");
		expect(map.modules["intent/classifier.ts"]).toBeUndefined();
	});

	it("maps JSON files to json modules", () => {
		expect(map.modules["policies/registry.json"]).toHaveProperty("json");
	});

	it("leaves out test manifests and configuration", () => {
		expect(Object.keys(map.modules).some((name) => name.startsWith("tests/invariants") || name === "fluid.toml")).toBe(false);
	});

	it("never includes the runner in a fork runtime", () => {
		expect(map.mainModule).toBe(ENTRY_MODULE);
		expect(map.modules["tests/runner.js"]).toBeUndefined();
		expect((map.modules[ENTRY_MODULE] as { js: string }).js).not.toContain("runner");
	});

	it("rejects a fork with no app entry", () => {
		expect(() => buildModuleMap({ "intent/x.ts": "export {}" })).toThrow(/no app\/index/);
	});

	it("rejects two files claiming the same module name", () => {
		expect(() => buildModuleMap({ "app/index.ts": "export default {}", "app/index.js": "export default {}" })).toThrow(/both/);
	});

	it("reports invalid JSON with its path", () => {
		expect(() => buildModuleMap({ "app/index.ts": "export default {}", "policies/x.json": "{" })).toThrow(/policies\/x\.json/);
	});

	it("only hands the model hook to the fork when the call asks for it", () => {
		expect(entrySource()).toContain("options.useModel && env.LLM");
		expect(moduleName(APP_MODULE)).toBe(APP_MODULE);
	});
});

describe("buildRunnerModuleMap", () => {
	it("builds the runner isolate from stock's runner, toml, and types only", () => {
		const runner = buildRunnerModuleMap(files);
		expect(runner.mainModule).toBe(RUNNER_ENTRY_MODULE);
		expect(Object.keys(runner.modules).sort()).toEqual(["app/toml.js", "app/types.js", RUNNER_ENTRY_MODULE, "tests/runner.js"].sort());
	});

	it("ignores fork files even when they are passed in", () => {
		const runner = buildRunnerModuleMap({ ...files, "app/index.ts": "globalThis.JSON = null;", "connectors/evil.ts": "x" });
		expect(runner.modules["app/index.js"]).toBeUndefined();
		expect(runner.modules["connectors/evil.js"]).toBeUndefined();
	});

	it("fails when stock lacks a runner dependency", () => {
		const { ["app/toml.ts"]: _toml, ...rest } = files;
		expect(() => buildRunnerModuleMap(rest)).toThrow(/app\/toml\.ts/);
	});
});

// The transformed modules must behave exactly like the TypeScript source:
// write them out and run the spec section 2 dosing scenarios through them.
describe("transformed stock runtime", () => {
	const outDir = join(dirname(fileURLToPath(import.meta.url)), ".tmp-modules");
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	async function loadTransformedApp() {
		rmSync(outDir, { recursive: true, force: true });
		const map = buildModuleMap(files);
		for (const [name, module] of Object.entries(map.modules)) {
			if (name === ENTRY_MODULE) continue;
			const target = join(outDir, name);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, "js" in module ? module.js : JSON.stringify(module.json));
		}
		return (await import(/* @vite-ignore */ join(outDir, APP_MODULE))).default as {
			ask(req: unknown, env: unknown): Promise<{ mode: string; computed_dose: unknown; sources: unknown[] }>;
		};
	}

	const question = "What is the right dose of Morphinex for a patient of 70 kg and 45 years?";

	it("answers in clinical mode with no dose when a chart is open", async () => {
		const app = await loadTransformedApp();
		const card = await app.ask(
			{ question, context: { chartOpen: { patientId: "synthetic_patient_117", identified: true }, onService: true } },
			{ data: synthetic, forkCommit: "abc1234", fluidToml: files["fluid.toml"] },
		);
		expect({ mode: card.mode, dose: card.computed_dose }).toEqual({ mode: "clinical", dose: null });
	});

	it("answers in research mode with a dose and two or more sources with a manuscript open", async () => {
		const app = await loadTransformedApp();
		const card = await app.ask(
			{ question, context: { documentType: "manuscript", onService: false, screenLabel: { label: "manuscript_editor", confidence: 0.9 } } },
			{ data: synthetic, forkCommit: "abc1234", fluidToml: files["fluid.toml"] },
		);
		expect(card.mode).toBe("research");
		expect(card.computed_dose).toMatchObject({ value: 7, unit: "mg" });
		expect(card.sources.length).toBeGreaterThanOrEqual(2);
	});
});

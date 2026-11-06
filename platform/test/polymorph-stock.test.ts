// Every polymorphic copy of stock must answer every probe exactly like plain
// stock. Renames stock's module map under five seeds, runs the invariant and
// functional suites through the stock runner with an ask that sends each
// request to both the plain app and the copy, and compares every card.
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import synthetic from "../src/generated/synthetic.json";
import type { RunnerManifestResult } from "../src/gate/tiers.ts";
import { cardDifferences, type CardDifference } from "../src/polymorph/equivalence.ts";
import { POLYMORPH_LIST_PATH, parsePolymorphList } from "../src/polymorph/list.ts";
import { morphModuleMap } from "../src/polymorph/morph.ts";
import { deriveSeed, variantNames } from "../src/polymorph/names.ts";
import { scanTokens } from "../src/polymorph/tokens.ts";
import { APP_MODULE, ENTRY_MODULE, RUNNER_ENTRY_MODULE, buildModuleMap, buildRunnerModuleMap, type ModuleMap } from "../src/runtime/modules.ts";
import { materialize } from "./helpers/materialize.ts";

const files = stockSource.files as Record<string, string>;
const here = dirname(fileURLToPath(import.meta.url));
const listed = parsePolymorphList(files[POLYMORPH_LIST_PATH]!);
const SECRET = "polymorph-stock-test-secret-0123";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const EPOCHS = [0, 1, 2, 3, 4];

type App = { ask(request: unknown, env: unknown): Promise<unknown> };
type Runner = { runManifest(options: Record<string, unknown>): Promise<RunnerManifestResult> };
type Copy = { epoch: number; variants: Map<string, string>; map: ModuleMap; app: App };

const env = { data: synthetic, fluidToml: files["fluid.toml"] };
const manifests = {
	invariant: JSON.parse(files["tests/invariants/manifest.json"]!),
	functional: JSON.parse(files["tests/functional/manifest.json"]!),
};
const plainMap = buildModuleMap(files);
const dirs: string[] = [];
const copies: Copy[] = [];
let plainApp: App;
let runner: Runner;

async function loadApp(map: ModuleMap, name: string): Promise<App> {
	const dir = join(here, name);
	dirs.push(dir);
	return (await materialize<{ default: App }>(map, dir, APP_MODULE, [ENTRY_MODULE])).default;
}

beforeAll(async () => {
	plainApp = await loadApp(plainMap, ".tmp-polymorph-plain");
	const runnerDir = join(here, ".tmp-polymorph-runner");
	dirs.push(runnerDir);
	runner = await materialize<Runner>(buildRunnerModuleMap(files), runnerDir, "tests/runner.js", [RUNNER_ENTRY_MODULE]);
	for (const epoch of EPOCHS) {
		const variants = await variantNames(await deriveSeed(SECRET, "user-ada", SHA, epoch), listed);
		const map = morphModuleMap(plainMap, variants);
		copies.push({ epoch, variants, map, app: await loadApp(map, `.tmp-polymorph-copy-${epoch}`) });
	}
});
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Answers are deterministic without a model, so one sample per probe is enough. */
function run(manifest: unknown, ask: (request: unknown) => Promise<unknown>): Promise<RunnerManifestResult> {
	return runner.runManifest({ app: { ask }, manifest, forkFiles: { "fluid.toml": files["fluid.toml"] }, env: {}, samples: 1 });
}

/** Sends each request to plain stock and to the copy at once, records any difference, and answers with the copy's card. */
function dualAsk(copy: Copy, found: { request: unknown; differences: CardDifference[] }[]) {
	return async (request: unknown) => {
		const [plainCard, copyCard] = await Promise.all([plainApp.ask(request, env), copy.app.ask(request, env)]);
		const differences = cardDifferences(plainCard, copyCard);
		if (differences.length > 0) found.push({ request, differences });
		return copyCard;
	};
}

/** Identifier names used across a module map's JS modules, the generated entry aside. */
function identifiersOf(map: ModuleMap): Set<string> {
	const names = new Set<string>();
	for (const [path, module] of Object.entries(map.modules)) {
		if (path === ENTRY_MODULE || !("js" in module)) continue;
		for (const token of scanTokens(module.js).identifiers) names.add(token.text);
	}
	return names;
}

const sourceOf = (map: ModuleMap) =>
	Object.entries(map.modules)
		.map(([path, module]) => `${path}\n${"js" in module ? module.js : JSON.stringify(module.json)}`)
		.join("\n");

describe("polymorphic copies of stock", () => {
	it.each(["invariant", "functional"] as const)("answer every %s probe exactly like plain stock, under five seeds", async (tier) => {
		const plainResult = await run(manifests[tier], (request) => plainApp.ask(request, env));
		expect(plainResult.passed).toBe(true);
		expect(plainResult.total).toBe(manifests[tier].probes.length);
		for (const copy of copies) {
			const found: { request: unknown; differences: CardDifference[] }[] = [];
			const copyResult = await run(manifests[tier], dualAsk(copy, found));
			expect({ epoch: copy.epoch, found }).toEqual({ epoch: copy.epoch, found: [] });
			expect(cardDifferences(plainResult, copyResult)).toEqual([]);
		}
	});

	it("use every listed name in stock's JavaScript, so every one is renamed", () => {
		const plainIdentifiers = identifiersOf(plainMap);
		expect(listed.filter((name) => !plainIdentifiers.has(name))).toEqual([]);
	});

	it("carry the renamed names and none of the original listed names as identifiers", () => {
		for (const copy of copies) {
			const identifiers = identifiersOf(copy.map);
			expect(listed.filter((name) => identifiers.has(name))).toEqual([]);
			expect([...copy.variants.values()].filter((variant) => !identifiers.has(variant))).toEqual([]);
		}
	});

	it("keep the generated entry and the JSON modules as they are", () => {
		for (const copy of copies) {
			expect(copy.map.modules[ENTRY_MODULE]).toEqual(plainMap.modules[ENTRY_MODULE]);
			for (const [path, module] of Object.entries(plainMap.modules)) if ("json" in module) expect(copy.map.modules[path]).toEqual(module);
		}
	});

	it("differ from plain stock and from each other", () => {
		const sources = [plainMap, ...copies.map((copy) => copy.map)].map(sourceOf);
		expect(new Set(sources).size).toBe(sources.length);
	});
});

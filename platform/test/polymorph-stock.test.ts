// Every polymorphic copy of stock must answer every probe exactly like plain
// stock. Takes names the way the loader will (variantNames, then morphFork)
// under five seeds, runs the invariant and functional
// suites through the stock runner with an ask that sends each request to both
// the plain app and the copy, and compares every card. A fork that reads one
// listed name by string key loses only that name and still answers the same.
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import synthetic from "../src/generated/synthetic.json";
import type { RunnerManifestResult } from "../src/gate/tiers.ts";
import { cardDifferences, type CardDifference } from "../src/polymorph/equivalence.ts";
import { POLYMORPH_LIST_PATH, parsePolymorphList, type SkippedName } from "../src/polymorph/list.ts";
import { morphFork, morphModuleMap } from "../src/polymorph/morph.ts";
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
// Writing nine module maps to disk and running both suites six times takes
// about a second alone, but much longer while other work holds the disk.
const SLOW_MS = 60_000;

type App = { ask(request: unknown, env: unknown): Promise<unknown> };
type Runner = { runManifest(options: Record<string, unknown>): Promise<RunnerManifestResult> };
type Copy = { usable: Map<string, string>; skipped: SkippedName[]; map: ModuleMap; app: App };
type Found = { request: unknown; differences: CardDifference[] }[];

const env = { data: synthetic, fluidToml: files["fluid.toml"] };
const manifests = {
	invariant: JSON.parse(files["tests/invariants/manifest.json"]!),
	functional: JSON.parse(files["tests/functional/manifest.json"]!),
};
const TIERS = ["invariant", "functional"] as const;
const plainMap = buildModuleMap(files);

// A fork that reads one listed property by string key. Renaming that property
// would leave the read pointing at the old name, so the copy must keep it.
const keyedFiles = { ...files, "intent/classifier.ts": files["intent/classifier.ts"]!.replace("signal.evidence[mode]", 'signal["evidence"][mode]') };
const keyedMap = buildModuleMap(keyedFiles);

const dirs: string[] = [];
const copies: Copy[] = [];
let plainApp: App;
let keyedApp: App;
let keyedCopy: Copy;
let runner: Runner;

async function loadApp(map: ModuleMap, name: string): Promise<App> {
	const dir = join(here, name);
	dirs.push(dir);
	return (await materialize<{ default: App }>(map, dir, APP_MODULE, [ENTRY_MODULE])).default;
}

/** The loader's way: names for this copy, then one morphFork that renames what it can and says what it skipped. */
async function makeCopy(map: ModuleMap, epoch: number, dir: string): Promise<Copy> {
	const { map: morphed, usable, skipped } = morphFork(map, await variantNames(await deriveSeed(SECRET, "user-ada", SHA, epoch), listed));
	return { usable, skipped, map: morphed, app: await loadApp(morphed, dir) };
}

beforeAll(async () => {
	plainApp = await loadApp(plainMap, ".tmp-polymorph-plain");
	keyedApp = await loadApp(keyedMap, ".tmp-polymorph-keyed-plain");
	const runnerDir = join(here, ".tmp-polymorph-runner");
	dirs.push(runnerDir);
	runner = await materialize<Runner>(buildRunnerModuleMap(files), runnerDir, "tests/runner.js", [RUNNER_ENTRY_MODULE]);
	for (const epoch of EPOCHS) copies.push(await makeCopy(plainMap, epoch, `.tmp-polymorph-copy-${epoch}`));
	keyedCopy = await makeCopy(keyedMap, 0, ".tmp-polymorph-keyed-copy");
}, SLOW_MS);
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Answers are deterministic without a model, so one sample per probe is enough. */
function run(manifest: unknown, ask: (request: unknown) => Promise<unknown>): Promise<RunnerManifestResult> {
	return runner.runManifest({ app: { ask }, manifest, forkFiles: { "fluid.toml": files["fluid.toml"] }, env: {}, samples: 1 });
}

/** A card as the platform receives it: the generated entry module sends JSON.stringify(card). */
async function askAsJson(app: App, request: unknown): Promise<unknown> {
	return JSON.parse(JSON.stringify(await app.ask(request, env)));
}

/** Sends each request to the plain app and to its copy at once, records any difference, and answers with the copy's card. */
function dualAsk(plain: App, copy: App, found: Found) {
	return async (request: unknown) => {
		const [plainCard, copyCard] = await Promise.all([askAsJson(plain, request), askAsJson(copy, request)]);
		const differences = cardDifferences(plainCard, copyCard);
		if (differences.length > 0) found.push({ request, differences });
		return copyCard;
	};
}

/** Runs a suite against the plain app, then through the dual ask; returns what differed and both results. */
async function compareSuite(tier: (typeof TIERS)[number], plain: App, copy: App) {
	const plainResult = await run(manifests[tier], (request) => askAsJson(plain, request));
	const found: Found = [];
	const copyResult = await run(manifests[tier], dualAsk(plain, copy, found));
	return { plainResult, copyResult, found, resultDifferences: cardDifferences(plainResult, copyResult) };
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
	it.each(TIERS)(
		"answer every %s probe exactly like plain stock, under five seeds",
		async (tier) => {
			for (const [index, copy] of copies.entries()) {
				const { plainResult, copyResult, found, resultDifferences } = await compareSuite(tier, plainApp, copy.app);
				expect(plainResult.passed).toBe(true);
				expect(plainResult.total).toBe(manifests[tier].probes.length);
				expect(copyResult.passed).toBe(true);
				expect({ epoch: EPOCHS[index], found }).toEqual({ epoch: EPOCHS[index], found: [] });
				expect(resultDifferences).toEqual([]);
			}
		},
		SLOW_MS,
	);

	it("skip no listed name, since stock's own text uses none of them", () => {
		for (const copy of copies) {
			expect(copy.skipped).toEqual([]);
			expect([...copy.usable.keys()]).toEqual(listed);
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
			expect([...copy.usable.values()].filter((variant) => !identifiers.has(variant))).toEqual([]);
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

describe("a polymorphic copy of a fork that reads a listed name by string key", () => {
	it("skips only that name and renames every other one", () => {
		expect(keyedFiles["intent/classifier.ts"]).toContain('signal["evidence"][mode]');
		expect(keyedCopy.skipped).toEqual([{ name: "evidence", reason: "appears in a string or template text in intent/classifier.js" }]);
		expect([...keyedCopy.usable.keys()]).toEqual(listed.filter((name) => name !== "evidence"));
		const identifiers = identifiersOf(keyedCopy.map);
		expect(identifiers.has("evidence")).toBe(true);
		expect(listed.filter((name) => name !== "evidence" && identifiers.has(name))).toEqual([]);
	});

	it.each(TIERS)(
		"answers every %s probe exactly like the plain fork",
		async (tier) => {
			const { plainResult, copyResult, found, resultDifferences } = await compareSuite(tier, keyedApp, keyedCopy.app);
			expect(plainResult.passed).toBe(true);
			expect(copyResult.passed).toBe(true);
			expect(found).toEqual([]);
			expect(resultDifferences).toEqual([]);
		},
		SLOW_MS,
	);

	it("is refused by morphModuleMap when handed every name, the skipped one included", async () => {
		const every = await variantNames(await deriveSeed(SECRET, "user-ada", SHA, 0), listed);
		expect(() => morphModuleMap(keyedMap, every)).toThrow(/"evidence": appears in a string or template text in intent\/classifier\.js/);
	});
});

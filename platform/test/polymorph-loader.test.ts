// Polymorphic copies through the platform's loader, on in-memory Artifacts
// repos and a fake Worker Loader. Stock publishes its list at the bundled
// release tag; other stock tags publish no list or a broken one. Each test
// uses its own tags or forks, since stock tags and builds are cached per tag
// and per commit for the life of this file's modules.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import { StockTagError } from "../src/gate/pins.ts";
import { setTomlValue } from "../src/lib/toml.ts";
import { cardDifferences } from "../src/polymorph/equivalence.ts";
import { loadPolymorphList, polymorphSecret } from "../src/polymorph/install.ts";
import { POLYMORPH_LIST_PATH, parsePolymorphList } from "../src/polymorph/list.ts";
import { deriveSeed, fingerprint, namesHash } from "../src/polymorph/names.ts";
import { SCAN_LIMITS } from "../src/polymorph/tokens.ts";
import { scanRequest } from "../src/polymorph/tripwire.ts";
import { askCard, askLoaded, ForkRuntimeError, loadForkRuntime, type LoadedFork, type RuntimeDeps } from "../src/runtime/loader.ts";
import { releaseMetadata, releaseMetadataPath } from "../src/stock/releases.ts";
import { apiEnv } from "./helpers/api-env.ts";
import { fakeLoader } from "./helpers/fake-loader.ts";
import type { FakeGitRepo } from "./helpers/fake-repos.ts";

const TAG = stockSource.stockTag;
const stockFiles = stockSource.files as Record<string, string>;
const listed = parsePolymorphList(stockFiles[POLYMORPH_LIST_PATH]!);
const SECRET = "polymorph-loader-test-secret-0123";
// Booting isolates writes module maps to disk; give the tests that do it room on a loaded machine.
const SLOW_MS = 60_000;

/** releases/<tag>.json, which makes a stock tag a published release. */
const release = (tag: string): Record<string, string> => ({ [releaseMetadataPath(tag)]: `${JSON.stringify(releaseMetadata({ tag, date: new Date("2026-10-04T00:00:00Z") }), null, 2)}\n` });
const published: Record<string, string> = { ...stockFiles, ...release(TAG) };
const withoutList = Object.fromEntries(Object.entries(published).filter(([path]) => path !== POLYMORPH_LIST_PATH));
/** Stock with one file patched; the anchor must still be there, so a stock change cannot quietly empty a test. */
function patched(path: string, anchor: string, replacement: string): Record<string, string> {
	const text = published[path]!;
	if (!text.includes(anchor)) throw new Error(`stock ${path} no longer contains ${JSON.stringify(anchor)}`);
	return { ...published, [path]: text.replace(anchor, replacement) };
}

// A fork that turns the decision's keys, several of them listed names, into
// card text and into an error message: in a copy, those keys are renamed.
const BUILD_CARD = "  return buildCard({ request, env, decision, classification, signals, config, answerId: newAnswerId(env) });";
const reflecting = patched(
	"app/index.ts",
	BUILD_CARD,
	[
		'  const fields = Object.keys(decision).join(", ");',
		'  if (request.question.startsWith("Which decision fields")) throw new Error("decision fields: " + fields);',
		"  const card = await buildCard({ request, env, decision, classification, signals, config, answerId: newAnswerId(env) });",
		'  return { ...card, framing: [...card.framing, "decision fields: " + fields] };',
	].join("\n"),
);

// A fork that reads a request field upstream lists, context.patient.weightKg,
// and shows it on the card. Its own tests send that field.
const weighing = patched(
	"app/index.ts",
	BUILD_CARD,
	[
		"  const card = await buildCard({ request, env, decision, classification, signals, config, answerId: newAnswerId(env) });",
		"  const patient = (request.context as { patient?: { weightKg?: unknown } }).patient;",
		'  return typeof patient?.weightKg === "number" ? { ...card, framing: [...card.framing, `Chart weight: ${patient.weightKg} kg.`] } : card;',
	].join("\n"),
);
const weighed = { question: "Is Morphinex on formulary?", context: { documentType: "budget", patient: { weightKg: 70 } } };
const weightProbe = { id: "chart-weight", request: weighed, assert: [{ path: "framing", contains: "Chart weight: 70 kg." }] };

/** The stock fork pinned to another stock release. */
const pinnedTo = (tag: string): Record<string, string> => ({ ...published, "fluid.toml": setTomlValue(published["fluid.toml"]!, null, "stock_tag", tag) });

const chart = { patientId: "synthetic_patient_117", identified: true };
const requests = {
	research: { question: "What is the right dose of Morphinex for a patient of 70 kg and 45 years?", context: { documentType: "manuscript", onService: false, screenLabel: { label: "manuscript_editor", confidence: 0.9 } } },
	heldResearch: { question: "What is the right dose of Morphinex for a patient of 70 kg and 45 years?", context: { documentType: "manuscript", chartOpen: chart } },
	clinical: { question: "What dose of Morphinex should I give this patient now?", context: { chartOpen: chart, orderEntryActive: true, onService: true } },
	administrative: { question: "Is Morphinex on formulary?", context: { documentType: "budget" } },
	unclear: { question: "What is the formulary status of Morphinex?", context: {} },
};

let t: ReturnType<typeof apiEnv>;
let loader: ReturnType<typeof fakeLoader>;
let deps: RuntimeDeps;
let stock: FakeGitRepo;
/** Commit of each fork's main. */
const heads: Record<string, string> = {};

beforeAll(() => {
	t = apiEnv();
	stock = t.artifacts.seed("stock", {
		commits: [
			published,
			{ ...withoutList, ...release("v0.9.0") },
			{ ...published, [POLYMORPH_LIST_PATH]: JSON.stringify({ version: 2, names: [] }), ...release("v0.8.0") },
			{ ...published, ...release("v1.1.0"), ...release("v1.1.1") },
		],
		tags: { [TAG]: 0, "v0.9.0": 1, "v0.8.0": 2, "v1.1.0": 3, "v1.1.1": 3 },
	});
	const forks: Record<string, Record<string, string>> = {
		"user-1": published,
		"user-old": pinnedTo("v0.9.0"),
		"user-broken": pinnedTo("v0.8.0"),
		// More JavaScript in one module than the renamer reads: V8 runs it, the renamer will not.
		"user-big": { ...published, "app/big.js": `// ${"x".repeat(SCAN_LIMITS.moduleChars)}\nexport const big = 1;\n` },
		"user-reflect": reflecting,
		"user-weight": { ...weighing, "tests/user/manifest.json": JSON.stringify({ probes: [weightProbe] }, null, 2) },
		"user-weight-untested": weighing,
		"user-weight-e2e": { ...weighing, "tests/user/e2e.json": JSON.stringify({ suite: "e2e", scenarios: [{ id: "weighed", steps: [{ op: "ask", request: weighed }] }] }) },
		"user-config": { ...published, "fluid.toml": `${published["fluid.toml"]}\n[display]\nevidence_note = "shows the evidence line"\n` },
	};
	for (const [repo, files] of Object.entries(forks)) heads[repo] = t.artifacts.seed(repo, { commits: [files] }).commits[0]!;
	loader = fakeLoader();
	Object.assign(t.env, { LOADER: loader, POLYMORPH_SECRET: SECRET });
	vi.stubGlobal("fetch", t.artifacts.fetch);
	deps = {
		env: t.env,
		exports: {
			LlmHost: () => ({
				complete: async () => {
					throw new Error("these tests never use the model");
				},
			}),
		},
	};
});

afterAll(() => {
	loader?.cleanup();
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Silences console.warn for one test and returns the spy, to read the lines the loader logged. */
function warnings() {
	return vi.spyOn(console, "warn").mockImplementation(() => undefined);
}

/** The id under which the loader runs a fork's copy for an epoch: the plain id plus "m" and the copy's fingerprint. */
async function copyId(repo: string, epoch: number, variant?: string): Promise<string> {
	const print = await fingerprint(await deriveSeed(SECRET, repo, heads[repo]!, epoch));
	return `${repo}:${heads[repo]}${variant ? `:${variant}` : ""}:m${print}`;
}

/** The loaded fork's renamed copy, failing the test when the plain fork loaded. */
function copyOf(loaded: LoadedFork): NonNullable<LoadedFork["morph"]> {
	if (loaded.morph === null) throw new Error(`${loaded.repo} loaded plain`);
	return loaded.morph;
}

describe("loadPolymorphList", () => {
	it("reads upstream's list from stock at the release tag", async () => {
		expect(await loadPolymorphList(deps.env, TAG)).toEqual(listed);
	});

	it("is null for a release that publishes no list", async () => {
		expect(await loadPolymorphList(deps.env, "v0.9.0")).toBeNull();
	});

	it("refuses a list that does not parse, naming the release", async () => {
		await expect(loadPolymorphList(deps.env, "v0.8.0")).rejects.toThrow(/^stock v0\.8\.0: polymorph\.json: version must be 1, got 2$/);
	});

	it("refuses a tag that is not a published stock release", async () => {
		await expect(loadPolymorphList(deps.env, "main")).rejects.toBeInstanceOf(StockTagError);
		await expect(loadPolymorphList(deps.env, "v9.9.9")).rejects.toBeInstanceOf(StockTagError);
	});

	it("reads each stock commit's list once, whichever tag names it", async () => {
		const reads = vi.spyOn(stock, "readFile");
		const listReads = () => reads.mock.calls.filter(([args]) => args.path === POLYMORPH_LIST_PATH).length;
		for (const tag of ["v1.1.0", "v1.1.0", "v1.1.1"]) expect(await loadPolymorphList(deps.env, tag)).toEqual(listed);
		expect(listReads()).toBe(1);
	});

	it("hands out a copy, so a caller that changes it changes no later answer", async () => {
		const first = (await loadPolymorphList(deps.env, TAG))!;
		first.splice(0, first.length, "changed");
		expect(await loadPolymorphList(deps.env, TAG)).toEqual(listed);
	});
});

describe("loadForkRuntime with a renamed copy", () => {
	it(
		"loads the copy under the fork's id plus the copy's fingerprint, and says which names it renamed",
		async () => {
			const loaded = await loadForkRuntime(deps, "user-1", "main", { morph: { epoch: 1 } });
			const copy = copyOf(loaded);
			const print = await fingerprint(await deriveSeed(SECRET, "user-1", heads["user-1"]!, 1));
			expect(loaded.isolateId).toBe(`user-1:${heads["user-1"]}:m${print}`);
			expect([copy.epoch, copy.fingerprint, copy.namesHash, copy.skipped]).toEqual([1, print, await namesHash(listed), []]);
			expect([...copy.names.keys()]).toEqual(listed);
			expect([...copy.names.values()].every((renamed, i) => renamed.startsWith(`${listed[i]}$`))).toBe(true);
			await askCard(loaded.fork, requests.administrative);
			expect(loader.built).toContain(loaded.isolateId);
		},
		SLOW_MS,
	);

	it(
		"answers every kind of question exactly like the plain fork",
		async () => {
			const plain = await loadForkRuntime(deps, "user-1", "main");
			const copy = await loadForkRuntime(deps, "user-1", "main", { morph: { epoch: 1 } });
			for (const request of Object.values(requests)) {
				expect(cardDifferences(await askCard(plain.fork, request), await askCard(copy.fork, request))).toEqual([]);
			}
		},
		SLOW_MS,
	);

	it(
		"gives each epoch its own copy and id, and reuses both within an epoch",
		async () => {
			const first = await loadForkRuntime(deps, "user-1", "main", { morph: { epoch: 2 } });
			const second = await loadForkRuntime(deps, "user-1", "main", { morph: { epoch: 3 } });
			const again = await loadForkRuntime(deps, "user-1", heads["user-1"]!, { morph: { epoch: 2 } });
			expect([first.isolateId, second.isolateId]).toEqual([await copyId("user-1", 2), await copyId("user-1", 3)]);
			expect(again.isolateId).toBe(first.isolateId);
			expect(copyOf(first).names.get("researchNeedsAttestation")).not.toBe(copyOf(second).names.get("researchNeedsAttestation"));
			for (const loaded of [first, second, again]) await askCard(loaded.fork, requests.administrative);
			expect(loader.built.filter((id) => id === first.isolateId)).toHaveLength(1);
			expect(loader.built).toContain(second.isolateId);
		},
		SLOW_MS,
	);

	it("names a variant's copy after the variant and the copy, and gives the model isolate its own id", async () => {
		const gate = await loadForkRuntime(deps, "user-1", "main", { variant: "gate-0000test", morph: { epoch: 1 } });
		const model = await loadForkRuntime(deps, "user-1", "main", { useModel: true, morph: { epoch: 1 } });
		expect(gate.isolateId).toBe(await copyId("user-1", 1, "gate-0000test"));
		expect(model.isolateId).toBe(`${await copyId("user-1", 1)}:llm`);
		const production = copyOf(await loadForkRuntime(deps, "user-1", "main", { morph: { epoch: 1 } }));
		expect(copyOf(gate).names).toEqual(production.names);
	});

	const noSecret = (): RuntimeDeps => ({ ...deps, env: { ...deps.env, POLYMORPH_SECRET: undefined } as unknown as Env });
	const plainCases: [string, string, () => Promise<LoadedFork>, RegExp][] = [
		["the platform has no secret", "user-1", () => loadForkRuntime(noSecret(), "user-1", "main", { morph: { epoch: 1 } }), /POLYMORPH_SECRET is not set/],
		["the pinned release publishes no list", "user-old", () => loadForkRuntime(deps, "user-old", "main", { morph: { epoch: 1 } }), /stock v0\.9\.0 publishes no polymorph\.json/],
		["the pinned release's list does not parse", "user-broken", () => loadForkRuntime(deps, "user-broken", "main", { morph: { epoch: 1 } }), /stock v0\.8\.0: polymorph\.json: version must be 1/],
		["the ref is not at the commit the copy is for", "user-1", () => loadForkRuntime(deps, "user-1", "main", { morph: { epoch: 1, onlyAt: "f".repeat(40) } }), /only for commit fffffff/],
		["the copy renames other names than the verified one", "user-1", () => loadForkRuntime(deps, "user-1", "main", { morph: { epoch: 1, namesHash: "00000000" } }), /other names .* than the verified copy \(00000000\)/],
		["the renamer cannot read the fork", "user-big", () => loadForkRuntime(deps, "user-big", "main", { morph: { epoch: 1 } }), /app\/big\.js: .*more than the 262144 characters/],
	];

	it.each(plainCases)(
		"loads the plain fork under today's id, logging one line, when %s",
		async (_case, repo, load, reason) => {
			const warn = warnings();
			const loaded = await load();
			expect(loaded.morph).toBeNull();
			expect(loaded.isolateId).toBe(`${repo}:${heads[repo]}`);
			expect(warn).toHaveBeenCalledTimes(1);
			const line = String(warn.mock.calls[0]![0]);
			expect(line).toMatch(new RegExp(`^polymorph: ${repo}@${heads[repo]!.slice(0, 7)} runs plain: `));
			expect(line).toMatch(reason);
			expect(line).not.toMatch(/\$[0-9a-z]{8}/);
			expect((await askCard(loaded.fork, requests.administrative)).mode).toBe("administrative");
		},
		SLOW_MS,
	);

	it("never renames a build with extra files, which only a candidate check makes", async () => {
		const warn = warnings();
		const loaded = await loadForkRuntime(deps, "user-1", "main", { extraFiles: { "app/extra.ts": "export const extra = 1;\n" }, variant: "candidate-1", morph: { epoch: 1 } });
		expect(loaded.morph).toBeNull();
		expect(loaded.isolateId).toBe(`user-1:${heads["user-1"]}:candidate-1`);
		expect(String(warn.mock.calls[0]![0])).toMatch(/runs plain: .*extra files/);
	});

	it("loads the plain fork as before when no copy is asked for, and logs nothing", async () => {
		const warn = warnings();
		const loaded = await loadForkRuntime(deps, "user-1", "main");
		expect([loaded.isolateId, loaded.morph]).toEqual([`user-1:${heads["user-1"]}`, null]);
		expect(warn).not.toHaveBeenCalled();
	});
});

describe("asking a renamed copy", () => {
	const which = { question: "Which decision fields are set?", context: {} };

	it(
		"maps the copy's names back in its card, so the card reads as the plain fork's",
		async () => {
			const plain = await loadForkRuntime(deps, "user-reflect", "main");
			const copy = await loadForkRuntime(deps, "user-reflect", "main", { morph: { epoch: 1 } });
			// What the copy itself sends: its renamed names, which must not get any further.
			expect(await copy.fork.ask(requests.heldResearch, {})).toMatch(/researchNeedsAttestation\$[0-9a-z]{8}/);
			for (const request of Object.values(requests)) {
				const card = await askLoaded(copy, request);
				expect(JSON.stringify(card)).not.toMatch(/\$[0-9a-z]{8}/);
				expect(cardDifferences(await askLoaded(plain, request), card)).toEqual([]);
			}
			expect((await askLoaded(copy, requests.heldResearch)).framing).toContainEqual(expect.stringContaining("researchNeedsAttestation"));
		},
		SLOW_MS,
	);

	it(
		"maps the copy's names back in its errors, so they read as the plain fork's",
		async () => {
			const plain = await loadForkRuntime(deps, "user-reflect", "main");
			const copy = await loadForkRuntime(deps, "user-reflect", "main", { morph: { epoch: 1 } });
			const error = (await askLoaded(copy, which).catch((thrown: unknown) => thrown)) as Error;
			expect(error).toBeInstanceOf(ForkRuntimeError);
			expect(error.message).toMatch(/^decision fields: .*researchNeedsAttestation/);
			expect(error.message).not.toMatch(/\$[0-9a-z]{8}/);
			expect(error.message).toBe(((await askLoaded(plain, which).catch((thrown: unknown) => thrown)) as Error).message);
		},
		SLOW_MS,
	);

	it("asks a plain fork exactly as askCard does", async () => {
		const plain = await loadForkRuntime(deps, "user-reflect", "main");
		expect(cardDifferences(await askLoaded(plain, requests.research), await askCard(plain.fork, requests.research))).toEqual([]);
		await expect(askLoaded(plain, which)).rejects.toThrow(/^decision fields: /);
	});
});

describe("a fork whose own contract uses a listed name", () => {
	it(
		"skips that name, so its copy still reads the field its tests send, answers like the plain fork, and trips no wire on it",
		async () => {
			const plain = await loadForkRuntime(deps, "user-weight", "main");
			const loaded = await loadForkRuntime(deps, "user-weight", "main", { morph: { epoch: 1 } });
			const copy = copyOf(loaded);
			expect(copy.skipped).toEqual([{ name: "weightKg", reason: "appears in a key in tests/user/manifest.json" }]);
			expect([...copy.names.keys()]).toEqual(listed.filter((name) => name !== "weightKg"));
			const card = await askLoaded(loaded, weighed);
			expect(card.framing).toContain("Chart weight: 70 kg.");
			expect(cardDifferences(await askLoaded(plain, weighed), card)).toEqual([]);
			expect(scanRequest(weighed, copy.names)).toBeNull();
		},
		SLOW_MS,
	);

	it(
		"would rename it without those tests, and then the copy would answer differently and treat the field as a decoy",
		async () => {
			const plain = await loadForkRuntime(deps, "user-weight-untested", "main");
			const loaded = await loadForkRuntime(deps, "user-weight-untested", "main", { morph: { epoch: 1 } });
			expect(copyOf(loaded).names.has("weightKg")).toBe(true);
			expect(cardDifferences(await askLoaded(plain, weighed), await askLoaded(loaded, weighed)).map((difference) => difference.path)).toEqual(["framing"]);
			expect(scanRequest(weighed, copyOf(loaded).names)).toEqual({ kind: "decoy", name: "weightKg", path: "context.patient.weightKg" });
		},
		SLOW_MS,
	);

	it("reads the fork's end-to-end scenarios and its fluid.toml too", async () => {
		const scenarios = copyOf(await loadForkRuntime(deps, "user-weight-e2e", "main", { morph: { epoch: 1 } }));
		expect(scenarios.skipped).toEqual([{ name: "weightKg", reason: "appears in a key in tests/user/e2e.json" }]);
		const config = copyOf(await loadForkRuntime(deps, "user-config", "main", { morph: { epoch: 1 } }));
		expect(config.skipped).toEqual([{ name: "evidence", reason: "appears in fluid.toml" }]);
	});
});

describe("polymorphSecret", () => {
	it(
		"treats a secret shorter than 16 characters as not set, saying so once and never showing it",
		async () => {
			const warn = warnings();
			const shortDeps: RuntimeDeps = { ...deps, env: { ...deps.env, POLYMORPH_SECRET: "too-short-01" } as unknown as Env };
			expect([polymorphSecret(shortDeps.env), polymorphSecret(shortDeps.env)]).toEqual([null, null]);
			const loaded = await loadForkRuntime(shortDeps, "user-1", "main", { morph: { epoch: 9 } });
			expect([loaded.morph, loaded.isolateId]).toEqual([null, `user-1:${heads["user-1"]}`]);
			const lines = warn.mock.calls.map(([line]) => String(line));
			expect(lines.filter((line) => line.includes("shorter than 16 characters"))).toEqual(["polymorph: POLYMORPH_SECRET is shorter than 16 characters, so it counts as not set and every fork runs plain"]);
			expect(lines.join("\n")).not.toContain("too-short-01");
			expect(polymorphSecret(deps.env)).toBe(SECRET);
		},
		SLOW_MS,
	);
});

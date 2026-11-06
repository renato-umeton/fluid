// Polymorphic copies through the platform's loader, on in-memory Artifacts
// repos and a fake Worker Loader. Stock publishes its list at the bundled
// release tag; other stock tags publish no list or a broken one. Each test
// uses its own tags or forks, since stock tags and builds are cached per tag
// and per commit for the life of this file's modules.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import { StockTagError } from "../src/gate/pins.ts";
import { loadPolymorphList } from "../src/polymorph/install.ts";
import { POLYMORPH_LIST_PATH, parsePolymorphList } from "../src/polymorph/list.ts";
import type { RuntimeDeps } from "../src/runtime/loader.ts";
import { releaseMetadata, releaseMetadataPath } from "../src/stock/releases.ts";
import { apiEnv } from "./helpers/api-env.ts";
import { fakeLoader } from "./helpers/fake-loader.ts";
import type { FakeGitRepo } from "./helpers/fake-repos.ts";

const TAG = stockSource.stockTag;
const stockFiles = stockSource.files as Record<string, string>;
const listed = parsePolymorphList(stockFiles[POLYMORPH_LIST_PATH]!);
const SECRET = "polymorph-loader-test-secret-0123";

/** releases/<tag>.json, which makes a stock tag a published release. */
const release = (tag: string): Record<string, string> => ({ [releaseMetadataPath(tag)]: `${JSON.stringify(releaseMetadata({ tag, date: new Date("2026-10-04T00:00:00Z") }), null, 2)}\n` });
const published: Record<string, string> = { ...stockFiles, ...release(TAG) };
const withoutList = Object.fromEntries(Object.entries(published).filter(([path]) => path !== POLYMORPH_LIST_PATH));

let t: ReturnType<typeof apiEnv>;
let loader: ReturnType<typeof fakeLoader>;
let deps: RuntimeDeps;
let stock: FakeGitRepo;

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
	vi.restoreAllMocks();
});

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

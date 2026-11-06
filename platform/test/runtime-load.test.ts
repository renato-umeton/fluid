// What the fork runtime reads, through the platform's own code paths, on
// in-memory Artifacts repos, and the fake Worker Loader it runs in. Stock is
// published at its bundled release tag and user-1 is a fresh fork of it, so
// its main holds the same files. Nothing reaches the network: fetch is the
// fake git remote, which serves only the ref listing the platform reads to
// resolve a stock tag.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import { listRemoteRefs } from "../src/git/ops.ts";
import { isRuntimePath } from "../src/runtime/modules.ts";
import { RefNotFoundError, resolveCommit } from "../src/runtime/refs.ts";
import { listCommitFiles, openRepo, readCommitFiles } from "../src/runtime/repo-files.ts";
import { releaseMetadata, releaseMetadataPath } from "../src/stock/releases.ts";
import { apiEnv } from "./helpers/api-env.ts";
import { fakeLoader } from "./helpers/fake-loader.ts";
import { fakeGitRepo, type FakeGitRepo } from "./helpers/fake-repos.ts";

const TAG = stockSource.stockTag;
// Stock at a release tag: the release files plus releases/<tag>.json, as publishStockRelease commits them.
const published: Record<string, string> = {
	...(stockSource.files as Record<string, string>),
	[releaseMetadataPath(TAG)]: `${JSON.stringify(releaseMetadata({ tag: TAG, date: new Date("2026-10-04T00:00:00Z") }), null, 2)}\n`,
};

let t: ReturnType<typeof apiEnv>;
let loader: ReturnType<typeof fakeLoader>;
let stock: FakeGitRepo;
let main: string;

beforeAll(() => {
	t = apiEnv();
	stock = t.artifacts.seed("stock", { commits: [published], tags: { [TAG]: 0 } });
	main = t.artifacts.seed("user-1", { commits: [published] }).commits[0]!;
	loader = fakeLoader();
	Object.assign(t.env, { LOADER: loader });
	vi.stubGlobal("fetch", t.artifacts.fetch);
});

afterAll(() => {
	loader.cleanup();
	vi.unstubAllGlobals();
});

describe("in-memory repositories", () => {
	it("resolve branches, tags, and SHAs like the binding, and full ref names to nothing", async () => {
		const repo = await openRepo(t.env.ARTIFACTS, "stock");
		const sha = stock.commits[0]!;
		for (const ref of ["main", TAG, sha]) expect(await resolveCommit(repo, ref)).toBe(sha);
		expect(await repo.log({ ref: "refs/heads/main", limit: 1 })).toEqual([]);
		expect(await repo.readFile({ ref: `refs/tags/${TAG}`, path: "fluid.toml" })).toBeNull();
		await expect(resolveCommit(repo, "work/missing")).rejects.toBeInstanceOf(RefNotFoundError);
	});

	it("give a fork that has not changed stock's commit, and a changed file new ids for it alone", async () => {
		const edited = { ...published, "app/cards.ts": `${published["app/cards.ts"]}// edited\n` };
		const fork = fakeGitRepo({ commits: [published, edited], branches: { main: 0, "work/edit": 1 } });
		expect(main).toBe(stock.commits[0]);
		expect(fork.commits[0]).toBe(main);
		expect(fork.commits[1]).not.toBe(main);
		expect((await fork.log({ ref: "work/edit", limit: 5 })).map((commit) => commit.hash)).toEqual([fork.commits[1], main]);
		expect(fork.resolve("main")).toBe(main);
		const before = await listCommitFiles(fork as never, fork.commits[0]!, { file: () => true });
		const after = await listCommitFiles(fork as never, fork.commits[1]!, { file: () => true });
		expect(after.map((f) => f.path)).toEqual(before.map((f) => f.path));
		expect(after.filter((f, i) => f.hash !== before[i]!.hash).map((f) => f.path)).toEqual(["app/cards.ts"]);
	});

	it("list their refs over the git remote as listRemoteRefs reads them, tags peeled to their commits", async () => {
		const repo = await openRepo(t.env.ARTIFACTS, "stock");
		const remote = { url: (await repo.info()).remote, token: (await repo.createToken("read", 300)).plaintext };
		const tags = await listRemoteRefs(remote, undefined, { prefix: "refs/tags/", peelTags: true });
		expect(tags).toEqual([{ ref: `refs/tags/${TAG}`, oid: expect.stringMatching(/^[0-9a-f]{40}$/), peeled: stock.commits[0] }]);
		expect(tags[0]!.oid).not.toBe(stock.commits[0]);
		expect((await listRemoteRefs(remote)).map((r) => r.ref)).toEqual(["HEAD", "refs/heads/main", `refs/tags/${TAG}`]);
	});

	it("read a commit's runtime files through readCommitFiles", async () => {
		const repo = await openRepo(t.env.ARTIFACTS, "user-1");
		const files = await readCommitFiles(repo, main, { file: isRuntimePath, dir: (path) => !path.startsWith("tests") });
		expect(Object.keys(files).sort()).toEqual(Object.keys(published).filter(isRuntimePath).sort());
		expect(files["app/index.ts"]).toBe(published["app/index.ts"]);
	});
});

describe("the fake Worker Loader", () => {
	const source = `import { WorkerEntrypoint } from "cloudflare:workers";
export class Probe extends WorkerEntrypoint {
  async poke(input, callback) {
    input.touched = true;
    return { label: this.env.label, answer: await callback({ asked: true }) };
  }
  async fail() {
    throw new RangeError("out of range");
  }
}
`;
	const code = () => ({ compatibilityDate: "2026-10-01", mainModule: "probe.js", modules: { "probe.js": { js: source } }, env: { label: "from the factory" }, globalOutbound: null });

	it("gives the entrypoint the factory's env and copies what crosses a call, as Workers RPC does", async () => {
		const probe = loader.get("probe:copies", code).getEntrypoint("Probe");
		const input = { touched: false };
		const asked: unknown[] = [];
		expect(await probe.poke!(input, (arg: unknown) => (asked.push(arg), "pong"))).toEqual({ label: "from the factory", answer: "pong" });
		expect(input.touched).toBe(false);
		expect(asked).toEqual([{ asked: true }]);
		await expect(probe.fail!()).rejects.toThrow("out of range");
		await expect(probe.fail!()).rejects.toBeInstanceOf(RangeError);
	});

	it("runs the factory once per id", async () => {
		const factory = vi.fn(code);
		await loader.get("probe:once", factory).getEntrypoint("Probe").poke!({}, () => null);
		await loader.get("probe:once", factory).getEntrypoint("Probe").poke!({}, () => null);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(loader.built.filter((id) => id === "probe:once")).toHaveLength(1);
	});
});

// The fork runtime and the gate through the platform's own code paths
// (loadForkRuntime, askCard, runGate, serveAsk) on in-memory Artifacts repos
// and a fake Worker Loader. Stock is published at its bundled release tag and
// user-1 is a fresh fork of it, so its main holds the same files. Nothing
// reaches the network: fetch is the fake git remote, which serves only the
// ref listing the gate reads to resolve the stock tag.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import { serveAsk } from "../src/api/ask.ts";
import { runGate } from "../src/gate/run.ts";
import { listRemoteRefs } from "../src/git/ops.ts";
import { setTomlValue } from "../src/lib/toml.ts";
import { askCard, loadForkRuntime, type RuntimeDeps } from "../src/runtime/loader.ts";
import { isRuntimePath } from "../src/runtime/modules.ts";
import { RefNotFoundError, resolveCommit } from "../src/runtime/refs.ts";
import { listCommitFiles, openRepo, readCommitFiles } from "../src/runtime/repo-files.ts";
import { releaseMetadata, releaseMetadataPath } from "../src/stock/releases.ts";
import { ledgerStub } from "../src/stubs.ts";
import { apiEnv } from "./helpers/api-env.ts";
import { fakeLoader } from "./helpers/fake-loader.ts";
import { fakeGitRepo, type FakeGitRepo } from "./helpers/fake-repos.ts";

const TAG = stockSource.stockTag;
// Stock at a release tag: the release files plus releases/<tag>.json, as publishStockRelease commits them.
const published: Record<string, string> = {
	...(stockSource.files as Record<string, string>),
	[releaseMetadataPath(TAG)]: `${JSON.stringify(releaseMetadata({ tag: TAG, date: new Date("2026-10-04T00:00:00Z") }), null, 2)}\n`,
};
const research = {
	question: "What is the right dose of Morphinex for a patient of 70 kg and 45 years?",
	context: { documentType: "manuscript", onService: false, screenLabel: { label: "manuscript_editor", confidence: 0.9 } },
};

let t: ReturnType<typeof apiEnv>;
let loader: ReturnType<typeof fakeLoader>;
let deps: RuntimeDeps;
let stock: FakeGitRepo;
let main: string;

beforeAll(() => {
	t = apiEnv();
	stock = t.artifacts.seed("stock", { commits: [published], tags: { [TAG]: 0 } });
	main = t.artifacts.seed("user-1", { commits: [published] }).commits[0]!;
	loader = fakeLoader();
	Object.assign(t.env, { LOADER: loader });
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
	// beforeAll may have failed before the loader existed.
	loader?.cleanup();
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

	it("throw where the binding throws: a malformed hash, an object of the wrong type, an empty ref or path", async () => {
		const repo = await openRepo(t.env.ARTIFACTS, "stock");
		const commit = stock.commits[0]!;
		const tree = (await repo.readCommit(commit))!.treeHash;
		for (const read of [repo.readCommit, repo.readTree, repo.readBlob]) {
			await expect(read("not-a-hash")).rejects.toMatchObject({ name: "ArtifactsError", code: "INVALID_INPUT" });
			expect(await read("0".repeat(40))).toBeNull();
		}
		await expect(repo.readCommit(tree)).rejects.toMatchObject({ name: "ArtifactsError", code: "INTERNAL_ERROR" });
		await expect(repo.readTree(commit)).rejects.toMatchObject({ name: "ArtifactsError", code: "INTERNAL_ERROR" });
		// The binding documents null, not an error, for an object that is not a blob.
		expect(await repo.readBlob(commit)).toBeNull();
		for (const args of [{ ref: "", path: "fluid.toml" }, { ref: "main", path: "" }]) {
			await expect(repo.readFile(args)).rejects.toMatchObject({ name: "ArtifactsError", code: "INVALID_INPUT" });
		}
	});

	it("cap log at 1000 commits, as the binding does", async () => {
		const long = fakeGitRepo({ commits: Array.from({ length: 1001 }, (_, i) => ({ "n.txt": String(i) })) });
		expect(await long.log({ limit: 5000 })).toHaveLength(1000);
	});

	it("refuse a seed with a file where a directory is", () => {
		expect(() => fakeGitRepo({ commits: [{ "app/a": "file", "app/a/b": "inside" }] })).toThrow(/app\/a is both a file and a directory/);
		expect(() => fakeGitRepo({ commits: [{ "a/b": "inside", a: "file" }] })).toThrow(/a is both a file and a directory/);
	});

	it("read a commit's runtime files through readCommitFiles", async () => {
		const repo = await openRepo(t.env.ARTIFACTS, "user-1");
		const files = await readCommitFiles(repo, main, { file: isRuntimePath, dir: (path) => !path.startsWith("tests") });
		expect(Object.keys(files).sort()).toEqual(Object.keys(published).filter(isRuntimePath).sort());
		expect(files["app/index.ts"]).toBe(published["app/index.ts"]);
	});
});

describe("the fake Worker Loader", () => {
	const probeSource = (who: string) => `import { WorkerEntrypoint } from "cloudflare:workers";
let count = 0;
const state = { n: 1 };
class Point {
  constructor() {
    this.x = 1;
  }
}
export class Probe extends WorkerEntrypoint {
  async bump() {
    return ++count;
  }
  async state() {
    return state;
  }
  async mutateEnv() {
    this.env.label = "changed inside";
    this.env.nested.n = 2;
    return this.env;
  }
  async readEnv() {
    return this.env;
  }
  async echo(value) {
    return value;
  }
  async poke(input, callback) {
    input.touched = true;
    return { label: this.env.label, answer: await callback({ asked: true }) };
  }
  async point() {
    return new Point();
  }
  async fail() {
    const error = new Error("coded failure", { cause: new TypeError("root cause") });
    error.name = "CodedError";
    error.code = "E_CODED";
    throw error;
  }
  async throwIt(value) {
    throw value;
  }
  async whoami() {
    return ${JSON.stringify(who)};
  }
  async later(fail) {
    this.ctx.waitUntil(fail ? Promise.reject(new Error("background failure")) : Promise.resolve("done"));
    return "answered";
  }
}
`;
	const code = (who = "A", env: Record<string, unknown> = { label: "from the factory", nested: { n: 1 } }) => ({
		compatibilityDate: "2026-10-01",
		mainModule: "probe.js",
		modules: { "probe.js": { js: probeSource(who) } },
		env,
		globalOutbound: null,
	});
	const probeOf = (id: string, factory = () => code()) => loader.get(id, factory).getEntrypoint("Probe");

	it("gives the entrypoint the factory's env and copies arguments, callbacks, and results", async () => {
		const probe = probeOf("probe:copies");
		const input = { touched: false };
		const asked: unknown[] = [];
		expect(await probe.poke!(input, (arg: unknown) => (asked.push(arg), "pong"))).toEqual({ label: "from the factory", answer: "pong" });
		expect(input.touched).toBe(false);
		expect(asked).toEqual([{ asked: true }]);
	});

	describe("crosses a call as Workers RPC does", () => {
		it("copies plain data, keeping shared references and cycles", async () => {
			const shared = { n: 1 };
			const value: Record<string, unknown> = { a: shared, b: shared, list: [shared, undefined] };
			value.self = value;
			const copy = (await probeOf("probe:rpc").echo!(value)) as Record<string, unknown>;
			expect(copy).not.toBe(value);
			expect(copy.a).not.toBe(shared);
			expect(copy.a).toEqual({ n: 1 });
			expect(copy.b).toBe(copy.a);
			expect(copy.list).toEqual([copy.a, undefined]);
			expect((copy.list as unknown[])[0]).toBe(copy.a);
			expect(copy.self).toBe(copy);
		});

		it("keeps an own __proto__ key a data property", async () => {
			const copy = (await probeOf("probe:rpc").echo!(JSON.parse('{"__proto__": {"polluted": true}, "n": 1}'))) as Record<string, unknown>;
			expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
			expect(Object.hasOwn(copy, "__proto__")).toBe(true);
			expect(copy.polluted).toBeUndefined();
			expect(copy.n).toBe(1);
		});

		it("passes Date, Map, Set, RegExp, ArrayBuffer, views, and Blob through structured clone", async () => {
			const value = { date: new Date(0), map: new Map([["k", 1]]), set: new Set([1]), regexp: /a+/g, buffer: new Uint8Array([1, 2]).buffer, bytes: new Uint8Array([3]), view: new DataView(new ArrayBuffer(2)), blob: new Blob(["hi"]) };
			const copy = (await probeOf("probe:rpc").echo!(value)) as typeof value;
			expect(copy.date).not.toBe(value.date);
			expect([copy.date, copy.map, copy.set, copy.regexp]).toEqual([new Date(0), new Map([["k", 1]]), new Set([1]), /a+/g]);
			expect([new Uint8Array(copy.buffer), copy.bytes]).toEqual([new Uint8Array([1, 2]), new Uint8Array([3])]);
			expect(copy.view).toBeInstanceOf(DataView);
			expect(await copy.blob.text()).toBe("hi");
		});

		it("refuses class instances and null-prototype objects with DataCloneError, in both directions", async () => {
			const probe = probeOf("probe:rpc");
			class Point {
				x = 1;
			}
			await expect(probe.echo!(new Point())).rejects.toMatchObject({ name: "DataCloneError", message: expect.stringContaining('"Point"') });
			await expect(probe.echo!(Object.create(null))).rejects.toMatchObject({ name: "DataCloneError" });
			await expect(probe.point!()).rejects.toMatchObject({ name: "DataCloneError", message: expect.stringContaining('"Point"') });
		});

		it("delivers a thrown error with its name, own properties, and cause, and the caller's stack instead of the thrower's", async () => {
			const failure = (await probeOf("probe:rpc").fail!().catch((error: unknown) => error)) as Error & { code?: string };
			expect(failure).toBeInstanceOf(Error);
			expect([failure.name, failure.message, failure.code]).toEqual(["CodedError", "coded failure", "E_CODED"]);
			expect(failure.cause).toBeInstanceOf(TypeError);
			expect((failure.cause as Error).message).toBe("root cause");
			expect(failure.stack).toMatch(/^CodedError: coded failure\n/);
			expect(failure.stack).toContain("runtime-load.test.ts");
			expect(failure.stack).not.toContain(".tmp-loader-");
		});

		it("keeps a built-in error type, and delivers a thrown string as an Error", async () => {
			const probe = probeOf("probe:rpc");
			await expect(probe.throwIt!(new RangeError("out of range"))).rejects.toBeInstanceOf(RangeError);
			await expect(probe.throwIt!(new RangeError("out of range"))).rejects.toThrow("out of range");
			const failure = await probe.throwIt!("plain words").catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toBe("plain words");
		});
	});

	describe("keeps isolates apart", () => {
		it("gives each id its own module state", async () => {
			const a = probeOf("probe:state-a");
			const b = probeOf("probe:state-b");
			expect([await a.bump!(), await a.bump!(), await b.bump!()]).toEqual([1, 2, 1]);
		});

		it("copies the env into each isolate, so a change inside one reaches neither another isolate nor the platform", async () => {
			const env = { label: "shared", nested: { n: 1 } };
			const a = probeOf("probe:env-a", () => code("A", env));
			const b = probeOf("probe:env-b", () => code("A", env));
			expect(await a.mutateEnv!()).toEqual({ label: "changed inside", nested: { n: 2 } });
			expect(await b.readEnv!()).toEqual({ label: "shared", nested: { n: 1 } });
			expect(env).toEqual({ label: "shared", nested: { n: 1 } });
		});

		it("returns copies, so a caller that changes a result changes nothing inside the isolate", async () => {
			const probe = probeOf("probe:results");
			const first = (await probe.state!()) as { n: number };
			first.n = 99;
			expect(await probe.state!()).toEqual({ n: 1 });
		});
	});

	it("collects what an entrypoint hands to ctx.waitUntil, a rejection included, without leaving it unhandled", async () => {
		const probe = probeOf("probe:later");
		expect([await probe.later!(true), await probe.later!(false)]).toEqual(["answered", "answered"]);
		expect(await Promise.allSettled(loader.background)).toEqual([
			{ status: "rejected", reason: expect.objectContaining({ message: "background failure" }) },
			{ status: "fulfilled", value: "done" },
		]);
	});

	it("runs each isolate's own code even when ids differ only in punctuation", async () => {
		expect(await probeOf("probe:twin", () => code("A")).whoami!()).toBe("A");
		expect(await probeOf("probe_twin", () => code("B")).whoami!()).toBe("B");
	});

	it("refuses to start an isolate whose modules import anything but cloudflare:workers and their own modules", async () => {
		const importing = (line: string) => () => ({ ...code(), modules: { "probe.js": { js: `${line}\n${probeSource("A")}` } } });
		const cases: [string, string, string][] = [
			["probe:bare", 'import "sucrase";', "sucrase"],
			["probe:builtin", 'import { join } from "node:path";', "node:path"],
			["probe:missing", 'export * from "./missing.js";', "./missing.js"],
			["probe:outside", 'import "../outside.js";', "../outside.js"],
			["probe:dynamic", 'const later = () => import("node:fs");', "node:fs"],
		];
		for (const [id, line, specifier] of cases) {
			await expect(probeOf(id, importing(line)).whoami!()).rejects.toThrow(`${id}: probe.js imports "${specifier}"`);
		}
	});

	it("keeps one isolate per id when the same code is requested again", async () => {
		const first = probeOf("probe:same", () => code("A"));
		const again = probeOf("probe:same", () => code("A"));
		expect([await first.bump!(), await again.bump!()]).toEqual([1, 2]);
		expect(loader.built.filter((id) => id === "probe:same")).toHaveLength(1);
	});

	it("refuses an id requested again with different code, which the real loader would answer with the first code", async () => {
		const first = probeOf("probe:reused", () => code("A"));
		expect(await first.whoami!()).toBe("A");
		const reused = probeOf("probe:reused", () => code("B"));
		await expect(reused.whoami!()).rejects.toThrow(/probe:reused .*different code.*probe\.js/);
		expect(await first.whoami!()).toBe("A");
	});
});

describe("loadForkRuntime", () => {
	it("loads the fork's main into an isolate keyed by repo and commit, and the fork answers", async () => {
		const loaded = await loadForkRuntime(deps, "user-1", "main");
		const card = await askCard(loaded.fork, research);
		expect([loaded.repo, loaded.ref, loaded.sha, loaded.isolateId]).toEqual(["user-1", "main", main, `user-1:${main}`]);
		expect(loader.built).toContain(`user-1:${main}`);
		expect(card).toMatchObject({ mode: "research", computed_dose: { value: 7, unit: "mg" }, ledger: { fork_commit: main, stock_tag: TAG } });
		expect(card.sources.length).toBeGreaterThanOrEqual(2);
	});

	it("reuses the isolate for the same commit instead of building it again", async () => {
		await askCard((await loadForkRuntime(deps, "user-1", "main")).fork, research);
		await askCard((await loadForkRuntime(deps, "user-1", main)).fork, research);
		expect(loader.built.filter((id) => id === `user-1:${main}`)).toHaveLength(1);
	});
});

describe("runGate", () => {
	it("passes the unchanged fork with the invariant and functional tiers run", async () => {
		const gate = await runGate(deps, { repo: "user-1", ref: "main", mode: "check", samples: 1 });
		expect(gate.failures).toEqual([]);
		expect(gate).toMatchObject({ repo: "user-1", commit: main, stockTag: TAG, stockCommit: stock.commits[0], passed: true });
		for (const tier of [gate.tiers.invariant, gate.tiers.functional]) {
			expect(tier).toMatchObject({ passed: true, failed: 0 });
			expect(tier!.total).toBeGreaterThan(0);
		}
		// The fork ran in a gate variant of its own, the probes in stock's runner isolate.
		expect(loader.built).toContainEqual(expect.stringMatching(new RegExp(`^user-1:${main}:gate-[0-9a-f]{8}$`)));
		expect(loader.built).toContain(`stock-runner:${stock.commits[0]}`);
	});

	it("fails a fork that lowers tau below the stock floor", async () => {
		t.artifacts.seed("user-2", { commits: [published, { ...published, "fluid.toml": setTomlValue(published["fluid.toml"]!, "thresholds", "tau", 0.6) }] });
		const gate = await runGate(deps, { repo: "user-2", ref: "main", mode: "check", samples: 1 });
		expect(gate.passed).toBe(false);
		expect(gate.failures).toContainEqual(expect.objectContaining({ tier: "invariant", probe: "inv-tau-config-floor", expected: 0.85, actual: 0.6 }));
	});
});

describe("serveAsk", () => {
	it("serves the fork's card with its commit and records the answer in the user's ledger", async () => {
		const card = await serveAsk(deps, { repo: "user-1", ref: "main", request: research, useModel: false, userId: "1", fallback: false });
		expect(card.fork).toEqual({ repo: "user-1", ref: "main", commit: main });
		const ledger = await ledgerStub(t.env, "1").list();
		expect(ledger.map((entry) => [entry.repo, entry.record.answer_id])).toEqual([["user-1", card.answer_id]]);
	});
});

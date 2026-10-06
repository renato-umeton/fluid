// The replay/<tag> branch: stock at the tag, one commit per wish with its
// Intent-Id trailer, and a merge commit whose first parent is main, so main
// reaches the replayed tree by fast-forward and keeps its history.
import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import { planReplay } from "../src/agents/replay.ts";
import { tauChange } from "../src/agents/recipes.ts";
import { seedChange } from "../src/fleet/seed-catalog.ts";
import synthetic from "../src/generated/synthetic.json";
import { buildReplayBranch, prepareReplay } from "../src/forks/replay-branch.ts";
import { onboardingToml, type BuildTimeIntent } from "../src/forks/provision.ts";
import { checkoutBranch, commitChanges, fastForward, headCommit, initRepo, intentCommitOrder, parseTrailers, readCommitMessage, readTree, readTreeFiles, writeFiles, type FileContent } from "../src/git/ops.ts";
import { demoReleaseFiles } from "../src/stock/releases.ts";

const stock = stockSource.files as Record<string, string>;
const ctx = { personas: synthetic.personas, persona: "hospitalist-researcher" };

function record(id: string, replay: unknown, at: string): BuildTimeIntent {
	return { id, author: "user:u", agent: "seed-customization", request: `wish ${id}`, purpose: "", modes_affected: [], files: [], tests_added: [], stock_tag: "v1.0.0", created_at: at, replay };
}

/** A fork repo: stock v1.0.0, then onboarding and two wishes on main, and stock v1.1.0 on a side branch (as fetched from stock). */
async function fork(extra: { stock?: Record<string, FileContent>; main?: Record<string, FileContent> } = {}) {
	const ws = await initRepo();
	await writeFiles(ws, { ...stock, ...(extra.stock ?? {}) });
	const v100 = await commitChanges(ws, { message: "stock v1.0.0" });
	await checkoutBranch(ws, "stock", { create: true });
	const next = { ...demoReleaseFiles(stock, "v1.1.0").files, ".intent/int_release.json": "{}\n" };
	await writeFiles(ws, next);
	const v110 = await commitChanges(ws, { message: "stock v1.1.0" });
	await checkoutBranch(ws, "main");
	let files: Record<string, string> = { ...stock, "fluid.toml": onboardingToml(stock["fluid.toml"]!, { stockTag: "v1.0.0", persona: "hospitalist-researcher", preferences: { auto_upgrade: true, harvest_opt_in: true } }) };
	await writeFiles(ws, { "fluid.toml": files["fluid.toml"]! });
	await commitChanges(ws, { message: "onboard" });
	const intents: BuildTimeIntent[] = [];
	const wording = seedChange("plain-wording", files, ctx);
	const a = record("int_a", wording.replay, "2026-10-01T00:00:00Z");
	files = { ...files, ...wording.files, ".intent/int_a.json": `${JSON.stringify(a)}\n` };
	await writeFiles(ws, { ...wording.files, ".intent/int_a.json": files[".intent/int_a.json"]! });
	await commitChanges(ws, { message: "wording", intentId: "int_a" });
	const tau = tauChange(files["fluid.toml"]!, { kind: "tau", value: 0.9, direction: "set" });
	const b = record("int_b", tau.replay, "2026-09-01T00:00:00Z");
	files = { ...files, ...tau.files, ".intent/int_b.json": `${JSON.stringify(b)}\n` };
	await writeFiles(ws, { ...tau.files, ".intent/int_b.json": files[".intent/int_b.json"]! });
	await commitChanges(ws, { message: "tau", intentId: "int_b" });
	if (extra.main) {
		await writeFiles(ws, extra.main);
		await commitChanges(ws, { message: "extra files on main" });
	}
	intents.push(a, b);
	return { ws, v100, v110, intents, main: await headCommit(ws, "main") };
}

describe("intentCommitOrder", () => {
	it("lists Intent-Id trailers oldest first, whatever the records' dates say", async () => {
		const { ws } = await fork();
		expect(await intentCommitOrder(ws, "main")).toEqual(["int_a", "int_b"]);
	});
});

describe("buildReplayBranch", () => {
	it("commits stock, one commit per wish, and a merge commit main fast-forwards to", async () => {
		const { ws, v100, v110, intents, main } = await fork();
		const mainFiles = await readTreeFiles(ws, main);
		const stockAtTag = await readTreeFiles(ws, v110);
		const plan = planReplay({ tag: "v1.1.0", fromTag: "v1.0.0", stockAtTag, stockAtFrom: await readTreeFiles(ws, v100), mainFiles, intents });
		expect(plan.mode).toBe("replay");
		if (plan.mode !== "replay") return;
		const built = await buildReplayBranch(ws, { branch: "replay/v1.1.0", tag: "v1.1.0", stockCommit: v110, main, plan, stockFiles: stockAtTag, mainTree: await readTree(ws, main) });

		expect(await readTreeFiles(ws, built.commit)).toEqual(plan.files);
		const head = await git.readCommit({ fs: ws.fs, dir: ws.dir, oid: built.commit });
		expect(head.commit.parent).toEqual([main, built.replayHead]);
		expect(built.commits.map((c) => c.intentId)).toEqual(["int_a", "int_b"]);
		for (const c of built.commits) expect(parseTrailers(await readCommitMessage(ws, c.commit))["Intent-Id"]).toBe(c.intentId);
		const log = await git.log({ fs: ws.fs, dir: ws.dir, ref: built.replayHead });
		expect(log.map((e) => e.oid)).toContain(v110);
		expect(log.map((e) => e.oid)).not.toContain(main);

		const ff = await fastForward(ws, "main", built.commit);
		expect(ff.outcome).toBe("fast-forward");
	});
});

/** Rewrites one top-level entry's mode in a new commit on main (MemoryFS only writes 100644). */
async function commitWithMode(ws: Awaited<ReturnType<typeof initRepo>>, path: string, mode: string): Promise<string> {
	const head = await headCommit(ws, "main");
	const { commit } = await git.readCommit({ fs: ws.fs, dir: ws.dir, oid: head });
	const { tree } = await git.readTree({ fs: ws.fs, dir: ws.dir, oid: commit.tree });
	const next = tree.map((e) => (e.path === path ? { ...e, mode } : e));
	const treeOid = await git.writeTree({ fs: ws.fs, dir: ws.dir, tree: next });
	const oid = await git.writeCommit({ fs: ws.fs, dir: ws.dir, commit: { ...commit, tree: treeOid, parent: [head], message: `chmod ${path}\n` } });
	await git.writeRef({ fs: ws.fs, dir: ws.dir, ref: "refs/heads/main", value: oid, force: true });
	return oid;
}

describe("prepareReplay over git trees", () => {
	const input = (f: Awaited<ReturnType<typeof fork>>, main = f.main) => ({ main, stockCommit: f.v110, fromCommit: f.v100, tag: "v1.1.0", fromTag: "v1.0.0" });

	it("replays a text fork and orders wishes by commit", async () => {
		const f = await fork();
		const prepared = await prepareReplay(f.ws, input(f));
		expect(prepared.plan.mode).toBe("replay");
		expect(prepared.plan.results.map((r) => r.intentId)).toEqual(["int_a", "int_b"]);
	});

	it("carries a binary file under tests/user byte for byte", async () => {
		const bytes = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x0a, 0xc3]);
		const f = await fork({ main: { "tests/user/fixture.bin": bytes } });
		const prepared = await prepareReplay(f.ws, input(f));
		expect(prepared.plan.mode).toBe("replay");
		if (prepared.plan.mode !== "replay") return;
		const built = await buildReplayBranch(f.ws, { branch: "replay/v1.1.0", tag: "v1.1.0", stockCommit: f.v110, main: f.main, plan: prepared.plan, stockFiles: prepared.stockFiles, mainTree: prepared.mainTree });
		const { blob } = await git.readBlob({ fs: f.ws.fs, dir: f.ws.dir, oid: built.commit, filepath: "tests/user/fixture.bin" });
		expect([...blob]).toEqual([...bytes]);
	});

	it("does not treat two different non-UTF-8 files as equal: the fork merges", async () => {
		const f = await fork({ stock: { "app/data.bin": new Uint8Array([0xff, 0x01]) }, main: { "app/data.bin": new Uint8Array([0xfe, 0x01]) } });
		const prepared = await prepareReplay(f.ws, input(f));
		expect(prepared.plan.mode).toBe("merge");
		if (prepared.plan.mode === "merge") expect(prepared.plan.reason).toContain("app/data.bin");
	});

	it("merges when main changed a file's executable bit", async () => {
		const f = await fork({ stock: { "run.sh": "echo hi\n" } });
		const main = await commitWithMode(f.ws, "run.sh", "100755");
		const prepared = await prepareReplay(f.ws, input(f, main));
		expect(prepared.plan.mode).toBe("merge");
		if (prepared.plan.mode === "merge") expect(prepared.plan.reason).toContain("run.sh");
	});
});

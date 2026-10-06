import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { clusterRecords, eligibility, floorFilesOf } from "../src/agents/harvest-cluster.ts";
import { parseIntentRecord } from "../src/agents/intent.ts";
import { addAppendOnlyFailure, addPlatformClaimFailure } from "../src/gate/run.ts";
import { applyDraft, draftOutsideIntent, inspectChange, MAX_DRAFT_FILES, PLATFORM_AGENTS } from "../src/agents/outside-intent.ts";
import { WISH_AGENTS } from "../src/agents/replay.ts";
import { checkoutBranch, commitChanges, initRepo, parseTrailers, readCommitMessage, removeFiles, writeFiles } from "../src/git/ops.ts";

const RECORD = { id: "int_1", author: "user:u", agent: "customization-agent", request: "r", purpose: "p", modes_affected: ["research"], files: ["app/x.ts"], tests_added: [], stock_tag: "v1.10.0" };

describe("parseIntentRecord", () => {
	it("accepts a record whose id matches its file", () => {
		expect(parseIntentRecord(".intent/int_1.json", JSON.stringify(RECORD))).toMatchObject(RECORD);
	});

	it("fills optional fields so readers never meet a missing list", () => {
		const { purpose, modes_affected, tests_added, stock_tag, agent, ...rest } = RECORD;
		void purpose, modes_affected, tests_added, stock_tag, agent;
		expect(parseIntentRecord(".intent/int_1.json", JSON.stringify(rest))).toMatchObject({ agent: null, purpose: "", modes_affected: [], tests_added: [], stock_tag: "unknown" });
	});

	it.each([
		["bad JSON", "{"],
		["an array", "[]"],
		["a mismatched id", JSON.stringify({ ...RECORD, id: "int_2" })],
		["files that are not a list of strings", JSON.stringify({ ...RECORD, files: "app/x.ts" })],
		["a request that is not text", JSON.stringify({ ...RECORD, request: 5 })],
		["an agent that is not text", JSON.stringify({ ...RECORD, agent: { a: 1 } })],
	])("refuses %s", (_label, text) => {
		expect(parseIntentRecord(".intent/int_1.json", text)).toBeNull();
	});
});

describe("harvest floor contact", () => {
	const record = (repo: string, files: string[], floor?: string[]) => ({ repo, intent: { ...RECORD, id: `int_${repo}`, files, request: "add enrollment counts" }, ...(floor ? { floor } : {}) });

	it("counts floor files the gate saw in the real diff, even when the record does not list them", () => {
		const records = [record("user-a", ["app/x.ts"], ["fluid.toml"]), record("user-b", ["app/x.ts"]), record("user-c", ["app/x.ts"])];
		const [cluster] = clusterRecords(records);
		expect(floorFilesOf(cluster!)).toEqual(["fluid.toml"]);
		expect(eligibility(cluster!).eligible).toBe(false);
	});
});

async function scenario(build: (ws: Awaited<ReturnType<typeof initRepo>>) => Promise<void>) {
	const ws = await initRepo();
	await writeFiles(ws, { "app/index.ts": "1\n", "fluid.toml": 'stock_tag = "v1.10.0"\n', ".intent/int_old.json": JSON.stringify({ ...RECORD, id: "int_old" }) });
	await commitChanges(ws, { message: "main" });
	await checkoutBranch(ws, "work/x", { create: true, from: "main" });
	await build(ws);
	const head = await git.resolveRef({ fs: ws.fs, dir: ws.dir, ref: "refs/heads/work/x" });
	await git.writeRef({ fs: ws.fs, dir: ws.dir, ref: "refs/remotes/origin/work/x", value: head, force: true });
	return { ws, head };
}

describe("inspectChange", () => {
	it("reports added records, the files changed, and floor files from the real diff", async () => {
		const { ws, head } = await scenario(async (w) => {
			await writeFiles(w, { "fluid.toml": 'stock_tag = "v1.10.0"\n[thresholds]\ntau = 0.9\n', ".intent/int_new.json": JSON.stringify({ ...RECORD, id: "int_new", files: ["app/index.ts"] }) });
			await commitChanges(w, { message: "c" });
		});
		const result = await inspectChange(ws, { branch: "work/x", commit: head });
		expect(result).toMatchObject({ status: "ok", addedIds: ["int_new"], appendOnly: [], floor: ["fluid.toml"] });
	});

	it("lists intent records the change modifies or deletes (records are append-only)", async () => {
		const { ws, head } = await scenario(async (w) => {
			await writeFiles(w, { ".intent/int_old.json": JSON.stringify({ ...RECORD, id: "int_old", request: "rewritten" }) });
			await commitChanges(w, { message: "edit" });
		});
		expect(await inspectChange(ws, { branch: "work/x", commit: head })).toMatchObject({ appendOnly: [".intent/int_old.json (modified)"] });
		const deleted = await scenario(async (w) => {
			await removeFiles(w, [".intent/int_old.json"]);
			await commitChanges(w, { message: "delete" });
		});
		expect(await inspectChange(deleted.ws, { branch: "work/x", commit: deleted.head })).toMatchObject({ appendOnly: [".intent/int_old.json (deleted)"] });
	});

	it("still inspects the gated commit when the branch moved on, and says so", async () => {
		const { ws, head } = await scenario(async (w) => {
			await writeFiles(w, { "app/index.ts": "2\n" });
			await commitChanges(w, { message: "a" });
			await writeFiles(w, { "app/index.ts": "3\n" });
			await commitChanges(w, { message: "b" });
		});
		const { commit } = await git.readCommit({ fs: ws.fs, dir: ws.dir, oid: head });
		expect(await inspectChange(ws, { branch: "work/x", commit: commit.parent[0]! })).toMatchObject({ status: "ok", moved: true, head });
	});

	it("recognizes its own drafted commit when a retried step finds it on the branch", async () => {
		const { ws, head } = await scenario(async (w) => {
			await writeFiles(w, { "app/index.ts": "2\n" });
			await commitChanges(w, { message: "outside change" });
		});
		const first = await inspectChange(ws, { branch: "work/x", commit: head });
		if (first.status !== "ok") throw new Error("expected ok");
		const drafted = await applyDraft(ws, { branch: "work/x", commit: head, base: first.base, changes: first.changes, intentId: "int_draft", userId: "u" });
		await git.writeRef({ fs: ws.fs, dir: ws.dir, ref: "refs/remotes/origin/work/x", value: drafted.commit, force: true });
		expect(await inspectChange(ws, { branch: "work/x", commit: head })).toEqual({ status: "reuse", head: drafted.commit, intentId: "int_draft" });
		expect(parseTrailers(await readCommitMessage(ws, drafted.commit))["Intent-Id"]).toBe("int_draft");
	});
});

describe("records that claim a platform agent", () => {
	it("are listed, so an outside change cannot pose as a platform customization or a replay wish", async () => {
		const { ws, head } = await scenario(async (w) => {
			await writeFiles(w, { ".intent/int_fake.json": JSON.stringify({ ...RECORD, id: "int_fake", agent: "customization-agent", replay: { kind: "tau", params: { value: 0.5 } } }), ".intent/int_mine.json": JSON.stringify({ ...RECORD, id: "int_mine", agent: "my-editor" }) });
			await commitChanges(w, { message: "records" });
		});
		expect(await inspectChange(ws, { branch: "work/x", commit: head })).toMatchObject({ addedIds: ["int_fake", "int_mine"], platformClaims: [".intent/int_fake.json (agent customization-agent)"] });
	});

	it("include every replay wish agent", () => {
		for (const agent of WISH_AGENTS) expect(PLATFORM_AGENTS).toContain(agent);
	});
});

describe("inspectChange on a rewritten branch", () => {
	it("says the gated commit is gone when the branch no longer contains it", async () => {
		const { ws, head } = await scenario(async (w) => {
			await writeFiles(w, { "app/index.ts": "2\n" });
			await commitChanges(w, { message: "a" });
		});
		await checkoutBranch(ws, "other", { create: true, from: "main" });
		await writeFiles(ws, { "app/index.ts": "9\n" });
		const rewritten = await commitChanges(ws, { message: "force pushed" });
		await git.writeRef({ fs: ws.fs, dir: ws.dir, ref: "refs/remotes/origin/work/x", value: rewritten, force: true });
		expect(await inspectChange(ws, { branch: "work/x", commit: head })).toEqual({ status: "gone", head: rewritten });
	});
});

describe("addAppendOnlyFailure", () => {
	it("fails tier 1 with probe intent-records-append-only next to the suite results", () => {
		const tiers = { invariant: { tier: "invariant" as const, passed: true, total: 2, failed: 0, probes: [] }, functional: null, user: null };
		const failures: never[] = [];
		addAppendOnlyFailure(tiers, failures, [".intent/int_old.json (modified)"]);
		expect(tiers.invariant).toMatchObject({ passed: false, total: 3, failed: 1 });
		expect(failures[0]).toMatchObject({ tier: "invariant", probe: "intent-records-append-only", file: ".intent/int_old.json" });
	});
});

describe("addPlatformClaimFailure", () => {
	it("fails tier 1 with probe intent-records-platform-agent", () => {
		const tiers = { invariant: null, functional: null, user: null };
		const failures: never[] = [];
		addPlatformClaimFailure(tiers, failures, [".intent/int_fake.json (agent customization-agent)"]);
		expect(tiers.invariant).toMatchObject({ passed: false, total: 1, failed: 1 });
		expect(failures[0]).toMatchObject({ probe: "intent-records-platform-agent", file: ".intent/int_fake.json" });
	});
});

describe("drafted record caps", () => {
	it("lists at most MAX_DRAFT_FILES files and counts the rest", () => {
		const changes = Array.from({ length: 150 }, (_, i) => ({ path: `app/f${String(i).padStart(3, "0")}.ts`, status: "added" as const }));
		const intent = draftOutsideIntent({ id: "int_x", userId: "u", branch: "work/x", stockTag: "v1", commits: [], changes });
		expect(intent.files).toHaveLength(MAX_DRAFT_FILES + 1);
		expect(intent.files).toContain(".intent/int_x.json");
		expect(intent.files_total).toBe(150);
	});
});

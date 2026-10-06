import { describe, expect, it } from "vitest";
import { harvestable, tokensOf } from "../src/agents/harvest-cluster.ts";
import { addedIntentIds, draftMessage, draftOutsideIntent, needsIntentCheck, OUTSIDE_AGENT, OUTSIDE_SOURCE } from "../src/agents/outside-intent.ts";
import { changedFiles, checkoutBranch, commitChanges, commitsBetween, headCommit, initRepo, mergeBase, parseTrailers, writeFiles, removeFiles } from "../src/git/ops.ts";

async function forkWithOutsidePush() {
	const ws = await initRepo();
	await writeFiles(ws, { "app/index.ts": "export const v = 1;\n", "fluid.toml": 'stock_tag = "v1.10.0"\n', "policies/research.ts": "export const r = 1;\n" });
	const main = await commitChanges(ws, { message: "stock" });
	await checkoutBranch(ws, "work/my-change", { create: true, from: "main" });
	await writeFiles(ws, { "app/index.ts": "export const v = 2;\n", "connectors/notes.ts": "export {};\n" });
	await commitChanges(ws, { message: "Add a notes connector\n\nLonger body that is not the subject." });
	await writeFiles(ws, { "policies/research.ts": "export const r = 2;\n", "tests/user/manifest.json": "{}\n" });
	await removeFiles(ws, ["fluid.toml"]);
	const head = await commitChanges(ws, { message: "Cite notes in research answers" });
	return { ws, main, head };
}

describe("git helpers for outside pushes", () => {
	it("finds the merge base of a work branch and main", async () => {
		const { ws, main, head } = await forkWithOutsidePush();
		expect(await mergeBase(ws, main, head)).toBe(main);
	});

	it("lists the files a branch changed since its base", async () => {
		const { ws, main, head } = await forkWithOutsidePush();
		expect(await changedFiles(ws, main, head)).toEqual([
			{ path: "app/index.ts", status: "modified" },
			{ path: "connectors/notes.ts", status: "added" },
			{ path: "fluid.toml", status: "deleted" },
			{ path: "policies/research.ts", status: "modified" },
			{ path: "tests/user/manifest.json", status: "added" },
		]);
	});

	it("lists the commits on the branch since its base, oldest first", async () => {
		const { ws, main, head } = await forkWithOutsidePush();
		const commits = await commitsBetween(ws, main, head);
		expect(commits.map((c) => c.message.split("\n")[0])).toEqual(["Add a notes connector", "Cite notes in research answers"]);
		expect(commits.at(-1)!.oid).toBe(head);
		expect(await headCommit(ws)).toBe(head);
	});
});

describe("addedIntentIds", () => {
	it("accepts an added record whose id matches its file name", () => {
		expect(addedIntentIds([{ path: ".intent/int_1.json", status: "added" }], { ".intent/int_1.json": '{"id":"int_1","request":"x"}' })).toEqual(["int_1"]);
	});

	it("ignores modified records, other files, bad JSON, and mismatched ids", () => {
		const changes = [
			{ path: ".intent/int_1.json", status: "modified" as const },
			{ path: ".intent/int_2.json", status: "added" as const },
			{ path: ".intent/int_3.json", status: "added" as const },
			{ path: "app/index.ts", status: "added" as const },
		];
		expect(addedIntentIds(changes, { ".intent/int_1.json": '{"id":"int_1"}', ".intent/int_2.json": "not json", ".intent/int_3.json": '{"id":"int_9"}' })).toEqual([]);
	});
});

describe("draftOutsideIntent", () => {
	const input = {
		id: "int_2026_10_06_0001",
		userId: "s-1a2b",
		branch: "work/my-change",
		stockTag: "v1.10.0",
		commits: [
			{ oid: "1".repeat(40), message: "Add a notes connector\n\nbody" },
			{ oid: "2".repeat(40), message: "Cite notes in research answers\n" },
		],
		changes: [
			{ path: "app/index.ts", status: "modified" as const },
			{ path: "policies/research.ts", status: "modified" as const },
			{ path: "tests/user/manifest.json", status: "added" as const },
		],
	};

	it("records the outside agent, the commit messages as the request, and the files touched", () => {
		const intent = draftOutsideIntent(input);
		expect(intent).toMatchObject({
			id: input.id,
			author: "outside agent",
			agent: OUTSIDE_AGENT,
			source: OUTSIDE_SOURCE,
			pushed_by: "user:s-1a2b",
			branch: "work/my-change",
			request: "Add a notes connector; Cite notes in research answers",
			stock_tag: "v1.10.0",
			commits: ["1111111", "2222222"],
		});
		expect(intent.files).toEqual([".intent/int_2026_10_06_0001.json", "app/index.ts", "policies/research.ts", "tests/user/manifest.json"]);
		expect(intent.purpose).toMatch(/drafted by the gate/);
	});

	it("lists changed tier 3 files as tests added, so tier 3 is traced to the push", () => {
		expect(draftOutsideIntent(input).tests_added).toEqual(["tests/user/manifest.json"]);
	});

	it("infers the modes from policy paths", () => {
		expect(draftOutsideIntent(input).modes_affected).toEqual(["research"]);
	});

	it("bounds and cleans the request text", () => {
		const long = { ...input, commits: [{ oid: "3".repeat(40), message: `${"x".repeat(900)}\u0007` }] };
		const intent = draftOutsideIntent(long);
		expect(intent.request.length).toBeLessThanOrEqual(500);
		expect(intent.request).not.toMatch(/\u0007/);
	});

	it("commits with an Intent-Id trailer", () => {
		expect(parseTrailers(draftMessage(input.id, "work/my-change", 2))["Intent-Id"]).toBe(input.id);
	});
});

describe("needsIntentCheck", () => {
	const p = { branch: "work/my-change", mode: "merge" as const };

	it("checks outside pushes and direct triggers", () => {
		expect(needsIntentCheck(p, "event")).toBe(true);
		expect(needsIntentCheck(p, "direct")).toBe(true);
	});

	it("skips platform-made pushes, re-gates, and check mode", () => {
		for (const source of ["customize", "seed", "repair", "repair-apply", "outside-push"] as const) expect(needsIntentCheck(p, source)).toBe(false);
		expect(needsIntentCheck({ ...p, regateOf: "a".repeat(40) }, "event")).toBe(false);
		expect(needsIntentCheck({ ...p, mode: "check" }, "event")).toBe(false);
	});
});

describe("harvest of drafted records", () => {
	it("reads records drafted for outside pushes", () => {
		const intent = draftOutsideIntent({ id: "int_x", userId: "u", branch: "work/x", stockTag: "v1.10.0", commits: [{ oid: "4".repeat(40), message: "Add REDCap enrollment" }], changes: [{ path: "connectors/redcap.ts", status: "added" }] });
		expect(harvestable(intent)).toBe(true);
		expect(tokensOf(intent)).toEqual(expect.arrayContaining(["redcap", "file:connectors/redcap.ts"]));
	});
});

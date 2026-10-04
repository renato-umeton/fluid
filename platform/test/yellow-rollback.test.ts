import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { commitChanges, headCommit, initRepo, listTrackedFiles, parseTrailers, readCommitMessage, readWorkspaceFile, writeFiles, removeFiles } from "../src/git/ops.ts";
import { changeIntents, decideRollback, revertMain, rollbackIntent, rollbackMessage } from "../src/yellow/rollback.ts";
import type { BuildTimeIntent } from "../src/forks/provision.ts";

const Y = "y".repeat(40);
const G = "g".repeat(40);
const failure = { tier: "stock", scenario: "e2e-ledger-provenance", step: "ask", detail: "ledger.fork_commit equals" };
const intent = (id: string): BuildTimeIntent => ({ id, author: "user:u", agent: "customization-agent", request: "r", purpose: "p", modes_affected: [], files: [], tests_added: [], stock_tag: "v1.10.0", created_at: "2026-10-04T00:00:00Z" });

describe("decideRollback", () => {
	const base = { mainHead: Y, yellowCommit: Y, lastGreenCommit: G, currentRunId: "run_1", runId: "run_1" };

	it("reverts when main is still at the yellow commit", () => {
		expect(decideRollback(base)).toEqual({ action: "revert", to: G });
	});

	it("cancels the older run when a newer change is yellow", () => {
		expect(decideRollback({ ...base, currentRunId: "run_2", mainHead: "n".repeat(40) })).toMatchObject({ action: "cancel", reason: expect.stringMatching(/newer change/) });
	});

	it("cancels when main moved for any other reason", () => {
		expect(decideRollback({ ...base, mainHead: "n".repeat(40) })).toMatchObject({ action: "cancel", reason: expect.stringMatching(/main moved/) });
	});

	it("does nothing to main when there is no earlier green commit", () => {
		expect(decideRollback({ ...base, lastGreenCommit: null }).action).toBe("none");
		expect(decideRollback({ ...base, lastGreenCommit: Y }).action).toBe("none");
	});
});

describe("revertMain", () => {
	async function history() {
		const ws = await initRepo();
		await writeFiles(ws, { "app/index.ts": "export const v = 1;\n", "fluid.toml": 'stock_tag = "v1.9.0"\n', ".intent/int_a.json": "{}\n" });
		const green = await commitChanges(ws, { message: "green" });
		await writeFiles(ws, { "app/index.ts": "export const v = 2;\n", "connectors/redcap.ts": "export {};\n", ".intent/int_b.json": "{}\n", "fluid.toml": 'stock_tag = "v1.10.0"\n' });
		const yellow = await commitChanges(ws, { message: "yellow", intentId: "int_b" });
		return { ws, green, yellow };
	}

	it("restores the last green tree with a new commit on top of the yellow commit, keeping history", async () => {
		const { ws, green, yellow } = await history();
		const rb = rollbackIntent({ id: "int_rb", userId: "u", repo: "user-u", yellowCommit: yellow, greenCommit: green, failure, runId: "run_1", stockTag: "v1.9.0", relies: ["int_b"] });
		const result = await revertMain({ remote: { url: "", token: "" }, yellowCommit: yellow, greenCommit: green, intent: rb, message: rollbackMessage({ yellowCommit: yellow, greenCommit: green, failure, runId: "run_1", relies: ["int_b"] }), ws });
		expect(result.ok).toBe(true);
		const head = await headCommit(ws, "main");
		expect(head).toBe(result.commit);
		const { commit } = await git.readCommit({ fs: ws.fs, dir: ws.dir, oid: head });
		expect(commit.parent).toEqual([yellow]);
		expect(await readWorkspaceFile(ws, "app/index.ts")).toBe("export const v = 1;\n");
		expect(await readWorkspaceFile(ws, "fluid.toml")).toBe('stock_tag = "v1.9.0"\n');
		expect((await listTrackedFiles(ws, head)).sort()).toEqual([".intent/int_a.json", ".intent/int_rb.json", "app/index.ts", "fluid.toml"]);
		const message = await readCommitMessage(ws, head);
		expect(message).toMatch(/^Roll back main to green/);
		expect(message).toContain("e2e-ledger-provenance at step ask");
		expect(parseTrailers(message)["Intent-Id"]).toBe("int_rb");
		expect(JSON.parse((await readWorkspaceFile(ws, ".intent/int_rb.json"))!)).toMatchObject({ agent: "yellow-rollback", relies_on: ["int_b"], rolled_back: yellow, restored: green, failed_scenario: "e2e-ledger-provenance", failed_step: "ask" });
	});

	it("refuses when main is no longer at the yellow commit", async () => {
		const { ws, green, yellow } = await history();
		await removeFiles(ws, ["connectors/redcap.ts"]);
		await commitChanges(ws, { message: "newer" });
		const rb = rollbackIntent({ id: "int_rb", userId: "u", repo: "user-u", yellowCommit: yellow, greenCommit: green, failure, runId: "run_1", stockTag: "v1.9.0", relies: [] });
		const result = await revertMain({ remote: { url: "", token: "" }, yellowCommit: yellow, greenCommit: green, intent: rb, message: "m", ws });
		expect(result).toMatchObject({ ok: false, commit: null, reason: expect.stringMatching(/not the yellow commit/) });
	});
});

describe("changeIntents", () => {
	it("lists the intent records the yellow change added", () => {
		expect(changeIntents([intent("int_a"), intent("int_b")], [intent("int_a")]).map((i) => i.id)).toEqual(["int_b"]);
	});
});

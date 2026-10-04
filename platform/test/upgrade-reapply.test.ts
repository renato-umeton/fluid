import { describe, expect, it } from "vitest";
import { commitChanges, initRepo, readWorkspaceFile, removeFiles, writeFiles } from "../src/git/ops.ts";
import { findRolledBackUpgrade, reapplyChange } from "../src/yellow/reapply.ts";
import { ROLLBACK_AUTHOR } from "../src/yellow/rollback.ts";
import { rerunTargets, upgradeInstanceId, upgradeTargets } from "../src/workflows/upgrade.ts";

async function rolledBackUpgrade() {
	const ws = await initRepo();
	await writeFiles(ws, { "app/cards.ts": "old wording\n", "app/custom.ts": "mine\n", "fluid.toml": 'stock_tag = "v1.5.0"\n', ".intent/int_a.json": "{}\n" });
	const green = await commitChanges(ws, { message: "green" });
	await writeFiles(ws, { "app/cards.ts": "new wording\n", "fluid.toml": 'stock_tag = "v1.10.0"\n', ".intent/int_merge.json": "{}\n", "tests/e2e/manifest.json": "{}\n" });
	const yellow = await commitChanges(ws, { message: "Merge stock v1.10.0" });
	await writeFiles(ws, { "app/cards.ts": "old wording\n", "fluid.toml": 'stock_tag = "v1.5.0"\n', ".intent/int_rb.json": "{}\n" });
	await removeFiles(ws, [".intent/int_merge.json", "tests/e2e/manifest.json"]);
	const revert = await commitChanges(ws, { message: "Roll back main to green\n\nYellow run run_yel-1.", author: ROLLBACK_AUTHOR });
	return { ws, green, yellow, revert };
}

describe("rolled back upgrades", () => {
	it("finds the revert of an earlier upgrade to the tag on main", async () => {
		const { ws, yellow, revert } = await rolledBackUpgrade();
		expect(await findRolledBackUpgrade(ws, "main", "v1.10.0")).toEqual({ revert, yellow });
		expect(await findRolledBackUpgrade(ws, "main", "v1.11.0")).toBeNull();
	});

	it("reapplies the upgrade's changes on top of main and keeps every intent record", async () => {
		const { ws, yellow, revert } = await rolledBackUpgrade();
		const result = await reapplyChange(ws, { from: revert, to: yellow });
		expect(result.kept).toEqual([]);
		expect(result.applied.sort()).toEqual([".intent/int_merge.json", "app/cards.ts", "fluid.toml", "tests/e2e/manifest.json"]);
		expect(await readWorkspaceFile(ws, "app/cards.ts")).toBe("new wording\n");
		expect(await readWorkspaceFile(ws, "fluid.toml")).toBe('stock_tag = "v1.10.0"\n');
		expect(await readWorkspaceFile(ws, ".intent/int_rb.json")).toBe("{}\n");
		expect(await readWorkspaceFile(ws, "app/custom.ts")).toBe("mine\n");
	});

	it("keeps main's version of a file the fork changed after the rollback", async () => {
		const { ws, yellow, revert } = await rolledBackUpgrade();
		await writeFiles(ws, { "app/cards.ts": "the user's own wording\n" });
		await commitChanges(ws, { message: "user change" });
		const result = await reapplyChange(ws, { from: revert, to: yellow });
		expect(result.kept).toEqual(["app/cards.ts"]);
		expect(await readWorkspaceFile(ws, "app/cards.ts")).toBe("the user's own wording\n");
	});
});

describe("release targets after a rollback", () => {
	const fork = (repo: string, extra: Record<string, unknown> = {}) => ({ repo, status: "pinned", pinnedTag: "v1.5.0", lastRun: null, pendingUpgrade: null, health: { health: "green" }, ...extra });
	const rolled = fork("user-rolled", { status: "passed", lastRun: { kind: "upgrade", tag: "v1.10.0", applied: true }, health: { health: "rolled_back" } });
	const done = fork("user-done", { status: "passed", lastRun: { kind: "upgrade", tag: "v1.10.0", applied: true } });

	it("a fork whose upgrade to the tag was rolled back is upgraded again when the release runs again", () => {
		expect(upgradeTargets("v1.10.0", [rolled, done])).toEqual(["user-rolled"]);
		expect(rerunTargets("v1.10.0", [rolled, done])).toEqual(["user-rolled"]);
	});

	it("the re-run gets its own upgrade instance", () => {
		expect(upgradeInstanceId("v1.10.0", "user-rolled", "abc123")).not.toBe(upgradeInstanceId("v1.10.0", "user-rolled"));
		expect(upgradeInstanceId("v1.10.0", "user-rolled", "abc123")).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
	});
});

// After the replay's apply step gave up, the upgrade checks whether main
// already holds the replay commit (a try pushed it before failing) before it
// falls back to the merge path.
import { describe, expect, it } from "vitest";
import { checkoutBranch, commitChanges, initRepo, resetBranch, writeFiles } from "../src/git/ops.ts";
import { mainHoldsCommit } from "../src/workflows/upgrade.ts";

async function repo() {
	const ws = await initRepo();
	await writeFiles(ws, { "fluid.toml": 'stock_tag = "v1.1.0"\n' });
	const before = await commitChanges(ws, { message: "main" });
	await checkoutBranch(ws, "replay/v1.2.0", { create: true, from: "main" });
	await writeFiles(ws, { "fluid.toml": 'stock_tag = "v1.2.0"\n' });
	const replay = await commitChanges(ws, { message: "replay" });
	await checkoutBranch(ws, "main");
	return { ws, before, replay };
}

describe("mainHoldsCommit", () => {
	it("is null while main does not contain the replay commit (fall back to merge)", async () => {
		const { ws, replay } = await repo();
		expect(await mainHoldsCommit(ws, replay, null)).toBeNull();
	});

	it("reports a landed replay with main's previous head when a try pushed main and no yellow run started", async () => {
		const { ws, before, replay } = await repo();
		await resetBranch(ws, "main", replay);
		expect(await mainHoldsCommit(ws, replay, before)).toEqual({ landed: true, previous: before });
	});

	it("does not start a second yellow run when the fork's health already names the commit", async () => {
		const { ws, replay } = await repo();
		await resetBranch(ws, "main", replay);
		expect(await mainHoldsCommit(ws, replay, replay)).toEqual({ landed: false, previous: null });
	});

	it("counts main that moved past the replay commit as applied, without a yellow run for it", async () => {
		const { ws, replay } = await repo();
		await resetBranch(ws, "main", replay);
		await writeFiles(ws, { "app/later.ts": "1\n" });
		await commitChanges(ws, { message: "later" });
		expect(await mainHoldsCommit(ws, replay, null)).toEqual({ landed: false, previous: null });
	});
});

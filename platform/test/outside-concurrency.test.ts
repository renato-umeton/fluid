// An outside push lands on main while a customize run is in flight: the
// customize run's gate passes, finds main moved, and either re-merges main
// into its branch for another gate or stops cleanly on a conflict. main is
// never written by the planner.
import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { protocolsFor, replanOnMovedMain, tauChange, matchRecipe } from "../src/agents/recipes.ts";
import { mainMovedNote, planMainAdvance } from "../src/gate/advance.ts";
import { checkoutBranch, commitChanges, headCommit, initRepo, readWorkspaceFile, writeFiles, type Workspace } from "../src/git/ops.ts";

const TOML = 'stock_tag = "v1.10.0"\n\n[thresholds]\ntau = 0.85\n';

/** main at the fork's start, a customize branch cut from it, then an outside change gated onto main. */
async function inFlight(outside: Record<string, string>) {
	const ws = await initRepo();
	await writeFiles(ws, { "fluid.toml": TOML, "app/index.ts": "export const v = 1;\n", "app/cards.ts": "export const c = 1;\n" });
	const start = await commitChanges(ws, { message: "onboard" });
	await checkoutBranch(ws, "work/customize", { create: true, from: "main" });
	await writeFiles(ws, { "app/cards.ts": "export const c = 2;\n", ".intent/int_c.json": '{"id":"int_c"}\n' });
	const customized = await commitChanges(ws, { message: "customize", intentId: "int_c" });
	await git.writeRef({ fs: ws.fs, dir: ws.dir, ref: "refs/remotes/origin/work/customize", value: customized, force: true });
	await checkoutBranch(ws, "main");
	await writeFiles(ws, { ...outside, ".intent/int_o.json": '{"id":"int_o"}\n' });
	const outsideOnMain = await commitChanges(ws, { message: "outside push, drafted and gated", intentId: "int_o" });
	return { ws, start, customized, outsideOnMain };
}

async function mainHead(ws: Workspace) {
	return headCommit(ws, "refs/heads/main");
}

describe("planMainAdvance with an outside push on main", () => {
	it("re-merges main into the customize branch when the outside push touched other files", async () => {
		const { ws, customized, outsideOnMain } = await inFlight({ "app/index.ts": "export const v = 2;\n" });
		const plan = await planMainAdvance(ws, { branch: "work/customize", commit: customized, message: "Merge main into work/customize" });
		expect(plan.outcome).toBe("regate");
		if (plan.outcome !== "regate") return;
		expect(plan.mainHead).toBe(outsideOnMain);
		const { commit } = await git.readCommit({ fs: ws.fs, dir: ws.dir, oid: plan.merge });
		expect(commit.parent).toEqual([customized, outsideOnMain]);
		expect(await readWorkspaceFile(ws, "app/index.ts")).toBe("export const v = 2;\n");
		expect(await readWorkspaceFile(ws, "app/cards.ts")).toBe("export const c = 2;\n");
		expect(await mainHead(ws)).toBe(outsideOnMain);
	});

	it("stops with the conflicting files when both changed the same lines, leaving main alone", async () => {
		const { ws, customized, outsideOnMain } = await inFlight({ "app/cards.ts": "export const c = 3;\n" });
		const plan = await planMainAdvance(ws, { branch: "work/customize", commit: customized, message: "m" });
		expect(plan).toEqual({ outcome: "conflict", mainHead: outsideOnMain, files: ["app/cards.ts"] });
		expect(await mainHead(ws)).toBe(outsideOnMain);
		expect(await headCommit(ws, "work/customize")).toBe(customized);
	});

	it("fast-forwards when main did not move", async () => {
		const { ws, start, customized } = await inFlight({});
		await git.writeRef({ fs: ws.fs, dir: ws.dir, ref: "refs/heads/main", value: start, force: true });
		const plan = await planMainAdvance(ws, { branch: "work/customize", commit: customized, message: "m" });
		expect(plan).toEqual({ outcome: "fast-forward", previous: start });
		expect(await mainHead(ws)).toBe(customized);
	});

	it("leaves the decision to a newer gate when the branch moved on", async () => {
		const { ws, customized } = await inFlight({ "app/index.ts": "export const v = 2;\n" });
		await git.writeRef({ fs: ws.fs, dir: ws.dir, ref: "refs/remotes/origin/work/customize", value: await mainHead(ws), force: true });
		const plan = await planMainAdvance(ws, { branch: "work/customize", commit: customized, message: "m" });
		expect(plan.outcome).toBe("branch-moved");
	});
});

describe("replanOnMovedMain with an outside push", () => {
	it("applies a tau recipe again on the fluid.toml the outside push changed", async () => {
		const request = "Raise my confidence threshold to 0.9";
		const recipe = matchRecipe(request);
		if (recipe?.kind !== "tau") throw new Error("expected the tau recipe");
		const change = tauChange(TOML, recipe);
		const moved = `${TOML}\n[preferences]\nharvest_opt_in = true\n`;
		const result = replanOnMovedMain({ change, request, before: { "fluid.toml": TOML }, current: { "fluid.toml": moved }, protocols: protocolsFor([], null) });
		expect("files" in result && result.replanned).toEqual(["fluid.toml"]);
		expect("files" in result && result.files["fluid.toml"]).toMatch(/harvest_opt_in = true/);
	});

	it("refuses a model plan whose file the outside push changed", () => {
		const change = { summary: "s", purpose: "p", modes_affected: [], files: { "app/cards.ts": "x" }, notes: {}, recipe: "model" as const };
		const result = replanOnMovedMain({ change, request: "reword cards", before: { "app/cards.ts": "a" }, current: { "app/cards.ts": "b" }, protocols: [] });
		expect(result).toEqual({ error: expect.stringMatching(/run the request again/) });
	});
});

describe("mainMovedNote", () => {
	const head = "b".repeat(40);

	it("names an outside push that moved main", () => {
		expect(mainMovedNote({ mainHead: head, health: { commit: head, source: "outside-push", runId: "run_yel-1" } })).toBe(" by an outside push (run_yel-1)");
	});

	it("says nothing more for other movers", () => {
		expect(mainMovedNote({ mainHead: head, health: { commit: head, source: "customize", runId: "run_yel-1" } })).toBe("");
		expect(mainMovedNote({ mainHead: head, health: { commit: "c".repeat(40), source: "outside-push", runId: null } })).toBe("");
		expect(mainMovedNote({ mainHead: head, health: null })).toBe("");
	});
});

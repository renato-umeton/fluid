// Commits an intent replay as the branch replay/<tag>. History stays honest:
//
//   stock <tag> > start (fork settings, records, own tests) > wish 1 > wish 2 > replay head
//                                                                                  |
//   main > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > > >  merge commit
//
// The branch starts at stock's tag commit. One commit carries what belongs
// to the fork but is not a wish (fluid.toml preferences and the new pin,
// intent records, repair notes, its own tests). Then each wish gets its own
// commit with its Intent-Id trailer. Last comes a merge commit whose first
// parent is main and whose second parent is the replay head, with the
// replayed tree. main is an ancestor of it, so main moves there only by
// fast-forward, like every other change, and `git log --first-parent main`
// still reads as the fork's own history.
import type { BuildTimeIntent } from "./provision.ts";
import { isCarriedPath, isWish, orderIntents, planReplay, treeGuard, type ReplayPlan } from "../agents/replay.ts";
import { commitChanges, headCommit, intentCommitOrder, readBlobBytes, readTree, resetBranch, writeFiles, type FileContent, type GitAuthor, type TreeFile, type Workspace } from "../git/ops.ts";

export const REPLAY_AUTHOR: GitAuthor = { name: "Fluid replay", email: "replay@fluid.invalid" };

export function replayBranchName(tag: string): string {
	return `replay/${tag}`;
}

function textOf(tree: Record<string, TreeFile>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [path, entry] of Object.entries(tree)) if (entry.text !== null) out[path] = entry.text;
	return out;
}

/**
 * Reads main and stock at both tags from the working copy and plans the
 * replay. Trees with anything but plain files, or with binary files outside
 * the carried folders, take the merge path, as do an intent record that is
 * not valid JSON and a stock tag with no fluid.toml. These never change on
 * a retry, so they are merge plans; only git and platform errors throw.
 */
export async function prepareReplay(
	ws: Workspace,
	input: { main: string; stockCommit: string; fromCommit: string; tag: string; fromTag: string; safety?: boolean },
): Promise<{ plan: ReplayPlan; mainTree: Record<string, TreeFile>; stockFiles: Record<string, string>; wishes: number }> {
	const [mainTree, stockTree, fromTree] = await Promise.all([readTree(ws, input.main), readTree(ws, input.stockCommit), readTree(ws, input.fromCommit)]);
	const mainFiles = textOf(mainTree);
	const stockFiles = textOf(stockTree);
	const intents: BuildTimeIntent[] = [];
	for (const [path, entry] of Object.entries(mainTree)) {
		if (!path.startsWith(".intent/") || !path.endsWith(".json")) continue;
		try {
			intents.push(JSON.parse(entry.text ?? "") as BuildTimeIntent);
		} catch {
			return { plan: { mode: "merge", reason: `intent record ${path} is not valid JSON`, results: [] }, mainTree, stockFiles, wishes: 0 };
		}
	}
	for (const [name, files] of [[input.tag, stockFiles], [input.fromTag, textOf(fromTree)]] as const) {
		if (files["fluid.toml"] === undefined) return { plan: { mode: "merge", reason: `stock ${name} has no fluid.toml`, results: [] }, mainTree, stockFiles, wishes: 0 };
	}
	const ordered = orderIntents(intents, await intentCommitOrder(ws, input.main));
	const wishes = ordered.filter(isWish).length;
	const guard = treeGuard([
		{ name: "main", files: mainTree },
		{ name: `stock ${input.tag}`, files: stockTree },
		{ name: `stock ${input.fromTag}`, files: fromTree },
	]);
	if (guard && wishes > 0) return { plan: { mode: "merge", reason: guard, results: [] }, mainTree, stockFiles, wishes };
	const plan = planReplay({ tag: input.tag, fromTag: input.fromTag, stockAtTag: stockFiles, stockAtFrom: textOf(fromTree), mainFiles, intents: ordered, safety: input.safety });
	return { plan, mainTree, stockFiles, wishes };
}

/** True when main has at least one wish record (an unreadable record counts, so replay can say why it fails). */
export async function hasWishes(ws: Workspace, main: string): Promise<boolean> {
	const tree = await readTree(ws, main);
	return Object.entries(tree).some(([path, entry]) => {
		if (!path.startsWith(".intent/") || !path.endsWith(".json")) return false;
		try {
			return isWish(JSON.parse(entry.text ?? "") as BuildTimeIntent);
		} catch {
			return true;
		}
	});
}

function changedFrom(before: Record<string, string>, after: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(after).filter(([path, text]) => before[path] !== text && !isCarriedPath(path)));
}

export async function buildReplayBranch(
	ws: Workspace,
	input: { branch: string; tag: string; stockCommit: string; main: string; plan: Extract<ReplayPlan, { mode: "replay" }>; stockFiles: Record<string, string>; mainTree: Record<string, TreeFile> },
): Promise<{ commit: string; replayHead: string; commits: { intentId: string; commit: string }[] }> {
	const { plan, tag } = input;
	await resetBranch(ws, input.branch, input.stockCommit);
	// Carried files are copied from main by their bytes, so binary test fixtures survive unchanged.
	const carried: Record<string, FileContent> = {};
	for (const [path, entry] of Object.entries(input.mainTree)) if (isCarriedPath(path)) carried[path] = await readBlobBytes(ws, entry.oid);
	await writeFiles(ws, { ...changedFrom(input.stockFiles, plan.base), ...carried });
	await commitChanges(ws, {
		message: `Start ${input.branch} from stock ${tag}\n\nCarries what belongs to this fork and is not a wish: the preferences in fluid.toml (now pinned to ${tag}), its intent records, and its own tests. Each wish follows as its own commit.`,
		author: REPLAY_AUTHOR,
	});
	const commits: { intentId: string; commit: string }[] = [];
	const byId = new Map(plan.results.map((r) => [r.intentId, r]));
	for (const step of plan.steps) {
		const result = byId.get(step.intentId);
		await writeFiles(ws, step.files);
		const commit = await commitChanges(ws, {
			message: `Replay wish ${step.intentId}: ${result?.request ?? ""}\n\n${result?.reason ?? "Replayed"}. Run again on stock ${tag} from its intent record.`,
			intentId: step.intentId,
			author: REPLAY_AUTHOR,
		});
		commits.push({ intentId: step.intentId, commit });
	}
	const replayHead = await headCommit(ws);
	const commit = await commitChanges(ws, {
		message: `Upgrade main to stock ${tag} by replaying ${commits.length} wish${commits.length === 1 ? "" : "es"}\n\nThe tree is stock ${tag} with this fork's wishes run again (second parent, ${replayHead.slice(0, 7)}). main is the first parent, so its history is kept and main reaches this commit by fast-forward.`,
		author: REPLAY_AUTHOR,
		parents: [input.main, replayHead],
	});
	return { commit, replayHead, commits };
}

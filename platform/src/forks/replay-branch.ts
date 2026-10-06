// Commits an intent replay as the branch replay/<tag>. History stays honest:
//
//   stock <tag> -- start (fork settings, records, own tests) -- wish 1 -- wish 2 ...   (replay head)
//                                                                                   \
//   main ---------------------------------------------------------------------------- merge commit
//
// The branch starts at stock's tag commit. One commit carries what belongs
// to the fork but is not a wish (fluid.toml preferences and the new pin,
// intent records, repair notes, its own tests). Then each wish gets its own
// commit with its Intent-Id trailer. Last comes a merge commit whose first
// parent is main and whose second parent is the replay head, with the
// replayed tree. main is an ancestor of it, so main moves there only by
// fast-forward, like every other change, and `git log --first-parent main`
// still reads as the fork's own history.
import type { ReplayPlan } from "../agents/replay.ts";
import { commitChanges, headCommit, resetBranch, writeFiles, type GitAuthor, type Workspace } from "../git/ops.ts";

export const REPLAY_AUTHOR: GitAuthor = { name: "Fluid replay", email: "replay@fluid.invalid" };

export function replayBranchName(tag: string): string {
	return `replay/${tag}`;
}

function changedFrom(before: Record<string, string>, after: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(after).filter(([path, text]) => before[path] !== text));
}

export async function buildReplayBranch(
	ws: Workspace,
	input: { branch: string; tag: string; stockCommit: string; main: string; plan: Extract<ReplayPlan, { mode: "replay" }>; stockFiles: Record<string, string> },
): Promise<{ commit: string; replayHead: string; commits: { intentId: string; commit: string }[] }> {
	const { plan, tag } = input;
	await resetBranch(ws, input.branch, input.stockCommit);
	await writeFiles(ws, changedFrom(input.stockFiles, plan.base));
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

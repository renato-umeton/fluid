// How a passed gate moves main, decided on a working copy that has main
// checked out and the gated branch fetched (refs/remotes/origin/<branch>).
// main only fast-forwards. When main moved meanwhile (another customization,
// an upgrade, or an outside push that passed its own gate), main is merged
// into the branch for another gate, or the run stops on a conflict. Nothing
// here pushes; the Gate workflow pushes what the plan says.
import { checkoutBranch, fastForward, headCommit, mergeInto, type Workspace } from "../git/ops.ts";

export type MainAdvance =
	| { outcome: "fast-forward"; previous: string }
	| { outcome: "already"; mainHead: string }
	| { outcome: "branch-moved"; branchHead: string }
	| { outcome: "conflict"; mainHead: string; files: string[] }
	| { outcome: "regate"; mainHead: string; merge: string };

export async function planMainAdvance(ws: Workspace, input: { branch: string; commit: string; message: string }): Promise<MainAdvance> {
	const previous = await headCommit(ws, "main");
	const ff = await fastForward(ws, "main", input.commit);
	if (ff.outcome === "fast-forward") return { outcome: "fast-forward", previous };
	if (ff.outcome === "already") return { outcome: "already", mainHead: ff.oid };
	const branchHead = await headCommit(ws, `refs/remotes/origin/${input.branch}`);
	if (branchHead !== input.commit) return { outcome: "branch-moved", branchHead };
	await checkoutBranch(ws, input.branch);
	const merged = await mergeInto(ws, { ours: input.branch, theirs: "main", message: input.message });
	if (!merged.ok) return { outcome: "conflict", mainHead: ff.oid, files: merged.conflicts.filepaths };
	return { outcome: "regate", mainHead: ff.oid, merge: merged.oid };
}

/** Extra words for a timeline line when the commit main moved to was landed by an outside push. */
export function mainMovedNote(input: { mainHead: string; health: { commit: string | null; source: string | null; runId: string | null } | null }): string {
	if (!input.health || input.health.commit !== input.mainHead || input.health.source !== "outside-push") return "";
	return ` by an outside push${input.health.runId ? ` (${input.health.runId})` : ""}`;
}

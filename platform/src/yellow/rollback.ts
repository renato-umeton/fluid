// Rollback of a failed yellow change. main moves back to the last green
// commit's tree with a new revert commit on top of the yellow commit: the
// history stays as it was and the push is never forced, so the remote
// refuses it if main moved meanwhile. When main already moved on (a newer
// change is yellow), the older run is cancelled and the newer run decides.
import { buildIntent, intentJson, intentPath } from "../agents/intent.ts";
import type { BuildTimeIntent } from "../forks/provision.ts";
import { cloneRepo, commitChanges, headCommit, pushBranch, restoreTreeFrom, type GitAuthor, type Remote, type Workspace } from "../git/ops.ts";
import type { HealthFailure } from "./state.ts";

export const ROLLBACK_AUTHOR: GitAuthor = { name: "Fluid yellow soak", email: "yellow-soak@fluid.invalid" };

export type RollbackDecision = { action: "revert"; to: string } | { action: "cancel"; reason: string } | { action: "none"; reason: string };

/** What a failed yellow run may do to main. */
export function decideRollback(input: { mainHead: string | null; yellowCommit: string; lastGreenCommit: string | null; currentRunId: string | null; runId: string }): RollbackDecision {
	if (input.currentRunId !== input.runId) return { action: "cancel", reason: "a newer change landed on main and is yellow; its run decides" };
	if (input.mainHead !== input.yellowCommit) return { action: "cancel", reason: `main moved to ${input.mainHead?.slice(0, 7) ?? "nothing"} after ${input.yellowCommit.slice(0, 7)} landed` };
	if (!input.lastGreenCommit || input.lastGreenCommit === input.yellowCommit) return { action: "none", reason: "there is no earlier green commit to roll back to" };
	return { action: "revert", to: input.lastGreenCommit };
}

/**
 * True when `top` (main's head) is the revert commit this run already pushed:
 * its parent is the yellow commit, the yellow soak authored it, and its
 * message names this run. A retried roll back step then records that commit
 * instead of deciding again (main is no longer at the yellow commit).
 */
export function isOwnRevert(top: { parents: string[]; author: { email: string }; message: string } | null, input: { yellowCommit: string; runId: string }): boolean {
	if (!top) return false;
	return top.parents[0] === input.yellowCommit && top.author.email === ROLLBACK_AUTHOR.email && top.message.includes(`Yellow run ${input.runId}.`);
}

/** Build-time intent records the yellow change added (present at the yellow commit, absent at the last green one). */
export function changeIntents(atYellow: BuildTimeIntent[], atGreen: BuildTimeIntent[]): BuildTimeIntent[] {
	const before = new Set(atGreen.map((i) => i.id));
	return atYellow.filter((i) => !before.has(i.id));
}

export function rollbackIntent(input: { id: string; userId: string; repo: string; yellowCommit: string; greenCommit: string; failure: HealthFailure; runId: string; stockTag: string; relies: string[] }): BuildTimeIntent {
	return buildIntent({
		id: input.id,
		userId: input.userId,
		agent: "yellow-rollback",
		request: `Roll back ${input.yellowCommit.slice(0, 7)} after the end-to-end suite failed in yellow`,
		purpose: `Return main to the last green commit ${input.greenCommit.slice(0, 7)}: ${input.failure.tier} scenario ${input.failure.scenario}${input.failure.step ? ` failed at step ${input.failure.step}` : ""}`,
		modes: [],
		files: [intentPath(input.id)],
		stockTag: input.stockTag,
		extra: { relies_on: input.relies, rolled_back: input.yellowCommit, restored: input.greenCommit, failed_scenario: input.failure.scenario, failed_step: input.failure.step, failure: input.failure.detail, yellow_run: input.runId },
	});
}

export function rollbackMessage(input: { yellowCommit: string; greenCommit: string; failure: HealthFailure; runId: string; relies: string[] }): string {
	const body = [
		`${input.yellowCommit.slice(0, 7)} went live in yellow and the end-to-end suite failed: ${input.failure.tier} scenario ${input.failure.scenario}${input.failure.step ? ` at step ${input.failure.step}` : ""} (${input.failure.detail}).`,
		`This commit restores the tree of the last green commit; the failed change stays in history and a repair opens for it. Yellow run ${input.runId}.`,
		...(input.relies.length ? [`Change intent records: ${input.relies.join(", ")}.`] : []),
	];
	return `Roll back main to green ${input.greenCommit.slice(0, 7)}\n\n${body.join("\n")}`;
}

export interface RevertResult {
	ok: boolean;
	commit: string | null;
	reason?: string;
}

/**
 * Commits the last green tree (plus the rollback intent record) on top of
 * main and pushes without force. Refuses when main is not at the yellow
 * commit. `ws` may be passed in for tests; otherwise main is cloned.
 * `approve` records the move before the push (see forks/main-guard.ts).
 */
export async function revertMain(input: { remote: Remote; yellowCommit: string; greenCommit: string; intent: BuildTimeIntent; message: string; ws?: Workspace; approve?: (from: string, to: string) => Promise<void> }): Promise<RevertResult> {
	const ws = input.ws ?? (await cloneRepo({ ...input.remote, ref: "main", singleBranch: true }));
	const head = await headCommit(ws, "main");
	if (head !== input.yellowCommit) return { ok: false, commit: null, reason: `main is at ${head.slice(0, 7)}, not the yellow commit ${input.yellowCommit.slice(0, 7)}` };
	await restoreTreeFrom(ws, input.greenCommit, { [intentPath(input.intent.id)]: intentJson(input.intent) });
	const commit = await commitChanges(ws, { message: input.message, intentId: input.intent.id, author: ROLLBACK_AUTHOR });
	if (input.approve) await input.approve(head, commit);
	if (!input.ws) await pushBranch(ws, input.remote, "main");
	return { ok: true, commit };
}

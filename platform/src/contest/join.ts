// The owner's own agent joins a contest through the inbox: a push to
// work/contest-<id>/<name> is imported like any other inbox branch (caps,
// quotas, unsafe paths), as work/inbox/contest-<id>/<name>, but it is not
// gated on its own. It takes the contest's agent seat (once, while the join
// window is open) and the contest gates it in check mode with the others.
import { fleetStub, runsStub } from "../stubs.ts";
import { appExports } from "../workflows/common.ts";
import { contestIdOfBranch, joinDecision } from "./plan.ts";

/** Why an inbox push to a contest branch is refused before it is imported, or null (also for ordinary branches). */
export async function contestJoinRefusal(env: Env, fork: string, inboxBranch: string, now = Date.now()): Promise<string | null> {
	const contestId = contestIdOfBranch(inboxBranch);
	if (!contestId) return null;
	const decision = joinDecision(await fleetStub(env).contestState(fork), contestId, now);
	return decision.ok ? null : decision.reason;
}

/** Takes the agent seat for an imported branch, records the entry on the contest run, and wakes the contest. */
export async function joinContest(env: Env, ctx: unknown, input: { fork: string; branch: string; commit: string; importRunId: string }): Promise<{ ok: true; runId: string } | { ok: false; reason: string }> {
	const contestId = contestIdOfBranch(input.branch);
	if (!contestId) return { ok: false, reason: `${input.branch} is not a contest branch` };
	const decision = await fleetStub(env).joinContest(input.fork, contestId);
	if (!decision.ok) return decision;
	await runsStub(env, decision.runId).updateEntry("contestants", "label", "agent", { status: "joined", branch: input.branch, commit: input.commit, importRunId: input.importRunId, readyAt: new Date().toISOString() });
	await (await appExports(ctx).ContestWorkflow.get(decision.runId)).sendEvent({ type: "contest-joined", payload: { branch: input.branch, commit: input.commit } });
	return decision;
}

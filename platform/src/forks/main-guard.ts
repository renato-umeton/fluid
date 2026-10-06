// main guard. Artifacts tokens are scoped to a repo, not to branches, so an
// owner holding an outside token (forks/outside.ts) could push to main
// directly. main must only move through the gate, so every push the platform
// makes to main is recorded first (approveMainMove), and the queue consumer
// checks every main push of a fork that ever had an outside token: a move
// with no record is undone by pushing main back to where it was, and the
// pushed commits are kept on work/outside-main-<sha>, where the gate decides.
import { fnv1a, type MainPush } from "../events/filter.ts";
import { checkoutBranch, cloneRepo, hasCommit, listRemoteRefs, pushBranch, resetBranch } from "../git/ops.ts";
import { fleetStub, runsStub } from "../stubs.ts";
import { ensureRun, errorText, repoRemote, runLog, setFleet } from "../workflows/common.ts";
import { outsideGrantKey } from "./outside.ts";

const ZERO = "0".repeat(40);

export type MainPushDecision =
	| { action: "allow"; reason: string }
	| { action: "skip"; reason: string }
	| { action: "restore"; to: string; keep: string | null; reason: string };

/** Name of the record that says the platform moved main from `from` to `to`. */
export function mainMoveName(repo: string, from: string | null, to: string): string {
	return `mainmove_${repo}_${from ?? ZERO}_${to}`;
}

/** The work branch that keeps the commits of an outside push to main, so the gate can still decide on them. */
export function keptBranchFor(commit: string): string {
	return `work/outside-main-${commit.slice(0, 7)}`;
}

export function guardRunId(repo: string, after: string): string {
	return `run_guard_${after.slice(0, 12)}_${fnv1a(repo)}`;
}

/**
 * What to do with one push to main. `granted`: the fork ever had an outside
 * token; `approved`: the platform recorded this move before pushing it;
 * `mainNow`: main on the remote right now (null when it does not exist).
 */
export function decideMainPush(input: { before: string; after: string; granted: boolean; approved: boolean; mainNow: string | null }): MainPushDecision {
	if (!input.granted) return { action: "allow", reason: "no outside token was ever minted for this fork, so only the platform can push" };
	if (input.approved) return { action: "allow", reason: "the platform made this push" };
	const deleted = input.after === ZERO;
	if ((input.mainNow ?? ZERO) !== input.after) return { action: "skip", reason: `main moved on to ${input.mainNow?.slice(0, 7) ?? "nothing"}; the push that moved it decides` };
	if (input.before === ZERO) return { action: "skip", reason: "main had no earlier commit to restore" };
	return {
		action: "restore",
		to: input.before,
		keep: deleted ? null : keptBranchFor(input.after),
		reason: deleted ? "main was deleted outside the gate" : `main moved to ${input.after.slice(0, 7)} outside the gate`,
	};
}

/** Records, before the push, that the platform is moving main from `from` to `to`. */
export async function approveMainMove(env: Env, repo: string, from: string | null, to: string): Promise<void> {
	const id = mainMoveName(repo, from, to);
	const stub = runsStub(env, id);
	if (await stub.get()) return;
	try {
		await stub.create({ id, kind: "gate", repo, status: "passed", fields: { mainMove: true, from: from ?? ZERO, to } });
	} catch (error) {
		if (!/already exists/.test(String((error as Error).message))) throw error;
	}
}

async function isApprovedMove(env: Env, repo: string, from: string, to: string): Promise<boolean> {
	return (await runsStub(env, mainMoveName(repo, from, to)).get()) !== null;
}

/**
 * Checks one push to main and undoes it when the platform did not make it.
 * Throws on infrastructure errors, so the queue message is retried.
 */
export async function guardMainPush(env: Env, push: MainPush): Promise<MainPushDecision & { done?: string }> {
	const granted = (await fleetStub(env).getValue(outsideGrantKey(push.repo))) !== null;
	if (!granted) return decideMainPush({ ...push, granted, approved: false, mainNow: null });
	if (await isApprovedMove(env, push.repo, push.before, push.after)) return decideMainPush({ ...push, granted, approved: true, mainNow: null });
	const remote = await repoRemote(env, push.repo, "write");
	const heads = await listRemoteRefs(remote, undefined, { prefix: "refs/heads/" });
	const mainNow = heads.find((r) => r.ref === "refs/heads/main")?.oid ?? null;
	const decision = decideMainPush({ ...push, granted, approved: false, mainNow });
	if (decision.action !== "restore") return decision;

	const runId = guardRunId(push.repo, push.after);
	await ensureRun(env, { id: runId, kind: "gate", repo: push.repo, fields: { branch: "main", commit: push.after, mode: "merge", source: "outside-push", guard: true } });
	const log = runLog(env, runId);
	await log.step("Outside push to main", "failed", `${decision.reason}. main only moves through the gate, so it goes back to ${decision.to.slice(0, 7)}.`);
	const cloneRef = mainNow ? "main" : heads[0]?.ref.slice("refs/heads/".length);
	if (!cloneRef) throw new Error(`${push.repo} has no branch to clone`);
	const ws = await cloneRepo({ ...remote, ref: cloneRef });
	if (!(await hasCommit(ws, decision.to))) {
		const detail = `${decision.to.slice(0, 7)} is no longer in the repo (the push rewrote main's history), so main cannot be restored automatically. Ask an admin to reset main.`;
		await log.step("Restore main", "failed", detail);
		await log.status("failed", { error: detail });
		await setFleet(env, push.repo, { status: "failed", lastRun: { runId, kind: "gate", branch: "main", status: "failed", error: detail } });
		return { ...decision, done: "not restored" };
	}
	// The restore itself is a platform move: record it first so this guard lets its own push through.
	await approveMainMove(env, push.repo, push.after === ZERO ? null : push.after, decision.to);
	await resetBranch(ws, "main", decision.to);
	const still = (await listRemoteRefs(remote, undefined, { prefix: "refs/heads/main" })).find((r) => r.ref === "refs/heads/main")?.oid ?? null;
	if ((still ?? ZERO) !== push.after) {
		await log.step("Restore main", "info", `main moved again to ${still?.slice(0, 7) ?? "nothing"} before the restore; that push is checked on its own`);
		await log.status("cancelled");
		return { ...decision, done: "superseded" };
	}
	await pushBranch(ws, remote, "main", { force: true });
	await log.step("Restore main", "done", `main is back at ${decision.to.slice(0, 7)}`);
	const refused = `main only moves through the gate; ${decision.reason} was undone`;
	if (!decision.keep) {
		await log.status("failed", { error: refused });
		return { ...decision, done: "restored" };
	}
	try {
		await checkoutBranch(ws, decision.keep, { create: true, from: push.after });
		await pushBranch(ws, remote, decision.keep);
		await log.step("Keep the pushed commits", "done", `${decision.keep} at ${push.after.slice(0, 7)}; the gate checks it like any work branch and main moves only if it passes`);
	} catch (error) {
		await log.step("Keep the pushed commits", "failed", `Could not push ${decision.keep}: ${errorText(error)}. Push your commits to a work/ branch yourself.`);
	}
	await log.status("failed", { error: refused, keptBranch: decision.keep });
	return { ...decision, done: "restored" };
}

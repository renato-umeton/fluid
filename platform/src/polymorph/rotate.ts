// Rotation: moves a fork to its next renamed copy, and only once a check mode
// gate shows the new copy answers every probe like the plain fork. Whatever an
// attacker learned about the old copy goes stale; a copy that fails the check
// never goes live, and the fork keeps the copy it has. A busy fork runs no
// gate and keeps its copy, stale or not. A gate that could make no copy
// changes nothing, except that a stored copy the live path found stale and
// that no longer builds at all is cleared.
import type { MorphState } from "../durable/fleet.ts";
import { runGate } from "../gate/run.ts";
import type { GateFailure, GateResult } from "../gate/tiers.ts";
import { buildStoredCopy, type RuntimeDeps } from "../runtime/loader.ts";
import { headOf, openRepo } from "../runtime/repo-files.ts";
import { fleetStub } from "../stubs.ts";
import { PolymorphTransientError } from "./errors.ts";
import { NO_SECRET_REASON, polymorphSecret } from "./install.ts";

/**
 * Why a rotation runs: the schedule, a tripwire hit, a change landing on
 * main, an admin, a new fork installing, or a mismatch (the live path found
 * that the copy Fleet stored for main no longer loads as verified).
 */
export type RotationReason = "schedule" | "tripwire" | "landed" | "admin" | "install" | "mismatch";

export type RotationResult =
	/** The fork now serves the verified copy of main for this epoch. */
	| { outcome: "rotated"; repo: string; reason: RotationReason; epoch: number; sha: string; fingerprint: string; namesHash: string }
	/**
	 * The gate failed; the fork keeps its current copy. failures are the gate's
	 * first ones (copy names already mapped back), more the rest it recorded.
	 * cleared: the stored copy no longer builds, so it was cleared instead.
	 */
	| { outcome: "refused"; repo: string; reason: RotationReason; epoch: number; sha: string; failures: GateFailure[]; more: number; cleared?: true }
	/**
	 * Nothing ran or nothing changed, and why. busy: the fork was being
	 * provisioned, upgraded, or gated, so a later try may rotate it, and it
	 * keeps its stored copy, stale or not. cleared: a try on a free fork found
	 * that the stored copy no longer builds, so it was cleared.
	 */
	| { outcome: "skipped"; repo: string; reason: RotationReason; why: string; busy?: true; cleared?: true };

/** Statuses whose main is about to change or whose gate is running: a rotation now would check the wrong code or race it. */
const BUSY: ReadonlySet<string> = new Set(["provisioning", "upgrading", "gating"]);
const MAX_REFUSAL_FAILURES = 10;

/**
 * Moves a fork to its next epoch: runs a check mode gate on main with the
 * copy for that epoch (one sample per probe, since answers without the model
 * do not vary), stores the copy in Fleet when the gate passes, and records a
 * security event for a rotation or a refusal. Skips, changing nothing, when
 * the platform has no secret, the fork is not in the fleet or is busy, the
 * gate could make no copy (the skip says why), main moved while the gate
 * ran, or another rotation stored a copy first. Throws, like runGate, when
 * reading what the copy needs failed (PolymorphTransientError), so a workflow
 * step retries the rotation rather than skip it. A "mismatch" rotation that
 * finds the fork free and ends without a new copy then checks the stored
 * copy (clearUnbuildable).
 */
export async function rotateFork(deps: RuntimeDeps, repo: string, reason: RotationReason): Promise<RotationResult> {
	const skipped = (why: string): RotationResult => ({ outcome: "skipped", repo, reason, why });
	// polymorphSecret treats a short secret as none, so the reason names both.
	if (polymorphSecret(deps.env) === null) return skipped(NO_SECRET_REASON);
	const fleet = fleetStub(deps.env);
	const fork = await fleet.get(repo);
	if (!fork) return skipped("the fork is not in the fleet");
	// A busy fork keeps the copy it has, even a stale one: the live path goes on scanning with its names.
	if (BUSY.has(fork.status)) return { outcome: "skipped", repo, reason, why: `the fork is ${fork.status}`, busy: true };
	const current = await fleet.morphState(repo);
	// A cleared copy keeps its epoch: the next copy is numbered above it, never at an epoch a retired copy had.
	const epochBefore = current?.epoch ?? (await fleet.morphEpoch(repo));
	const result = await nextCopy(deps, repo, reason, epochBefore);
	if (reason !== "mismatch" || result.outcome === "rotated" || current === null) return result;
	return (await clearUnbuildable(deps, repo, current)) ? { ...result, cleared: true } : result;
}

/**
 * A stored copy the live path found stale, which this rotation did not
 * replace, is checked again; when it no longer builds at all, for a reason
 * that will not pass (the renamer or its limits changed, the secret makes
 * another copy, the pin or list broke), it is cleared, keeping its epoch so
 * no later copy reuses it, and that is recorded as a security event (never
 * broadcast). The fork then answers as one with no copy, plain, model and
 * all, instead of starting a rotation that cannot succeed in every window,
 * until a rotation (the schedule's, at the latest) installs a fresh one. A
 * failed read clears nothing. Returns whether it cleared the copy.
 */
async function clearUnbuildable(deps: RuntimeDeps, repo: string, current: MorphState): Promise<boolean> {
	const stored = await buildStoredCopy(deps, repo, current);
	if (stored.copy !== null || stored.plain.kind === "transient") return false;
	const fleet = fleetStub(deps.env);
	// Over the epoch just checked only: a rotation that stored a new copy meanwhile wins.
	if (!(await fleet.setMorph(repo, null, { from: current.epoch }))) return false;
	await fleet.recordSecurityEvent(repo, { kind: "copy_cleared", detail: { epoch: current.epoch, cause: stored.plain.kind, why: stored.plain.reason } });
	return true;
}

/** The gate and the store of a rotation of a fork that is free to rotate, from the fork's epoch before it (null: it never had a copy). */
async function nextCopy(deps: RuntimeDeps, repo: string, reason: RotationReason, epochBefore: number | null): Promise<RotationResult> {
	const skipped = (why: string): RotationResult => ({ outcome: "skipped", repo, reason, why });
	const fleet = fleetStub(deps.env);
	const epoch = (epochBefore ?? 0) + 1;
	const gate = await runGate(deps, { repo, ref: "main", mode: "check", samples: 1, morph: { epoch } });
	if (!gate.polymorph) {
		if (gate.polymorphPlain?.kind === "transient") throw new PolymorphTransientError(`the gate could not read what the renamed copy of main needs: ${gate.polymorphPlain.reason}`);
		return skipped(`the gate made no renamed copy of main: ${noCopyReason(gate)}`);
	}
	if (!gate.passed) {
		await fleet.recordSecurityEvent(repo, { kind: "rotation_refused", detail: { reason, epoch, failures: gate.failures.length } });
		return { outcome: "refused", repo, reason, epoch, sha: gate.commit, failures: gate.failures.slice(0, MAX_REFUSAL_FAILURES), more: Math.max(0, gate.failures.length - MAX_REFUSAL_FAILURES) };
	}
	const { fingerprint, namesHash, renamed } = gate.polymorph;
	// A copy serves only the commit it is of. If main moved while the gate ran, the landed change gets a rotation of its own.
	const head = await mainHead(deps.env, repo);
	if (head !== gate.commit) return skipped(head === null ? "main could not be read after the gate" : "main moved during the rotation");
	// What answers name the copy by: random, since the fingerprint comes from the secret and would let anyone test a guess of it.
	const variant = randomVariant();
	// Stored only over the epoch read before the gate: a rotation that finished first wins, and a retired copy stays retired.
	if (!(await fleet.setMorph(repo, { epoch, sha: gate.commit, fingerprint, namesHash, names: renamed, variant }, { from: epochBefore }))) {
		return skipped((await fleet.get(repo)) ? "another rotation moved the fork first" : "the fork left the fleet during the rotation");
	}
	await fleet.recordSecurityEvent(repo, { kind: "rotated", detail: { reason, epoch, fingerprint, variant } });
	return { outcome: "rotated", repo, reason, epoch, sha: gate.commit, fingerprint, namesHash };
}

/** Why a gate asked to check a copy ran without one: its error, the loader's reason, or the failure that stopped it before the copy loaded. */
function noCopyReason(gate: GateResult): string {
	if (gate.error) return gate.error;
	if (gate.polymorphPlain) return gate.polymorphPlain.reason;
	const first = gate.failures[0];
	if (!first) return "the gate stopped before it loaded a copy";
	return `${first.probe} failed: ${typeof first.actual === "string" ? first.actual : JSON.stringify(first.actual)}`;
}

/** Eight random lowercase hex characters. */
function randomVariant(): string {
	return [...crypto.getRandomValues(new Uint8Array(4))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function mainHead(env: Env, repo: string): Promise<string | null> {
	using handle = await openRepo(env.ARTIFACTS, repo);
	return headOf(handle, "main");
}

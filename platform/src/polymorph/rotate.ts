// Rotation: moves a fork to its next renamed copy, and only once a check mode
// gate shows the new copy answers every probe like the plain fork. Whatever an
// attacker learned about the old copy goes stale; a copy that fails the check
// never goes live, and the fork keeps the copy it has. A gate that could make
// no copy changes nothing.
import { runGate } from "../gate/run.ts";
import type { GateFailure } from "../gate/tiers.ts";
import type { RuntimeDeps } from "../runtime/loader.ts";
import { fleetStub } from "../stubs.ts";
import { polymorphSecret } from "./install.ts";

/** Why a rotation runs: the schedule, a tripwire hit, a change landing on main, or an admin. */
export type RotationReason = "schedule" | "tripwire" | "landed" | "admin";

export type RotationResult =
	/** The fork now serves the verified copy of main for this epoch. */
	| { outcome: "rotated"; repo: string; reason: RotationReason; epoch: number; sha: string; fingerprint: string; namesHash: string }
	/** The gate failed; the fork keeps its current copy. failures are the gate's first ones (copy names already mapped back), more the rest it recorded. */
	| { outcome: "refused"; repo: string; reason: RotationReason; epoch: number; sha: string; failures: GateFailure[]; more: number }
	/** Nothing ran or nothing changed, and why. */
	| { outcome: "skipped"; repo: string; reason: RotationReason; why: string };

/** Statuses whose main is about to change or whose gate is running: a rotation now would check the wrong code or race it. */
const BUSY: ReadonlySet<string> = new Set(["provisioning", "upgrading", "gating"]);
const MAX_REFUSAL_FAILURES = 10;

/**
 * Moves a fork to its next epoch: runs a check mode gate on main with the
 * copy for that epoch (one sample per probe, since answers without the model
 * do not vary), stores the copy in Fleet when the gate passes, and records a
 * security event for a rotation or a refusal. Skips, changing nothing, when
 * the platform has no secret, the fork is not in the fleet or is busy, or the
 * gate could make no copy.
 */
export async function rotateFork(deps: RuntimeDeps, repo: string, reason: RotationReason): Promise<RotationResult> {
	const skipped = (why: string): RotationResult => ({ outcome: "skipped", repo, reason, why });
	if (polymorphSecret(deps.env) === null) return skipped("POLYMORPH_SECRET is not set");
	const fleet = fleetStub(deps.env);
	const fork = await fleet.get(repo);
	if (!fork) return skipped("the fork is not in the fleet");
	if (BUSY.has(fork.status)) return skipped(`the fork is ${fork.status}`);
	const epoch = ((await fleet.morphState(repo))?.epoch ?? 0) + 1;
	const gate = await runGate(deps, { repo, ref: "main", mode: "check", samples: 1, morph: { epoch } });
	if (!gate.polymorph) return skipped(`the gate made no renamed copy of main${gate.error ? `: ${gate.error}` : "; the platform log says why"}`);
	if (!gate.passed) {
		await fleet.recordSecurityEvent(repo, { kind: "rotation_refused", detail: { reason, epoch, failures: gate.failures.length } });
		return { outcome: "refused", repo, reason, epoch, sha: gate.commit, failures: gate.failures.slice(0, MAX_REFUSAL_FAILURES), more: Math.max(0, gate.failures.length - MAX_REFUSAL_FAILURES) };
	}
	const { fingerprint, namesHash } = gate.polymorph;
	if (!(await fleet.setMorph(repo, { epoch, sha: gate.commit, fingerprint, namesHash }))) return skipped("the fork left the fleet during the rotation");
	await fleet.recordSecurityEvent(repo, { kind: "rotated", detail: { reason, epoch, fingerprint } });
	return { outcome: "rotated", repo, reason, epoch, sha: gate.commit, fingerprint, namesHash };
}

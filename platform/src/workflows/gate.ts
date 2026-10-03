// Gate Workflow (spec 4.3): one instance per push to a fork work branch,
// started by the queue consumer or directly (customize, local dev, repair
// apply). Runs the three tiers against the pushed commit with stock's suites
// at the pinned tag. On pass, main fast-forwards to the gated commit; if main
// moved, main is merged into the branch and that merge commit is gated
// first. On fail main is untouched and the Repair workflow starts. Repair
// branches are only checked, unless the user applies one (merge mode).
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { fnv1a, gateInstanceId } from "../events/filter.ts";
import { checkoutBranch, cloneRepo, fastForward, fetchBranch, headCommit, mergeInto, pushBranch } from "../git/ops.ts";
import { runGate } from "../gate/run.ts";
import { gateBrief, type GateResult } from "../gate/tiers.ts";
import { fleetStub } from "../stubs.ts";
import { appExports, asJson, ensureRun, GATE_STEP, gateLinkOf, GIT_STEP, guarded, linkGateParent, notifyParent, repoRemote, runLog, setFleet, startGateInstance, startInstance, steps, type GateParams } from "./common.ts";

export function gateRunId(instanceId: string): string {
	return `run_${instanceId}`;
}

export function repairRunId(repo: string, commit: string): string {
	return `run_repair_${commit.slice(0, 12)}_${fnv1a(repo)}`;
}

export function tierDetail(gate: GateResult, tier: "invariant" | "functional" | "user"): string {
	const t = gate.tiers[tier];
	if (!t) return "not run";
	const disabled = t.disabled?.length ? `; ${t.disabled.length} disabled (logged): ${t.disabled.map((d) => d.id).join(", ")}` : "";
	if (t.total === 0) return `${t.note ?? "nothing to run"}${disabled}`;
	const failing = t.probes.filter((p) => !p.passed).map((p) => p.id);
	return `${t.total - t.failed} / ${t.total} probes passed${failing.length ? `; failing: ${failing.slice(0, 4).join(", ")}${failing.length > 4 ? "..." : ""}` : ""}${disabled}`;
}

/** Records a finished gate everywhere the UI reads it: the run, the fork's gate list, and the parent run. */
export async function persistGate(env: Env, gate: GateResult, runId: string, parentRunId?: string): Promise<void> {
	const withId = { ...gate, runId };
	await fleetStub(env).addGate(gate.repo, asJson(withId) as Record<string, never>);
	await runLog(env, runId).update({ gate: withId });
	if (parentRunId) await runLog(env, parentRunId).update({ gate: withId }).catch(() => undefined);
}

export async function logTiers(env: Env, runId: string, gate: GateResult, prefix = ""): Promise<void> {
	const log = runLog(env, runId);
	if (gate.error && !gate.tiers.invariant) {
		await log.step(`${prefix}Gate setup`, "failed", gate.error);
		return;
	}
	await log.step(`${prefix}Tier 1: invariants at ${gate.stockTag}`, gate.tiers.invariant?.passed ? "done" : "failed", tierDetail(gate, "invariant"));
	await log.step(`${prefix}Tier 2: functional at ${gate.stockTag}`, gate.tiers.functional?.passed ? "done" : "failed", tierDetail(gate, "functional"));
	await log.step(`${prefix}Tier 3: user tests`, gate.tiers.user?.passed === false ? "failed" : "done", tierDetail(gate, "user"));
}

export class GateWorkflow extends WorkflowEntrypoint<Env, GateParams> {
	async run(event: Readonly<WorkflowEvent<GateParams>>, workflowStep: WorkflowStep) {
		const p = event.payload;
		return guarded(steps(workflowStep), this.env, { runId: p.runId ?? gateRunId(event.instanceId), kind: "gate", repo: p.repo, ...(p.mode === "merge" ? { fleetStatus: "failed" as const, lastRun: { branch: p.branch } } : {}) }, () => this.execute(event, workflowStep));
	}

	private async execute(event: Readonly<WorkflowEvent<GateParams>>, workflowStep: WorkflowStep) {
		const step = steps(workflowStep);
		const p = event.payload;
		const runId = p.runId ?? gateRunId(event.instanceId);
		const exports = appExports(this.ctx);
		const log = runLog(this.env, runId);
		const short = p.commit.slice(0, 7);

		// The parent (customize run, repair apply) comes from the params or, when the push event started
		// this gate first, from the link the pushing workflow recorded before it pushed.
		const origin = await step.do("start", async () => {
			const link = p.parentRunId ? null : await gateLinkOf(this.env, p.repo, p.branch, p.commit);
			const parentRunId = p.parentRunId ?? link?.parentRunId ?? null;
			const source = link?.source ?? p.source;
			await ensureRun(this.env, { id: runId, kind: "gate", repo: p.repo, fields: { branch: p.branch, commit: p.commit, mode: p.mode, source, parentRunId, regateOf: p.regateOf ?? null } });
			await log.step(`Gate ${p.branch} at ${short}`, "running", `Triggered by ${source}${p.regateOf ? ` (main moved: this is the merge of main into ${p.branch})` : ""}; reading fluid.toml for the pinned stock tag`);
			if (p.mode === "merge") await setFleet(this.env, p.repo, { status: "gating", lastRun: { runId, kind: "gate", branch: p.branch, status: "running" } });
			return { parentRunId, source };
		});

		const gate = await step.do("run tiers", GATE_STEP, async () => {
			const result = await runGate({ env: this.env, exports }, { repo: p.repo, ref: p.branch, commit: p.commit, mode: p.mode });
			await log.step(`Gate ${p.branch} at ${short}`, "done", `Stock ${result.stockTag ?? "?"} suites loaded from stock; fork and runner in separate isolates (${result.durationMs} ms)`);
			await logTiers(this.env, runId, result);
			await persistGate(this.env, result, runId, origin.parentRunId ?? undefined);
			return result;
		});

		if (gate.passed && p.mode === "merge") {
			const merged = await step.do("merge to main", GIT_STEP, async () => this.advanceMain(p, runId, origin.parentRunId, origin.source));
			if (merged.regate) {
				const next = await step.do("gate the merge commit", async () => {
					const started = await startGateInstance(exports.GateWorkflow, gateInstanceId(p.repo, p.branch, merged.regate!), {
						repo: p.repo,
						branch: p.branch,
						commit: merged.regate!,
						mode: "merge",
						source: origin.source,
						...(origin.parentRunId ? { parentRunId: origin.parentRunId } : {}),
						regateOf: p.commit,
					});
					await log.step("Gate the merge commit", "done", `${started.runId} gates ${p.branch} at ${merged.regate!.slice(0, 7)}; main moves only if it passes`);
					await log.status("passed", { mergedCommit: null, regateRunId: started.runId });
					return started.runId;
				});
				return { ...gateBrief(gate), merged: false, regateRunId: next };
			}
			await step.do("finish pass", async () => {
				await log.status(merged.ok ? "passed" : "failed", { mergedCommit: merged.oid });
				const pin = merged.ok && gate.stockTag ? { pinnedTag: gate.stockTag } : {};
				await setFleet(this.env, p.repo, { status: "pinned", ...pin, ...(merged.ok ? { pendingUpgrade: null } : {}), lastRun: { runId, kind: "gate", branch: p.branch, status: merged.ok ? "passed" : "failed", merged: merged.ok, ...gateBrief(gate) } });
				if (origin.parentRunId) await notifyParent(this.env, exports, origin.parentRunId, "gate-finished", { gateRunId: runId, passed: true, merged: merged.ok, mergedCommit: merged.oid });
				return true;
			});
			return { ...gateBrief(gate), merged: merged.ok };
		}

		if (!gate.passed && p.mode === "merge") {
			await step.do("hand off to repair", async () => {
				await log.step("Merge blocked", "failed", `${p.branch} stays unmerged; main is untouched. ${gateBrief(gate).firstFailure ?? ""}`);
				const repairId = repairRunId(p.repo, p.commit);
				// A repair branch that fails when applied does not get a repair of its own.
				if (origin.source !== "repair-apply") {
					await startInstance(exports.RepairWorkflow, repairId.replace(/^run_/, ""), {
						runId: repairId,
						repo: p.repo,
						branch: p.branch,
						commit: p.commit,
						reason: origin.source === "customize" ? "customize" : "gate",
						gateRunId: runId,
						...(origin.parentRunId && origin.source === "customize" ? { customizeRunId: origin.parentRunId } : {}),
					});
					await log.step("Repair agent", "running", `Started ${repairId}`);
				}
				await log.status("failed", origin.source !== "repair-apply" ? { repairRunId: repairId } : {});
				await setFleet(this.env, p.repo, { status: "failed", lastRun: { runId, kind: "gate", branch: p.branch, status: "failed", ...gateBrief(gate) } });
				if (origin.parentRunId) await notifyParent(this.env, exports, origin.parentRunId, "gate-finished", { gateRunId: runId, passed: false, merged: false, repairRunId: origin.source !== "repair-apply" ? repairId : null });
				return true;
			});
			return { ...gateBrief(gate), merged: false };
		}

		await step.do("finish check", async () => {
			await log.status(gate.passed ? "passed" : "failed");
			return true;
		});
		return { ...gateBrief(gate), merged: false };
	}

	/**
	 * main only ever fast-forwards to a gated commit. When main moved after
	 * the branch was cut, main is merged into the branch instead, the merge
	 * commit is pushed to the branch (never to main), and that commit is gated
	 * on its own at the pin its fluid.toml names.
	 */
	private async advanceMain(p: GateParams, runId: string, parentRunId: string | null, source: GateParams["source"]): Promise<{ ok: boolean; oid: string | null; regate: string | null }> {
		const log = runLog(this.env, runId);
		await log.step("Merge to main", "running", `Fast-forward main to ${p.branch} at ${p.commit.slice(0, 7)}`);
		const remote = await repoRemote(this.env, p.repo, "write");
		const ws = await cloneRepo({ ...remote, ref: "main", singleBranch: true });
		await fetchBranch(ws, remote, p.branch);
		const ff = await fastForward(ws, "main", p.commit);
		if (ff.outcome === "fast-forward") {
			await pushBranch(ws, remote, "main");
			await log.step("Merge to main", "done", `main fast-forwarded to ${p.commit.slice(0, 7)}`);
			return { ok: true, oid: p.commit, regate: null };
		}
		if (ff.outcome === "already") {
			await log.step("Merge to main", "done", `main already contains ${p.commit.slice(0, 7)}`);
			return { ok: true, oid: ff.oid, regate: null };
		}
		const branchHead = await headCommit(ws, `refs/remotes/origin/${p.branch}`);
		if (branchHead !== p.commit) {
			await log.step("Merge to main", "failed", `${p.branch} moved on to ${branchHead.slice(0, 7)}; the gate for that push decides`);
			return { ok: false, oid: null, regate: null };
		}
		await checkoutBranch(ws, p.branch);
		const outcome = await mergeInto(ws, { ours: p.branch, theirs: "main", message: `Merge main into ${p.branch}\n\nmain moved to ${ff.oid.slice(0, 7)} while ${p.branch} was gated. main only fast-forwards to a gated commit, so this merge is gated before it can reach main (gate run ${runId}).` });
		if (!outcome.ok) {
			await log.step("Merge to main", "failed", `main moved and ${outcome.conflicts.filepaths.join(", ")} conflict with ${p.branch}; rerun the change on the new main`);
			return { ok: false, oid: null, regate: null };
		}
		if (parentRunId) await linkGateParent(this.env, p.repo, p.branch, outcome.oid, { parentRunId, source });
		await pushBranch(ws, remote, p.branch);
		await log.step("Merge to main", "done", `main moved to ${ff.oid.slice(0, 7)}; merged it into ${p.branch} as ${outcome.oid.slice(0, 7)}, which is gated next. main is unchanged.`);
		return { ok: false, oid: null, regate: outcome.oid };
	}
}

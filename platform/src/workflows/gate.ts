// Gate Workflow (spec 4.3): one instance per push to a fork work branch,
// started by the queue consumer or directly (customize, local dev). Runs the
// three tiers against the pushed commit with stock's suites at the pinned
// tag; on pass merges the branch into main, on fail leaves main alone and
// hands off to the Repair workflow. Repair branches are checked, never merged.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { fnv1a } from "../events/filter.ts";
import { cloneRepo, fetchBranch, mergeInto, pushBranch } from "../git/ops.ts";
import { runGate } from "../gate/run.ts";
import { gateBrief, type GateResult } from "../gate/tiers.ts";
import { fleetStub } from "../stubs.ts";
import { appExports, asJson, ensureRun, GATE_STEP, GIT_STEP, repoRemote, runLog, setFleet, startInstance, guarded, steps, type GateParams } from "./common.ts";

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

		await step.do("start", async () => {
			await ensureRun(this.env, { id: runId, kind: "gate", repo: p.repo, fields: { branch: p.branch, commit: p.commit, mode: p.mode, source: p.source, parentRunId: p.parentRunId ?? null } });
			await log.step(`Gate ${p.branch} at ${p.commit.slice(0, 7)}`, "running", `Triggered by ${p.source}; reading fluid.toml for the pinned stock tag`);
			if (p.mode === "merge") await setFleet(this.env, p.repo, { status: "gating", lastRun: { runId, kind: "gate", branch: p.branch, status: "running" } });
			return true;
		});

		const gate = await step.do("run tiers", GATE_STEP, async () => {
			const result = await runGate({ env: this.env, exports }, { repo: p.repo, ref: p.branch, commit: p.commit });
			await log.step(`Gate ${p.branch} at ${p.commit.slice(0, 7)}`, "done", `Stock ${result.stockTag ?? "?"} suites loaded from stock; fork and runner in separate isolates (${result.durationMs} ms)`);
			await logTiers(this.env, runId, result);
			await persistGate(this.env, result, runId, p.parentRunId);
			return result;
		});

		if (gate.passed && p.mode === "merge") {
			const merged = await step.do("merge to main", GIT_STEP, async () => {
				await log.step("Merge to main", "running", `Fast-forward or merge ${p.branch} into main`);
				const remote = await repoRemote(this.env, p.repo, "write");
				const ws = await cloneRepo({ ...remote, ref: "main", singleBranch: true });
				await fetchBranch(ws, remote, p.branch);
				const outcome = await mergeInto(ws, { ours: "main", theirs: p.commit, message: `Merge ${p.branch} after the gate passed\n\nGate run ${runId} passed all three tiers against stock ${gate.stockTag}.` });
				if (!outcome.ok) {
					await log.step("Merge to main", "failed", `main moved and ${outcome.conflicts.filepaths.join(", ")} conflict; rerun the change on the new main`);
					return { ok: false, oid: null as string | null };
				}
				if (!outcome.alreadyMerged) await pushBranch(ws, remote, "main");
				await log.step("Merge to main", "done", `main is now ${outcome.oid.slice(0, 7)}${outcome.fastForward ? " (fast-forward)" : ""}`);
				return { ok: true, oid: outcome.oid as string | null };
			});
			await step.do("finish pass", async () => {
				await log.status(merged.ok ? "passed" : "failed", { mergedCommit: merged.oid });
				await setFleet(this.env, p.repo, { status: "pinned", lastRun: { runId, kind: "gate", branch: p.branch, status: merged.ok ? "passed" : "failed", merged: merged.ok, ...gateBrief(gate) } });
				return true;
			});
			return { ...gateBrief(gate), merged: merged.ok };
		}

		if (!gate.passed && p.mode === "merge") {
			await step.do("hand off to repair", async () => {
				await log.step("Merge blocked", "failed", `${p.branch} stays unmerged; main is untouched. ${gateBrief(gate).firstFailure ?? ""}`);
				const repairId = repairRunId(p.repo, p.commit);
				await startInstance(exports.RepairWorkflow, repairId.replace(/^run_/, ""), {
					runId: repairId,
					repo: p.repo,
					branch: p.branch,
					commit: p.commit,
					reason: p.source === "customize" ? "customize" : "gate",
					gateRunId: runId,
					...(p.parentRunId ? { customizeRunId: p.parentRunId } : {}),
				});
				await log.step("Repair agent", "running", `Started ${repairId}`);
				await log.status("failed", { repairRunId: repairId });
				await setFleet(this.env, p.repo, { status: "failed", lastRun: { runId, kind: "gate", branch: p.branch, status: "failed", ...gateBrief(gate) } });
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
}


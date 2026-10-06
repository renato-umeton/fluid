// Gate Workflow (spec 4.3): one instance per push to a fork work branch,
// started by the queue consumer or directly (customize, local dev, repair
// apply). Runs the three tiers against the pushed commit with stock's suites
// at the pinned tag. On pass, main fast-forwards to the gated commit; if main
// moved, main is merged into the branch and that merge commit is gated
// first. On fail main is untouched and the Repair workflow starts. Repair
// branches are only checked, unless the user applies one (merge mode).
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { fnv1a, gateInstanceId } from "../events/filter.ts";
import { floorKey } from "../agents/harvest-cluster.ts";
import { applyDraft, inspectChange, needsIntentCheck, OUTSIDE_SOURCE } from "../agents/outside-intent.ts";
import { intentPath } from "../agents/intent.ts";
import { cloneRepo, fetchBranch, firstParent, headCommit, pushBranch } from "../git/ops.ts";
import { newIntentId, userIdFromForkRepo } from "../lib/names.ts";
import { runGate } from "../gate/run.ts";
import { syncInboxMain } from "../forks/inbox.ts";
import { mainMovedNote, planMainAdvance } from "../gate/advance.ts";
import { gateBrief, type GateResult } from "../gate/tiers.ts";
import { fleetStub } from "../stubs.ts";
import { landedEarlier } from "../yellow/landing.ts";
import { appExports, asJson, ensureRun, GATE_STEP, gateLinkOf, GIT_STEP, guarded, linkGateParent, notifyParent, repoRemote, runLog, setFleet, startGateInstance, startInstance, startYellowRun, steps, type GateParams } from "./common.ts";

export function gateRunId(instanceId: string): string {
	return `run_${instanceId}`;
}

/**
 * Whether a failed gate starts the Repair workflow, which calls the model.
 * Not for a repair branch being applied (it would repair itself), and not for
 * changes imported from an inbox or their drafted commits: an outside agent
 * can push as often as its quota allows, and each push would start one.
 */
export function startsRepair(source: GateParams["source"]): boolean {
	return source !== "repair-apply" && source !== "import" && source !== "outside-push";
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

		// A push from outside the platform must carry a build-time intent record. When it has none,
		// the gate drafts one onto the branch and gates that commit instead of this one.
		// Every gated change: intent records are append-only, and the floor files the real diff touches are
		// recorded for harvest. A change from outside the platform with no record gets one drafted first.
		const check = await step.do("check the change", GIT_STEP, async () => this.checkChange(p, runId, needsIntentCheck(p, origin.source)));
		if (check.status === "gone") {
			await step.do("finish moved branch", async () => {
				await log.status("cancelled", { cancelReason: check.detail });
				return true;
			});
			return { passed: false, merged: false };
		}
		if (check.status === "drafted") {
			const next = await step.do("gate the drafted commit", async () => {
				const started = await startGateInstance(exports.GateWorkflow, gateInstanceId(p.repo, p.branch, check.commit), { repo: p.repo, branch: p.branch, commit: check.commit, mode: "merge", source: OUTSIDE_SOURCE, parentRunId: runId });
				await log.step("Gate the drafted commit", "done", `${started.runId} gates ${p.branch} at ${check.commit.slice(0, 7)}, which carries intent ${check.intentId}; main moves only if it passes`);
				await log.status("passed", { draftedIntent: check.intentId, draftedCommit: check.commit, regateRunId: started.runId });
				return started.runId;
			});
			return { passed: false, merged: false, draftedIntent: check.intentId, regateRunId: next };
		}

		const gate = await step.do("run tiers", GATE_STEP, async () => {
			const result = await runGate({ env: this.env, exports }, { repo: p.repo, ref: p.branch, commit: p.commit, mode: p.mode, intentViolations: check.appendOnly, platformClaims: check.platformClaims });
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
			const yellowRunId = merged.landed
				? await step.do("go yellow", async () => {
						// The pin goes first: a fast rollback restores the old pin, and nothing after this step may overwrite it.
						if (gate.stockTag) await setFleet(this.env, p.repo, { pinnedTag: gate.stockTag });
						const source = origin.source === "customize" || origin.source === "repair-apply" ? origin.source : origin.source === "outside-push" || origin.source === "import" ? "outside-push" : "gate";
						const started = await startYellowRun(this.env, exports, { repo: p.repo, commit: p.commit, previous: merged.previous ?? null, source, parentRunId: origin.parentRunId ?? runId });
						await log.step("Yellow: live on main, end-to-end soak", "info", `${p.commit.slice(0, 7)} is live with a yellow badge; ${started.runId} runs the end-to-end suite 3 times before the fork turns green`);
						return started.runId;
					})
				: null;
			await step.do("finish pass", async () => {
				await log.status(merged.ok ? "passed" : "failed", { mergedCommit: merged.oid, yellowRunId });
				const pin = merged.ok && !merged.landed && gate.stockTag ? { pinnedTag: gate.stockTag } : {};
				await setFleet(this.env, p.repo, { status: "pinned", ...pin, ...(merged.ok ? { pendingUpgrade: null } : {}), lastRun: { runId, kind: "gate", branch: p.branch, status: merged.ok ? "passed" : "failed", merged: merged.ok, ...gateBrief(gate) } });
				if (origin.parentRunId) await notifyParent(this.env, exports, origin.parentRunId, "gate-finished", { gateRunId: runId, passed: true, merged: merged.ok, mergedCommit: merged.oid });
				// An owner with an inbox can pull the new main from it (best effort; nothing waits on it).
				if (merged.landed) await syncInboxMain(this.env, p.repo);
				return true;
			});
			return { ...gateBrief(gate), merged: merged.ok };
		}

		if (!gate.passed && p.mode === "merge") {
			await step.do("hand off to repair", async () => {
				await log.step("Merge blocked", "failed", `${p.branch} stays unmerged; main is untouched. ${gateBrief(gate).firstFailure ?? ""}`);
				const repairId = repairRunId(p.repo, p.commit);
				const repairs = startsRepair(origin.source);
				if (repairs) {
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
				} else if (origin.source === "import" || origin.source === "outside-push") {
					await log.step("Repair agent", "info", "No repair agent for changes from your inbox: it calls the model, and every push would start one. Fix the change in your own agent and push again.");
				}
				await log.status("failed", repairs ? { repairRunId: repairId } : {});
				await setFleet(this.env, p.repo, { status: "failed", lastRun: { runId, kind: "gate", branch: p.branch, status: "failed", ...gateBrief(gate) } });
				if (origin.parentRunId) await notifyParent(this.env, exports, origin.parentRunId, "gate-finished", { gateRunId: runId, passed: false, merged: false, repairRunId: repairs ? repairId : null });
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
	 * Inspects the gated commit against main (agents/outside-intent.ts):
	 * records the floor files its real diff touches for each record it adds,
	 * reports records it modifies or deletes, and, when `draft` is set and the
	 * change adds no valid record, drafts one onto the branch, records this run
	 * as the parent of that commit's gate, and pushes without force. A retried
	 * step finds its own drafted commit on the branch and reuses it.
	 */
	private async checkChange(p: GateParams, runId: string, draft: boolean): Promise<{ status: "gone"; detail: string } | { status: "drafted"; commit: string; intentId: string } | { status: "ok"; appendOnly: string[]; platformClaims: string[] }> {
		const log = runLog(this.env, runId);
		await log.step("Check the change", "running", draft ? `${p.branch} came from outside the platform; every change needs a build-time intent record` : "Intent records must only be added, never changed");
		const remote = await repoRemote(this.env, p.repo, "write");
		const ws = await cloneRepo({ ...remote, ref: "main", singleBranch: true });
		await fetchBranch(ws, remote, p.branch);
		const seen = await inspectChange(ws, { branch: p.branch, commit: p.commit });
		if (seen.status === "reuse") {
			await log.step("Check the change", "done", `Drafted ${intentPath(seen.intentId)} at ${seen.head.slice(0, 7)} (an earlier attempt pushed it)`);
			return { status: "drafted", commit: seen.head, intentId: seen.intentId };
		}
		if (seen.status === "gone" || (draft && seen.moved)) {
			const detail = `${p.branch} moved on to ${seen.head.slice(0, 7)}; the gate for that push decides`;
			await log.step("Check the change", "info", detail);
			return { status: "gone", detail };
		}
		const fleet = fleetStub(this.env);
		if (seen.floor.length) for (const id of seen.addedIds) await fleet.setValue(floorKey(p.repo, id), seen.floor);
		// Only a change from outside is held to the agent rule; platform workflows write their own agents' records.
		const claims = draft ? seen.platformClaims : [];
		if (seen.appendOnly.length || claims.length) {
			const problems = [seen.appendOnly.length ? `modifies or deletes ${seen.appendOnly.slice(0, 5).join(", ")} (records are append-only)` : null, claims.length ? `adds ${claims.slice(0, 5).join(", ")} (a platform agent's name)` : null].filter(Boolean);
			await log.step("Check the change", "failed", `This change ${problems.join(" and ")}; tier 1 fails.`);
			return { status: "ok", appendOnly: seen.appendOnly, platformClaims: claims };
		}
		if (!draft || seen.addedIds.length > 0 || seen.changes.length === 0) {
			await log.step("Check the change", "done", seen.addedIds.length ? `${p.branch} adds ${seen.addedIds.map(intentPath).join(", ")}` : seen.changes.length ? `${seen.changes.length} files changed; no record was changed or deleted` : `${p.branch} changes no files since main`);
			return { status: "ok", appendOnly: [], platformClaims: [] };
		}
		const intentId = newIntentId();
		const drafted = await applyDraft(ws, { branch: p.branch, commit: p.commit, base: seen.base, changes: seen.changes, intentId, userId: userIdFromForkRepo(p.repo) ?? p.repo });
		if (seen.floor.length) await fleet.setValue(floorKey(p.repo, intentId), seen.floor);
		// Recorded before the push: the push event may start the drafted commit's gate before this run does.
		await linkGateParent(this.env, p.repo, p.branch, drafted.commit, { parentRunId: runId, source: OUTSIDE_SOURCE });
		await pushBranch(ws, remote, p.branch);
		await log.update({ intent: drafted.intent as never, draftedIntent: intentId });
		await log.step("Check the change", "done", `No record on ${p.branch}: drafted ${intentPath(intentId)} (source ${OUTSIDE_SOURCE}) from ${drafted.commits} commit message${drafted.commits === 1 ? "" : "s"} and ${seen.changes.length} file${seen.changes.length === 1 ? "" : "s"} touched, committed as ${drafted.commit.slice(0, 7)}`);
		return { status: "drafted", commit: drafted.commit, intentId };
	}

	/**
	 * main only ever fast-forwards to a gated commit. When main moved after
	 * the branch was cut, main is merged into the branch instead, the merge
	 * commit is pushed to the branch (never to main), and that commit is gated
	 * on its own at the pin its fluid.toml names.
	 */
	private async advanceMain(p: GateParams, runId: string, parentRunId: string | null, source: GateParams["source"]): Promise<{ ok: boolean; oid: string | null; regate: string | null; previous?: string | null; landed?: boolean }> {
		const log = runLog(this.env, runId);
		await log.step("Merge to main", "running", `Fast-forward main to ${p.branch} at ${p.commit.slice(0, 7)}`);
		const remote = await repoRemote(this.env, p.repo, "write");
		const ws = await cloneRepo({ ...remote, ref: "main", singleBranch: true });
		await fetchBranch(ws, remote, p.branch);
		const mainBefore = await headCommit(ws, "main");
		const plan = await planMainAdvance(ws, { branch: p.branch, commit: p.commit, message: `Merge main into ${p.branch}\n\nmain moved to ${mainBefore.slice(0, 7)} while ${p.branch} was gated. main only fast-forwards to a gated commit, so this merge is gated before it can reach main (gate run ${runId}).` });
		if (plan.outcome === "fast-forward") {
			await pushBranch(ws, remote, "main");
			await log.step("Merge to main", "done", `main fast-forwarded to ${p.commit.slice(0, 7)}`);
			return { ok: true, oid: p.commit, regate: null, previous: plan.previous, landed: true };
		}
		if (plan.outcome === "already") {
			// A retried step after a successful push: main is at the commit but its yellow run never started.
			if (landedEarlier({ mainHead: plan.mainHead, commit: p.commit, healthCommit: (await fleetStub(this.env).health(p.repo))?.commit ?? null })) {
				await log.step("Merge to main", "done", `main is already at ${p.commit.slice(0, 7)} (an earlier attempt pushed it); its yellow run starts now`);
				return { ok: true, oid: p.commit, regate: null, previous: await firstParent(ws, p.commit), landed: true };
			}
			await log.step("Merge to main", "done", `main already contains ${p.commit.slice(0, 7)}`);
			return { ok: true, oid: plan.mainHead, regate: null };
		}
		if (plan.outcome === "branch-moved") {
			await log.step("Merge to main", "failed", `${p.branch} moved on to ${plan.branchHead.slice(0, 7)}; the gate for that push decides`);
			return { ok: false, oid: null, regate: null };
		}
		// main moved while this branch was gated; say so on this run and on the run that is waiting for it.
		const moved = `main moved to ${plan.mainHead.slice(0, 7)}${mainMovedNote({ mainHead: plan.mainHead, health: await fleetStub(this.env).health(p.repo) })}`;
		const parentLog = parentRunId ? runLog(this.env, parentRunId) : null;
		if (plan.outcome === "conflict") {
			const detail = `${moved} and ${plan.files.join(", ")} conflict with ${p.branch}; rerun the change on the new main`;
			await log.step("Merge to main", "failed", detail);
			await parentLog?.step("main moved during the gate", "failed", detail).catch(() => undefined);
			return { ok: false, oid: null, regate: null };
		}
		if (parentRunId) await linkGateParent(this.env, p.repo, p.branch, plan.merge, { parentRunId, source });
		await pushBranch(ws, remote, p.branch);
		const detail = `${moved}; merged it into ${p.branch} as ${plan.merge.slice(0, 7)}, which is gated next. main is unchanged.`;
		await log.step("Merge to main", "done", detail);
		await parentLog?.step("main moved during the gate", "info", detail).catch(() => undefined);
		return { ok: false, oid: null, regate: plan.merge };
	}
}

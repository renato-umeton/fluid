// Repair agent (spec 7): on a failed gate, opens repair/<short-sha> in the
// fork with an explanation file and, when a deterministic rule applies, a
// fix (restore tau, revert the customization that broke the clinical floor).
// Otherwise the model writes the explanation. The repair is tied to the
// intent records it relied on and is never merged automatically.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { buildIntent, intentJson, intentPath } from "../agents/intent.ts";
import { diffEntries } from "../agents/diff.ts";
import { customizedRuntimeFiles, planRepair, repairNote, type RepairPlan } from "../agents/repair-plan.ts";
import { checkoutBranch, cloneRepo, commitChanges, pushBranch, readWorkspaceFile, removeFiles, writeFiles } from "../git/ops.ts";
import { readIntents, STOCK_MIN_TAU, type BuildTimeIntent } from "../forks/provision.ts";
import { runGate } from "../gate/run.ts";
import type { GateResult } from "../gate/tiers.ts";
import { newIntentId, STOCK_REPO, userIdFromForkRepo } from "../lib/names.ts";
import { AGENT_MODEL, callModel } from "../runtime/llm.ts";
import { openRepo, readTextFile } from "../runtime/repo-files.ts";
import { runsStub } from "../stubs.ts";
import { logTiers } from "./gate.ts";
import { appExports, ensureRun, errorText, GATE_STEP, GIT_STEP, repoRemote, runLog, setFleet, guarded, steps, type RepairParams } from "./common.ts";

const EXPLAIN_SCHEMA = { type: "object", properties: { explanation: { type: "string" } }, required: ["explanation"] } as const;

export function safetyText(tag: string | undefined, graceUntil: string | null | undefined, intentRefs: string[]): string | null {
	if (!graceUntil) return null;
	const what = intentRefs.length ? `the capability from ${intentRefs.join(", ")}` : "the failing capability";
	return `Safety release ${tag ?? ""}: the grace period ends ${graceUntil.slice(0, 10)}. After that, ${what} runs in stock mode until this repair is merged. Your customization stays on its branch.`;
}

export class RepairWorkflow extends WorkflowEntrypoint<Env, RepairParams> {
	async run(event: Readonly<WorkflowEvent<RepairParams>>, workflowStep: WorkflowStep) {
		const p = event.payload;
		return guarded(steps(workflowStep), this.env, { runId: p.runId, kind: "repair", repo: p.repo, fleetStatus: "failed", lastRun: { branch: p.branch, tag: p.tag ?? null } }, () => this.execute(event, workflowStep));
	}

	private async execute(event: Readonly<WorkflowEvent<RepairParams>>, workflowStep: WorkflowStep) {
		const step = steps(workflowStep);
		const p = event.payload;
		const log = runLog(this.env, p.runId);
		const short = p.commit.slice(0, 7);
		const branch = `repair/${short}`;

		const context = await step.do("read intent records", GIT_STEP, async () => {
			await ensureRun(this.env, { id: p.runId, kind: "repair", repo: p.repo, fields: { failedBranch: p.branch, commit: p.commit, tag: p.tag ?? null, reason: p.reason } });
			await log.step("Read the failed gate", "running");
			const gateRun = await runsStub(this.env, p.gateRunId).get();
			const gate = (gateRun?.gate ?? null) as unknown as GateResult | null;
			if (!gate) throw new Error(`gate run ${p.gateRunId} has no result`);
			await log.update({ gate });
			await log.step("Read the failed gate", "done", `${gate.failures.length} failing assertion(s); first: ${gate.failures[0] ? `${gate.failures[0].tier} ${gate.failures[0].probe}` : gate.error ?? "none"}`);
			await log.step("Read intent records for the failing files", "running");
			const intents = await readIntents(this.env, p.repo, p.commit);
			let fluidToml: string | null;
			{
				using repo = await openRepo(this.env.ARTIFACTS, p.repo);
				fluidToml = await readTextFile(repo, p.commit, "fluid.toml");
			}
			const candidates = customizedRuntimeFiles(intents);
			const stockVersions: Record<string, string | null> = {};
			if (gate.stockTag && candidates.length) {
				using stock = await openRepo(this.env.ARTIFACTS, STOCK_REPO);
				await Promise.all(candidates.map(async (path) => (stockVersions[path] = await readTextFile(stock, gate.stockTag!, path))));
			}
			const relevant = intents.filter((i) => i.agent !== "onboarding" && i.agent !== null && i.files.length > 0);
			await log.step("Read intent records for the failing files", "done", relevant.length ? relevant.map((i) => `${i.id} touches ${i.files.filter((f) => !f.startsWith(".intent/")).join(", ")}`).join("; ") : "No customization records");
			return { gate, intents, fluidToml, stockVersions };
		});

		const plan = await step.do("plan the repair", async () => {
			await log.step("Diagnose and propose a fix", "running");
			const base = planRepair({ gate: context.gate, intents: context.intents, fluidToml: context.fluidToml, stockMinTau: STOCK_MIN_TAU, stockVersions: context.stockVersions });
			let modelNote: string | null = null;
			if (base.rule === "none") {
				try {
					const out = await callModel(this.env.AI, explainPrompt(context.gate, context.intents), EXPLAIN_SCHEMA, { model: AGENT_MODEL, maxTokens: 2000 });
					modelNote = String(out.explanation).replace(/[\u0000-\u0008\u000b-\u001f]/g, "").slice(0, 1500);
				} catch (error) {
					modelNote = null;
					await log.step("Model explanation", "info", `Model unavailable (${errorText(error)}); using the deterministic explanation`);
				}
			}
			await log.step("Diagnose and propose a fix", base.fixSummary ? "done" : "failed", base.fixSummary ? `${base.fixSummary} (rule ${base.rule})` : "No deterministic fix; the explanation tells you what to rework");
			return { ...base, modelNote };
		});

		const opened = await step.do("open repair branch", GIT_STEP, async () => {
			await log.step(`Open ${branch}`, "running");
			const remote = await repoRemote(this.env, p.repo, "write");
			const ws = await cloneRepo({ ...remote, ref: p.branch, singleBranch: true });
			await checkoutBranch(ws, branch, { create: true, from: p.commit });
			const before: Record<string, string | null> = {};
			for (const path of Object.keys(plan.files)) before[path] = await readWorkspaceFile(ws, path);
			const writes = Object.fromEntries(Object.entries(plan.files).filter(([, v]) => v !== null)) as Record<string, string>;
			const deletes = Object.entries(plan.files).filter(([, v]) => v === null).map(([k]) => k);
			if (Object.keys(writes).length) await writeFiles(ws, writes);
			if (deletes.length) await removeFiles(ws, deletes);
			const intentId = newIntentId();
			const notePath = `.repair/${short}.md`;
			const note = repairNote({ repo: p.repo, ref: p.branch, commit: p.commit, stockTag: context.gate.stockTag, plan, failures: context.gate.failures, modelNote: plan.modelNote });
			const intent = buildIntent({
				id: intentId,
				userId: userIdFromForkRepo(p.repo) ?? p.repo,
				agent: "repair-agent",
				request: `Repair ${p.branch} at ${short} after the gate failed`,
				purpose: plan.fixSummary ?? "Explain why the gate failed and what to rework",
				modes: [],
				files: [notePath, ...Object.keys(plan.files)],
				stockTag: context.gate.stockTag ?? "unknown",
				extra: { relies_on: plan.intentRefs, failed_ref: p.branch, failed_commit: p.commit, gate_run: p.gateRunId },
			});
			await writeFiles(ws, { [notePath]: note, [intentPath(intentId)]: intentJson(intent) });
			const commit = await commitChanges(ws, {
				message: `Repair ${p.branch}: ${plan.fixSummary ?? "explain the gate failure"}\n\nThe gate failed at ${short} against stock ${context.gate.stockTag}. Relies on intent records ${plan.intentRefs.join(", ") || "(none)"}. Not merged automatically; review it.`,
				intentId,
				author: { name: "Fluid repair agent", email: "repair-agent@fluid.invalid" },
			});
			await pushBranch(ws, remote, branch, { force: true });
			const after = { ...plan.files, [notePath]: note, [intentPath(intentId)]: intentJson(intent) };
			const notes: Record<string, string> = { [notePath]: "Why the gate failed and what this branch changes", [intentPath(intentId)]: "Repair intent record (relies_on lists the records used)" };
			for (const path of Object.keys(plan.files)) notes[path] = plan.files[path] === null ? "Removed: part of the customization that broke the floor" : path === "fluid.toml" ? "tau restored to the stock minimum" : "Restored to stock";
			const diff = diffEntries({ ...before, [notePath]: null, [intentPath(intentId)]: null }, after, notes);
			await log.step(`Open ${branch}`, "done", `${branch} at ${commit.slice(0, 7)} (${diff.length} files)`);
			return { commit, diff, intent };
		});

		const repairGate = plan.fixSummary
			? await step.do("gate the repair branch", GATE_STEP, async () => {
					await log.step(`Gate ${branch} (check only)`, "running");
					const gate = await runGate({ env: this.env, exports: appExports(this.ctx) }, { repo: p.repo, ref: branch, commit: opened.commit });
					await logTiers(this.env, p.runId, gate, `${branch}: `);
					await log.step(`Gate ${branch} (check only)`, gate.passed ? "done" : "failed", gate.passed ? `The fix passes all three tiers on ${branch}` : `The fix still fails: ${gate.failures[0]?.probe ?? gate.error}`);
					return gate;
				})
			: null;

		await step.do("finish", async () => {
			const explanation = plan.modelNote ? `${plan.explanation} ${plan.modelNote}` : plan.explanation;
			const safety = safetyText(p.tag, p.graceUntil, plan.intentRefs);
			await log.step("Your review", "waiting", plan.fixSummary ? `Merge ${branch} to take the fix${p.tag ? ` and the upgrade to ${p.tag}` : ""}` : "Decide whether to drop or rework the customization");
			await log.update({ status: "waiting", branch, commit: opened.commit, explanation, intentRefs: plan.intentRefs, safety, diff: opened.diff, intent: opened.intent, repairGate: repairGate ? { passed: repairGate.passed, commit: repairGate.commit, failures: repairGate.failures.slice(0, 5) } : null, rule: plan.rule });
			await setFleet(this.env, p.repo, { status: "repair_open", lastRun: { runId: p.runId, kind: "repair", branch, tag: p.tag ?? null, status: "waiting", failedBranch: p.branch, graceUntil: p.graceUntil ?? null } });
			if (p.customizeRunId) {
				const parent = runLog(this.env, p.customizeRunId);
				await parent.step("Repair agent", plan.fixSummary ? "done" : "failed", `${branch}: ${plan.fixSummary ?? "explanation only"}`);
				await parent.update({ repair: { runId: p.runId, branch, explanation, intentRefs: plan.intentRefs } });
			}
			return true;
		});
		return { branch, commit: opened.commit, rule: plan.rule, repairGatePassed: repairGate?.passed ?? null };
	}
}

function explainPrompt(gate: GateResult, intents: BuildTimeIntent[]): string {
	const failures = gate.failures.slice(0, 6).map((f) => `- ${f.tier} ${f.probe}: ${f.path || "card"} ${f.op}, expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`).join("\n");
	const records = intents.filter((i) => i.agent !== "onboarding").map((i) => `- ${i.id}: "${i.request}" (purpose: ${i.purpose}; files: ${i.files.join(", ")})`).join("\n");
	return `A user's fork of a clinical assistant failed its regression gate. Explain in at most four sentences which customization most likely caused each failure and what the user should change, citing intent record ids. Do not propose weakening any safety test.\n\nFailures:\n${failures}\n\nBuild-time intent records:\n${records || "(none)"}`;
}

export type { RepairPlan };

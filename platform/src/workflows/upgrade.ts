// Upgrade fan-out (spec 7). A Release workflow starts one Upgrade workflow
// per fork in paced batches. Each Upgrade creates upgrade/<tag> in its fork,
// merges the stock tag (a merge agent resolves textual conflicts from the
// fork's intent records), runs the gate with tiers 1 and 2 at the new tag,
// and then merges to main (auto_upgrade) or waits for a one-tap approval.
// On failure the fork stays pinned and a repair branch is opened.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { buildIntent, intentJson, intentPath } from "../agents/intent.ts";
import { acceptModelResolutions, fallbackResolution, MERGE_SCHEMA, mergePrompt, type Resolution } from "../agents/merge-resolve.ts";
import { fnv1a } from "../events/filter.ts";
import { checkoutBranch, cloneRepo, commitChanges, fetchBranch, fetchStockTag, headCommit, mergeInto, mergeWithResolver, pushBranch, readWorkspaceFile, writeFiles, type ConflictVersions } from "../git/ops.ts";
import { preferencesOf, readIntents, type BuildTimeIntent } from "../forks/provision.ts";
import { runGate } from "../gate/run.ts";
import { gateBrief } from "../gate/tiers.ts";
import { newIntentId, STOCK_REPO, userIdFromForkRepo } from "../lib/names.ts";
import { parseToml, setTomlValue } from "../lib/toml.ts";
import { AGENT_MODEL, callModel } from "../runtime/llm.ts";
import { pinnedTagOf } from "../stock/releases.ts";
import { quotaStub } from "../stubs.ts";
import { logTiers, persistGate, repairRunId } from "./gate.ts";
import { appExports, ensureRun, errorText, GATE_STEP, GIT_STEP, repoRemote, runLog, setFleet, startInstance, guarded, steps, type ReleaseParams, type UpgradeParams } from "./common.ts";

/** Upgrades created per batch, and the pause between batches. */
export const FAN_OUT = { batchSize: 20, pause: "1 second" };
export const MERGE_MODEL_LIMIT = { maxFiles: 3, maxChars: 40_000, perMinute: 30 };

export function upgradeInstanceId(tag: string, repo: string, nonce: string): string {
	return `upg-${tag.replace(/[^A-Za-z0-9]/g, "-")}-${fnv1a(repo)}-${nonce}`.slice(0, 64);
}

export class ReleaseWorkflow extends WorkflowEntrypoint<Env, ReleaseParams> {
	async run(event: Readonly<WorkflowEvent<ReleaseParams>>, workflowStep: WorkflowStep) {
		const p = event.payload;
		return guarded(steps(workflowStep), this.env, { runId: p.runId, kind: "release" }, () => this.execute(event, workflowStep));
	}

	private async execute(event: Readonly<WorkflowEvent<ReleaseParams>>, workflowStep: WorkflowStep) {
		const step = steps(workflowStep);
		const p = event.payload;
		const log = runLog(this.env, p.runId);
		const exports = appExports(this.ctx);
		const nonce = fnv1a(p.runId).slice(0, 6);
		await step.do("start", async () => {
			await ensureRun(this.env, { id: p.runId, kind: "release", fields: { tag: p.tag, safety: p.safety, graceUntil: p.graceUntil, forks: p.repos.length } });
			await log.step(`Fan out upgrades to ${p.repos.length} forks`, "running", `Batches of ${FAN_OUT.batchSize}`);
			return true;
		});
		let started = 0;
		for (let i = 0; i < p.repos.length; i += FAN_OUT.batchSize) {
			const batch = p.repos.slice(i, i + FAN_OUT.batchSize);
			started += await step.do(`fan out ${i}`, GIT_STEP, async () => {
				const items = batch.map((repo) => {
					const id = upgradeInstanceId(p.tag, repo, nonce);
					return { id, params: { runId: `run_${id}`, repo, tag: p.tag, safety: p.safety, graceUntil: p.graceUntil, releaseRunId: p.runId } };
				});
				try {
					await exports.UpgradeWorkflow.createBatch(items);
				} catch {
					// A retried batch may have partly succeeded; create the rest one by one.
					for (const item of items) await startInstance(exports.UpgradeWorkflow, item.id, item.params);
				}
				for (const item of items) await setFleet(this.env, item.params.repo, { status: "upgrading", lastRun: { runId: item.params.runId, kind: "upgrade", tag: p.tag, branch: `upgrade/${p.tag}`, status: "queued" } });
				return items.length;
			});
			if (i + FAN_OUT.batchSize < p.repos.length) await step.sleep(`pace ${i}`, FAN_OUT.pause);
		}
		await step.do("finish", async () => {
			await log.step(`Fan out upgrades to ${p.repos.length} forks`, "done", `${started} upgrade workflows started`);
			await log.status("passed", { started });
			return true;
		});
		return { started };
	}
}

export class UpgradeWorkflow extends WorkflowEntrypoint<Env, UpgradeParams> {
	async run(event: Readonly<WorkflowEvent<UpgradeParams>>, workflowStep: WorkflowStep) {
		const p = event.payload;
		return guarded(steps(workflowStep), this.env, { runId: p.runId, kind: "upgrade", repo: p.repo, fleetStatus: "failed", lastRun: { tag: p.tag, branch: `upgrade/${p.tag}` } }, () => this.execute(event, workflowStep));
	}

	private async execute(event: Readonly<WorkflowEvent<UpgradeParams>>, workflowStep: WorkflowStep) {
		const step = steps(workflowStep);
		const p = event.payload;
		const log = runLog(this.env, p.runId);
		const exports = appExports(this.ctx);
		const branch = `upgrade/${p.tag}`;
		const lastRun = (extra: Record<string, unknown>) => ({ runId: p.runId, kind: "upgrade", tag: p.tag, branch, ...extra });

		const merged = await step.do("merge stock", GIT_STEP, async () => {
			await ensureRun(this.env, { id: p.runId, kind: "upgrade", repo: p.repo, fields: { tag: p.tag, branch, safety: p.safety, graceUntil: p.graceUntil } });
			await setFleet(this.env, p.repo, { status: "upgrading", lastRun: lastRun({ status: "running" }) });
			await log.step(`Merge stock ${p.tag} into ${branch}`, "running");
			const remote = await repoRemote(this.env, p.repo, "write");
			const stock = await repoRemote(this.env, STOCK_REPO, "read");
			const ws = await cloneRepo({ ...remote, ref: "main", singleBranch: true });
			const mainToml = (await readWorkspaceFile(ws, "fluid.toml")) ?? "";
			const fromTag = pinnedTagOf(mainToml);
			const autoUpgrade = preferencesOf(parseToml(mainToml)).auto_upgrade;
			if (fromTag === p.tag) {
				await log.step(`Merge stock ${p.tag} into ${branch}`, "done", `Already on ${p.tag}`);
				return { skip: true as const, commit: await headCommit(ws), autoUpgrade, fromTag, conflicts: [] as string[], resolutions: [] as Resolution[] };
			}
			const stockCommit = await fetchStockTag(ws, stock, p.tag);
			await checkoutBranch(ws, branch, { create: true });
			const intents = await readIntents(this.env, p.repo, "main");
			const resolutions: Resolution[] = [];
			const outcome = await mergeWithResolver(ws, {
				ours: branch,
				theirs: stockCommit,
				message: `Merge stock ${p.tag} into ${branch}\n\nUpgrade from ${fromTag ?? "unknown"} to ${p.tag}${p.safety ? " (safety release)" : ""}.`,
				resolve: async (versions) => {
					const chosen = await this.resolve(versions, intents, p.tag, p.runId);
					resolutions.push(...chosen);
					return Object.fromEntries(chosen.map((r) => [r.path, r.content]));
				},
			});
			if (!outcome.ok) throw new Error(outcome.error);
			const toml = (await readWorkspaceFile(ws, "fluid.toml")) ?? mainToml;
			if (pinnedTagOf(toml) !== p.tag) {
				await writeFiles(ws, { "fluid.toml": setTomlValue(toml, null, "stock_tag", p.tag) });
				await commitChanges(ws, { message: `Pin stock ${p.tag} on ${branch}\n\nThe gate reads tiers 1 and 2 at the tag fluid.toml names.` });
			}
			if (resolutions.length > 0) {
				const intentId = newIntentId();
				const intent = buildIntent({
					id: intentId,
					userId: userIdFromForkRepo(p.repo) ?? p.repo,
					agent: "merge-agent",
					request: `Resolve conflicts merging stock ${p.tag}`,
					purpose: `Keep the purpose of ${[...new Set(resolutions.flatMap((r) => r.intentIds))].join(", ") || "this fork's customizations"} while taking stock ${p.tag}`,
					modes: [],
					files: resolutions.map((r) => r.path),
					stockTag: p.tag,
					extra: { resolutions: resolutions.map(({ path, choice, reason, intentIds, by }) => ({ path, choice, reason, intentIds, by })) },
				});
				await writeFiles(ws, { [intentPath(intentId)]: intentJson(intent) });
				await commitChanges(ws, { message: `Record merge decisions for stock ${p.tag}\n\n${resolutions.map((r) => `${r.path}: ${r.choice} (${r.by})`).join("\n")}`, intentId, author: { name: "Fluid merge agent", email: "merge-agent@fluid.invalid" } });
			}
			const commit = await headCommit(ws);
			await pushBranch(ws, remote, branch, { force: true });
			const textual = outcome.conflicts.filter((c) => c !== "fluid.toml");
			await log.step(`Merge stock ${p.tag} into ${branch}`, "done", textual.length ? `Textual conflicts in ${textual.join(", ")} resolved by the merge agent` : "No textual conflicts");
			if (resolutions.length) {
				await log.step("Merge agent", "done", resolutions.map((r) => `${r.path}: ${r.choice === "ours" ? "kept the fork's version" : r.choice === "theirs" ? "took stock's version" : r.choice === "toml" ? "kept fork settings, new stock_tag" : "merged"} (${r.by})`).join("; "));
			}
			await log.update({ commit, diff: resolutions.map((r) => ({ path: r.path, status: "modified", additions: 0, deletions: 0, summary: r.reason })), conflicts: outcome.conflicts, fromTag });
			return { skip: false as const, commit, autoUpgrade, fromTag, conflicts: outcome.conflicts, resolutions };
		});

		if (merged.skip) {
			await step.do("finish skip", async () => {
				await log.status("passed", { applied: true });
				await setFleet(this.env, p.repo, { status: "pinned", pinnedTag: p.tag, lastRun: lastRun({ status: "passed", applied: true }) });
				return true;
			});
			return { repo: p.repo, outcome: "already-current" };
		}

		const gate = await step.do("gate", GATE_STEP, async () => {
			await setFleet(this.env, p.repo, { status: "gating", lastRun: lastRun({ status: "gating" }) });
			await log.step(`Gate ${branch} at ${p.tag}`, "running");
			const result = await runGate({ env: this.env, exports }, { repo: p.repo, ref: branch, commit: merged.commit });
			await logTiers(this.env, p.runId, result);
			await persistGate(this.env, result, p.runId);
			await log.step(`Gate ${branch} at ${p.tag}`, result.passed ? "done" : "failed", result.passed ? "All three tiers passed" : (gateBrief(result).firstFailure ?? "failed"));
			return result;
		});

		if (gate.passed) {
			const applied = await step.do("apply", GIT_STEP, async () => {
				if (!merged.autoUpgrade) {
					await log.step("Your approval", "waiting", `auto_upgrade is off: one tap merges ${branch} into main`);
					return false;
				}
				await log.step("Merge to main", "running");
				const remote = await repoRemote(this.env, p.repo, "write");
				const ws = await cloneRepo({ ...remote, ref: "main", singleBranch: true });
				await fetchBranch(ws, remote, branch);
				const outcome = await mergeInto(ws, { ours: "main", theirs: merged.commit, message: `Upgrade to stock ${p.tag}\n\nThe gate passed all three tiers on ${branch}.` });
				if (!outcome.ok) throw new Error(`main moved during the upgrade: ${outcome.conflicts.filepaths.join(", ")}`);
				if (!outcome.alreadyMerged) await pushBranch(ws, remote, "main");
				await log.step("Merge to main", "done", `main is now ${outcome.oid.slice(0, 7)} on ${p.tag}`);
				return true;
			});
			await step.do("finish pass", async () => {
				await log.status("passed", { applied });
				await setFleet(this.env, p.repo, { status: "passed", ...(applied ? { pinnedTag: p.tag } : {}), lastRun: lastRun({ status: "passed", applied, commit: merged.commit, conflicts: merged.conflicts.filter((c) => c !== "fluid.toml").length }) });
				return true;
			});
			return { repo: p.repo, outcome: applied ? "applied" : "ready", conflicts: merged.conflicts };
		}

		await step.do("hand off to repair", async () => {
			const repairId = repairRunId(p.repo, merged.commit);
			await log.step("Stay pinned", "failed", `The fork stays on ${merged.fromTag}; ${repairId} opens a repair branch`);
			await setFleet(this.env, p.repo, { status: "failed", lastRun: lastRun({ status: "failed", ...gateBrief(gate) }) });
			await startInstance(exports.RepairWorkflow, repairId.replace(/^run_/, ""), {
				runId: repairId,
				repo: p.repo,
				branch,
				commit: merged.commit,
				reason: "upgrade",
				gateRunId: p.runId,
				tag: p.tag,
				safety: p.safety,
				graceUntil: p.graceUntil,
				upgradeRunId: p.runId,
			});
			await log.status("failed", { repairRunId: repairId });
			return true;
		});
		return { repo: p.repo, outcome: "pinned" };
	}

	/** Model resolution within a budget; deterministic fallback otherwise or on any model problem. */
	private async resolve(versions: ConflictVersions[], intents: BuildTimeIntent[], tag: string, runId: string): Promise<Resolution[]> {
		const textual = versions.filter((v) => v.path !== "fluid.toml");
		const size = textual.reduce((n, v) => n + (v.ours?.length ?? 0) + (v.theirs?.length ?? 0) + (v.base?.length ?? 0), 0);
		if (textual.length > 0 && textual.length <= MERGE_MODEL_LIMIT.maxFiles && size <= MERGE_MODEL_LIMIT.maxChars) {
			const budget = await quotaStub(this.env, "merge-agent").take("model", MERGE_MODEL_LIMIT.perMinute, 60);
			if (budget.allowed) {
				try {
					const out = await callModel(this.env.AI, mergePrompt(versions, intents, tag), MERGE_SCHEMA, { model: AGENT_MODEL, maxTokens: 6000 });
					return acceptModelResolutions(out, versions, intents, tag);
				} catch (error) {
					await runLog(this.env, runId).step("Merge agent", "info", `Model unavailable (${errorText(error)}); using intent-record rules`);
				}
			}
		}
		return versions.map((v) => fallbackResolution(v, intents, tag));
	}
}

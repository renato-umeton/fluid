// Upgrade fan-out (spec 7). A Release workflow starts one Upgrade workflow
// per fork in paced batches. Each Upgrade first tries intent replay: when
// every wish in the fork's intent records can be run again, it builds
// replay/<tag> from stock at the tag plus those wishes and gates it; on a
// pass main moves there by fast-forward (see forks/replay-branch.ts). If
// replay does not apply or its gate fails, the upgrade takes the merge
// path unchanged: it creates upgrade/<tag> in its fork,
// merges the stock tag (a merge agent resolves textual conflicts from the
// fork's intent records), runs the gate with tiers 1 and 2 at the new tag,
// and then fast-forwards main (auto_upgrade) or waits for a one-tap approval
// (recorded as the fork's pendingUpgrade). main only fast-forwards: if it
// moved, main is merged into upgrade/<tag> and that commit is gated again.
// On failure the fork stays pinned and a repair branch is opened.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { buildIntent, intentJson, intentPath } from "../agents/intent.ts";
import { acceptModelResolutions, fallbackResolution, MERGE_SCHEMA, mergePrompt, type Resolution } from "../agents/merge-resolve.ts";
import { replaySummary, wishesCarriedText, type ReplaySummary } from "../agents/replay.ts";
import { fnv1a } from "../events/filter.ts";
import { buildReplayBranch, hasWishes, prepareReplay, replayBranchName } from "../forks/replay-branch.ts";
import { branchContains, checkoutBranch, cloneRepo, commitChanges, fastForward, fetchBranch, fetchStockTag, firstParent, headCommit, mergeInto, mergeWithResolver, pushBranch, readWorkspaceFile, writeFiles, type ConflictVersions, type Workspace } from "../git/ops.ts";
import { preferencesOf, readIntents, type BuildTimeIntent } from "../forks/provision.ts";
import { runGate } from "../gate/run.ts";
import { gateBrief, type GateResult } from "../gate/tiers.ts";
import { newIntentId, STOCK_REPO, userIdFromForkRepo } from "../lib/names.ts";
import { parseToml, setTomlValue } from "../lib/toml.ts";
import { AGENT_MODEL, callModel } from "../runtime/llm.ts";
import { pinnedTagOf } from "../stock/releases.ts";
import { fleetStub, quotaStub } from "../stubs.ts";
import { landedEarlier } from "../yellow/landing.ts";
import { findRolledBackUpgrade, reapplyChange } from "../yellow/reapply.ts";
import { logTiers, persistGate, repairRunId } from "./gate.ts";
import { appExports, asJson, ensureRun, errorText, GATE_STEP, GIT_STEP, mainBeforePush, recordMainBeforePush, repoRemote, runLog, setFleet, startInstance, startOrRetryInstance, startYellowRun, guarded, steps, type ReleaseParams, type Steps, type UpgradeParams } from "./common.ts";

/** Upgrades created per batch, and the pause between batches. */
export const FAN_OUT = { batchSize: 20, pause: "1 second" };
export const MERGE_MODEL_LIMIT = { maxFiles: 3, maxChars: 40_000, perMinute: 30 };

/**
 * One upgrade per (tag, fork): re-running a release never upgrades a fork
 * twice. An upgrade the yellow soak rolled back is run again under an
 * attempt suffix (see rerunTargets).
 */
export function upgradeInstanceId(tag: string, repo: string, attempt?: string): string {
	return `upg-${tag.replace(/[^A-Za-z0-9]/g, "-")}-${fnv1a(repo)}${attempt ? `-${attempt.slice(0, 12)}` : ""}`.slice(0, 64);
}

/** Rounds of "main moved, merge it into the upgrade branch, gate again" before an auto upgrade gives up. */
export const MAX_REGATES = 2;

/**
 * The intent replay switch. Every upgrade tries replay first unless the
 * release turns it off (`replay: false` on POST /api/admin/release); replay
 * itself only runs for forks whose wishes are all replayable (planReplay).
 */
export const REPLAY_BY_DEFAULT = true;

export function replayEnabled(flag: boolean | undefined): boolean {
	return flag ?? REPLAY_BY_DEFAULT;
}

export type ReplayAttempt = { used: false; summary: ReplaySummary | null } | { used: true; branch: string; commit: string; autoUpgrade: boolean; summary: ReplaySummary };
type UsedReplay = Extract<ReplayAttempt, { used: true }>;

/**
 * The order of an upgrade: intent replay first, the merge path otherwise.
 * A replay that did not apply merges at once. A replay whose gate fails, or
 * whose attempt stops before main moves (a step that gave up, main moving
 * with a conflict, too many regates), is reported by `land` as not passed:
 * the fallback is logged and the merge path runs. An error thrown by `land`
 * comes after main moved to the replay, so it is not merged over.
 */
export async function replayFirst<T>(deps: {
	attempt: () => Promise<ReplayAttempt>;
	land: (replay: UsedReplay) => Promise<{ passed: true; outcome: "applied" | "ready" } | { passed: false; why: string }>;
	fallback: (replay: UsedReplay, why: string) => Promise<ReplaySummary>;
	merge: (summary: ReplaySummary | null) => Promise<T>;
}): Promise<T | { outcome: "applied" | "ready"; path: "replay" }> {
	const replay = await deps.attempt();
	if (!replay.used) return deps.merge(replay.summary);
	const landed = await deps.land(replay);
	if (landed.passed) return { outcome: landed.outcome, path: "replay" };
	return deps.merge(await deps.fallback(replay, landed.why));
}

/**
 * After the replay's apply step gave up: whether main (checked out in `ws`)
 * already holds the gated commit, because a try pushed main and then failed.
 * Null means it does not, and the upgrade may fall back to merging. As in
 * a retried apply, the change counts as landed (a yellow run starts) only
 * while main is at the commit and the fork's health does not name it yet.
 * `previous` here is the commit's first parent, a fallback only: the yellow
 * run's previous commit is a rollback target for a fork with no green commit
 * yet, so the caller prefers main's head recorded before the push
 * (mainBeforePush). The first parent is main only for the first gated
 * commit: after main moved and was merged into the branch for another gate,
 * the gated commit's first parent is the branch's earlier head, never on main.
 */
export async function mainHoldsCommit(ws: Workspace, commit: string, healthCommit: string | null): Promise<{ landed: boolean; previous: string | null } | null> {
	if (!(await branchContains(ws, "main", commit))) return null;
	const landed = landedEarlier({ mainHead: await headCommit(ws, "main"), commit, healthCommit });
	return { landed, previous: landed ? await firstParent(ws, commit) : null };
}

type TargetFork = { repo: string; status: string; pinnedTag: string; lastRun: { tag?: unknown; kind?: string } | null; pendingUpgrade: { tag: string } | null; health?: { health: string } };

/** A fork whose upgrade to `tag` landed and was then rolled back by the yellow soak (its pin went back). */
function rolledBackAt(tag: string, f: TargetFork): boolean {
	return f.lastRun?.tag === tag && f.lastRun.kind === "upgrade" && f.pinnedTag !== tag && f.health?.health === "rolled_back";
}

/**
 * Forks a release still has to upgrade: not already on the tag, not waiting
 * to approve it, and not already handled at it, except a fork whose upgrade
 * to the tag was rolled back, which is upgraded again.
 */
export function upgradeTargets(tag: string, forks: TargetFork[]): string[] {
	return forks
		.filter((f) => f.status !== "provisioning")
		.filter((f) => f.pinnedTag !== tag && f.pendingUpgrade?.tag !== tag)
		.filter((f) => rolledBackAt(tag, f) || !(f.lastRun?.tag === tag && (f.lastRun.kind === "upgrade" || f.lastRun.kind === "repair")))
		.map((f) => f.repo);
}

/** Targets whose earlier upgrade to the tag was rolled back: they need a new upgrade instance. */
export function rerunTargets(tag: string, forks: TargetFork[]): string[] {
	return forks.filter((f) => f.status !== "provisioning" && rolledBackAt(tag, f)).map((f) => f.repo);
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
		await step.do("start", async () => {
			await ensureRun(this.env, { id: p.runId, kind: "release", fields: { tag: p.tag, safety: p.safety, graceUntil: p.graceUntil, forks: p.repos.length } });
			await log.step(`Fan out upgrades to ${p.repos.length} forks`, "running", `Batches of ${FAN_OUT.batchSize}`);
			return true;
		});
		let started = 0;
		for (let i = 0; i < p.repos.length; i += FAN_OUT.batchSize) {
			const batch = p.repos.slice(i, i + FAN_OUT.batchSize);
			started += await step.do(`fan out ${i}`, GIT_STEP, async () => {
				const rerun = new Set(p.rerun ?? []);
				const items = batch.map((repo) => {
					const id = upgradeInstanceId(p.tag, repo, rerun.has(repo) ? fnv1a(p.runId) : undefined);
					return { id, params: { runId: `run_${id}`, repo, tag: p.tag, safety: p.safety, graceUntil: p.graceUntil, releaseRunId: p.runId, ...(p.replay === false ? { replay: false } : {}) } };
				});
				// Queued goes first: an upgrade cannot start before its instance exists, so its own updates always come later.
				for (const item of items) await setFleet(this.env, item.params.repo, { status: "upgrading", lastRun: { runId: item.params.runId, kind: "upgrade", tag: p.tag, branch: `upgrade/${p.tag}`, status: "queued" } });
				try {
					await exports.UpgradeWorkflow.createBatch(items);
				} catch {
					// A retried batch may have partly succeeded; create the rest one by one (an errored one gets a fresh id).
					for (const item of items) await startOrRetryInstance(exports.UpgradeWorkflow, item.id, (id) => ({ ...item.params, runId: `run_${id}` }));
				}
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
		const result = await replayFirst({
			// First attempt: rebuild the fork from fresh stock by replaying its wishes (intent replay).
			attempt: () => step.do("replay wishes", GIT_STEP, () => this.replayWishes(p)),
			land: async (replay) => {
				const landed = await this.gateAndLand(step, p, { branch: replay.branch, commit: replay.commit, autoUpgrade: replay.autoUpgrade, prefix: "replay ", tiersPrefix: "Replay: ", extra: { path: "replay", replay: replay.summary }, failSoft: true });
				if (landed.passed) return landed;
				return { passed: false, why: landed.error ? `the replay attempt stopped: ${landed.error}` : `${replay.branch} did not pass the gate (${landed.gate ? (gateBrief(landed.gate).firstFailure ?? "failed") : "failed"})` };
			},
			fallback: (replay, why) =>
				step.do("replay fallback", async () => {
					const summary = replaySummary(p.tag, "merge", replay.summary.wishes.map((w) => ({ ...w, changed: [] })), `${why}; upgrading by merge instead`);
					await log.step("Fall back to merge", "info", `${why}. main is unchanged; merging stock ${p.tag} into upgrade/${p.tag} instead.`);
					await log.update({ replay: asJson(summary), branch: `upgrade/${p.tag}` });
					return summary;
				}),
			merge: (summary) => this.mergePath(step, p, summary),
		});
		return "repo" in result ? result : { repo: p.repo, ...result };
	}

	/** The merge path: merge the stock tag into upgrade/<tag> (the merge agent resolves conflicts), gate, land, or open a repair. */
	private async mergePath(step: Steps, p: UpgradeParams, mergeSummary: ReplaySummary | null) {
		const log = runLog(this.env, p.runId);
		const exports = appExports(this.ctx);
		const branch = `upgrade/${p.tag}`;
		const lastRun = (extra: Record<string, unknown>) => ({ runId: p.runId, kind: "upgrade", tag: p.tag, branch, ...extra });
		const mergeExtra = { path: "merge", ...(mergeSummary ? { replay: mergeSummary } : {}) };

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
			let reapplied: { applied: string[]; kept: string[] } | null = null;
			if (outcome.alreadyMerged) {
				// The tag is already in main's history: an earlier upgrade to it was rolled back. Apply its changes again.
				const rolledBack = await findRolledBackUpgrade(ws, branch, p.tag);
				if (rolledBack) {
					reapplied = await reapplyChange(ws, { from: rolledBack.revert, to: rolledBack.yellow });
					if (reapplied.applied.length) {
						await commitChanges(ws, { message: `Apply stock ${p.tag} again on ${branch}\n\nThe upgrade to ${p.tag} at ${rolledBack.yellow.slice(0, 7)} was rolled back by the yellow soak (${rolledBack.revert.slice(0, 7)}), so merging the tag again changes nothing. This commit applies that upgrade's changes again on top of main${reapplied.kept.length ? `; main's version is kept for ${reapplied.kept.join(", ")}` : ""}. The gate decides whether it ships.` });
					}
				}
			}
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
			await log.step(`Merge stock ${p.tag} into ${branch}`, "done", reapplied ? `${p.tag} was already merged and then rolled back; applied its changes again (${reapplied.applied.length} files${reapplied.kept.length ? `, main's version kept for ${reapplied.kept.join(", ")}` : ""})` : textual.length ? `Textual conflicts in ${textual.join(", ")} resolved by the merge agent` : "No textual conflicts");
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

		const landed = await this.gateAndLand(step, p, { branch, commit: merged.commit, autoUpgrade: merged.autoUpgrade, prefix: "", tiersPrefix: "", extra: { ...mergeExtra, conflicts: merged.conflicts.filter((c) => c !== "fluid.toml").length } });
		if (landed.passed) return { repo: p.repo, outcome: landed.outcome, conflicts: merged.conflicts, path: "merge" };

		const failed = landed.gate!;
		const commit = landed.commit;
		await step.do("hand off to repair", async () => {
			const repairId = repairRunId(p.repo, commit);
			await log.step("Stay pinned", "failed", `The fork stays on ${merged.fromTag}; ${repairId} opens a repair branch`);
			await setFleet(this.env, p.repo, { status: "failed", lastRun: lastRun({ status: "failed", ...mergeExtra, ...gateBrief(failed) }) });
			await startInstance(exports.RepairWorkflow, repairId.replace(/^run_/, ""), {
				runId: repairId,
				repo: p.repo,
				branch,
				commit,
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

	/**
	 * Intent replay, the first attempt of every upgrade (unless the release
	 * turned it off). Builds replay/<tag> from stock at the tag plus the
	 * fork's wishes, run again in commit order, when planReplay allows it.
	 * Anything that keeps replay from running returns used: false, and the
	 * upgrade merges as before; replay never fails an upgrade by itself.
	 */
	private async replayWishes(p: UpgradeParams): Promise<ReplayAttempt> {
		await ensureRun(this.env, { id: p.runId, kind: "upgrade", repo: p.repo, fields: { tag: p.tag, branch: `upgrade/${p.tag}`, safety: p.safety, graceUntil: p.graceUntil } });
		if (!replayEnabled(p.replay)) return { used: false, summary: null };
		const log = runLog(this.env, p.runId);
		const branch = replayBranchName(p.tag);
		const name = `Replay wishes on stock ${p.tag}`;
		try {
			const remote = await repoRemote(this.env, p.repo, "write");
			const stock = await repoRemote(this.env, STOCK_REPO, "read");
			const ws = await cloneRepo({ ...remote, ref: "main", singleBranch: true });
			const main = await headCommit(ws, "main");
			const mainToml = (await readWorkspaceFile(ws, "fluid.toml")) ?? "";
			const fromTag = pinnedTagOf(mainToml);
			if (!fromTag || fromTag === p.tag) return { used: false, summary: null };
			// A fork with no wishes has nothing to replay; it merges without a replay step (and without fetching stock twice).
			if (!(await hasWishes(ws, main))) return { used: false, summary: null };
			const stockCommit = await fetchStockTag(ws, stock, p.tag);
			const fromCommit = await fetchStockTag(ws, stock, fromTag);
			const { plan, mainTree, stockFiles } = await prepareReplay(ws, { main, stockCommit, fromCommit, tag: p.tag, fromTag, safety: p.safety });
			await setFleet(this.env, p.repo, { status: "upgrading", lastRun: { runId: p.runId, kind: "upgrade", tag: p.tag, branch, status: "running", path: "replay" } });
			await log.step(name, "running", `Rebuilding the fork from stock ${p.tag} by running each wish again`);
			if (plan.mode === "merge") {
				const summary = replaySummary(p.tag, "merge", plan.results, plan.reason);
				await log.update({ replay: asJson(summary) });
				await log.step(name, "info", `Upgrading by merge: ${plan.reason}`);
				return { used: false, summary };
			}
			const built = await buildReplayBranch(ws, { branch, tag: p.tag, stockCommit, main, plan, stockFiles, mainTree });
			await pushBranch(ws, remote, branch, { force: true });
			const summary = replaySummary(p.tag, "replay", plan.results);
			await log.update({ replay: asJson(summary), branch, commit: built.commit, fromTag });
			await log.step(name, "done", `${wishesCarriedText(summary)} on ${branch}. ${plan.results.map((r) => `${r.intentId}: ${r.reason}${r.stockAlsoChanged?.length ? ` (stock ${p.tag} also changed ${r.stockAlsoChanged.join(", ")}; replay needed no merge there)` : ""}`).join("; ")}`);
			return { used: true, branch, commit: built.commit, autoUpgrade: preferencesOf(parseToml(mainToml)).auto_upgrade, summary };
		} catch (error) {
			// Replay never fails an upgrade by itself: say why it could not run, then merge.
			await log.step(name, "info", `Replay could not run (${errorText(error)}); upgrading by merge`);
			return { used: false, summary: null };
		}
	}

	/**
	 * Gates an upgrade branch at the tag and lands it: fast-forwards main
	 * (auto_upgrade) or records a pending one-tap upgrade. If main moved, main
	 * is merged into the branch and gated again. Returns the failing gate
	 * otherwise. `prefix` keeps the replay attempt's workflow steps apart from
	 * the merge path's. With `failSoft` (the replay attempt), a gate or apply
	 * step that gives up after its retries, a moved main that conflicts, or
	 * too many regates is returned as `error` instead of thrown, so the
	 * upgrade can fall back to the merge path. main has not moved then: after
	 * an apply step that gave up, main is checked first, and a commit already
	 * on it is landed (yellow run) instead (mainHoldsCommit).
	 */
	private async gateAndLand(
		step: Steps,
		p: UpgradeParams,
		input: { branch: string; commit: string; autoUpgrade: boolean; prefix: string; tiersPrefix: string; extra: Record<string, unknown>; failSoft?: boolean },
	): Promise<{ passed: true; outcome: "applied" | "ready" } | { passed: false; gate: GateResult | null; commit: string; error?: string }> {
		const log = runLog(this.env, p.runId);
		const exports = appExports(this.ctx);
		const { branch } = input;
		const lastRun = (extra: Record<string, unknown>) => ({ runId: p.runId, kind: "upgrade", tag: p.tag, branch, ...input.extra, ...extra });
		let commit = input.commit;
		let gate: GateResult | null = null;
		const soft = async <T>(name: string, run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
			if (!input.failSoft) return { ok: true, value: await run() };
			try {
				return { ok: true, value: await run() };
			} catch (error) {
				const message = errorText(error);
				await step.do(`${name} stopped`, async () => {
					await log.step(`Gate ${branch} at ${p.tag}`, "failed", `The replay attempt stopped: ${message}`);
					return true;
				});
				return { ok: false, error: message };
			}
		};
		for (let round = 0; round <= MAX_REGATES; round++) {
			const at = commit;
			const suffix = round === 0 ? "" : ` ${round}`;
			const gated = await soft(`${input.prefix}gate${suffix}`, () => step.do(`${input.prefix}gate${suffix}`, GATE_STEP, async () => {
				await setFleet(this.env, p.repo, { status: "gating", lastRun: lastRun({ status: "gating" }) });
				await log.step(`Gate ${branch} at ${p.tag}${suffix}`, "running", round ? `main moved; gating the merge of main into ${branch} at ${at.slice(0, 7)}` : undefined);
				const result = await runGate({ env: this.env, exports }, { repo: p.repo, ref: branch, commit: at, mode: "merge" });
				await logTiers(this.env, p.runId, result, input.tiersPrefix);
				await persistGate(this.env, result, p.runId);
				await log.step(`Gate ${branch} at ${p.tag}${suffix}`, result.passed ? "done" : "failed", result.passed ? "All three tiers passed" : (gateBrief(result).firstFailure ?? "failed"));
				return result;
			}));
			if (!gated.ok) return { passed: false, gate: null, commit, error: gated.error };
			gate = gated.value;
			if (!gate.passed) break;
			const applyStep = await soft(`${input.prefix}apply${suffix}`, () => step.do(`${input.prefix}apply${suffix}`, GIT_STEP, async () => {
				if (!input.autoUpgrade) {
					await log.step("Your approval", "waiting", `auto_upgrade is off: one tap fast-forwards main to ${branch}`);
					return { applied: false, regate: null as string | null } as Awaited<ReturnType<UpgradeWorkflow["advanceMain"]>>;
				}
				return this.advanceMain(p.repo, branch, at, p.tag, p.runId);
			}));
			let applied: Awaited<ReturnType<UpgradeWorkflow["advanceMain"]>>;
			if (applyStep.ok) applied = applyStep.value;
			else {
				// A try may have pushed main before it failed: a replay already on main is landed, never merged over.
				// This check is not soft: when it cannot tell, the upgrade fails rather than merging.
				const held = await step.do(`${input.prefix}check main${suffix}`, GIT_STEP, async () => {
					const remote = await repoRemote(this.env, p.repo, "read");
					const ws = await cloneRepo({ ...remote, ref: "main", singleBranch: true });
					const found = await mainHoldsCommit(ws, at, (await fleetStub(this.env).health(p.repo))?.commit ?? null);
					if (found?.landed) found.previous = (await mainBeforePush(this.env, p.runId, at)) ?? found.previous;
					if (found) await log.step("Merge to main", "done", `main already holds ${at.slice(0, 7)} (an apply try pushed it before failing)${found.landed ? "; its yellow run starts now" : ""}`);
					return found;
				});
				if (!held) return { passed: false, gate, commit, error: applyStep.error };
				applied = { applied: true, regate: null, previous: held.previous, landed: held.landed };
			}
			if (applied.regate) {
				if (round === MAX_REGATES) {
					const message = `main kept moving during the upgrade to ${p.tag}; run the release again`;
					if (!input.failSoft) throw new Error(message);
					return { passed: false, gate, commit, error: message };
				}
				commit = applied.regate;
				continue;
			}
			const yellowRunId = applied.landed
				? await step.do(`${input.prefix}go yellow${suffix}`, async () => {
						// The pin goes first: a fast rollback restores the old pin, and nothing after this step may overwrite it.
						await setFleet(this.env, p.repo, { pinnedTag: p.tag, pendingUpgrade: null });
						return (await startYellowRun(this.env, exports, { repo: p.repo, commit: at, previous: applied.previous ?? null, source: "upgrade", parentRunId: p.runId })).runId;
					})
				: null;
			await step.do(`${input.prefix}finish pass${suffix}`, async () => {
				await log.status("passed", { applied: applied.applied, commit: at, yellowRunId });
				await setFleet(this.env, p.repo, {
					status: "passed",
					...(applied.applied ? (applied.landed ? {} : { pinnedTag: p.tag, pendingUpgrade: null }) : { pendingUpgrade: { tag: p.tag, commit: at, runId: p.runId, branch } }),
					lastRun: lastRun({ status: "passed", applied: applied.applied, commit: at }),
				});
				return true;
			});
			return { passed: true, outcome: applied.applied ? "applied" : "ready" };
		}
		return { passed: false, gate: gate!, commit };
	}

	/** Fast-forwards main to the gated upgrade commit, or merges a moved main into the upgrade branch for another gate. */
	private async advanceMain(repo: string, branch: string, commit: string, tag: string, runId: string): Promise<{ applied: boolean; regate: string | null; previous?: string | null; landed?: boolean }> {
		const log = runLog(this.env, runId);
		await log.step("Merge to main", "running");
		const remote = await repoRemote(this.env, repo, "write");
		const ws = await cloneRepo({ ...remote, ref: "main", singleBranch: true });
		await fetchBranch(ws, remote, branch);
		const previous = await headCommit(ws, "main");
		const ff = await fastForward(ws, "main", commit);
		if (ff.outcome === "fast-forward") {
			// Kept before the push: if the push lands and the step then fails, a retry or the
			// "check main" step still knows where main was (the yellow run's rollback target).
			await recordMainBeforePush(this.env, runId, commit, previous);
			await pushBranch(ws, remote, "main");
			await log.step("Merge to main", "done", `main fast-forwarded to ${commit.slice(0, 7)} on ${tag}`);
			return { applied: true, regate: null, previous, landed: true };
		}
		if (ff.outcome === "already") {
			// A retried step after a successful push: main is at the commit but its yellow run never started.
			const landed = landedEarlier({ mainHead: ff.oid, commit, healthCommit: (await fleetStub(this.env).health(repo))?.commit ?? null });
			await log.step("Merge to main", "done", landed ? `main is already at ${commit.slice(0, 7)} (an earlier attempt pushed it); its yellow run starts now` : `main already contains ${commit.slice(0, 7)}`);
			return { applied: true, regate: null, previous: landed ? ((await mainBeforePush(this.env, runId, commit)) ?? (await firstParent(ws, commit))) : previous, landed };
		}
		await checkoutBranch(ws, branch);
		const outcome = await mergeInto(ws, { ours: branch, theirs: "main", message: `Merge main into ${branch}\n\nmain moved to ${ff.oid.slice(0, 7)} during the upgrade to ${tag}; the merge is gated before main moves.` });
		if (!outcome.ok) throw new Error(`main moved during the upgrade and conflicts in ${outcome.conflicts.filepaths.join(", ")}; run the release again`);
		await pushBranch(ws, remote, branch, { force: true });
		await log.step("Merge to main", "info", `main moved to ${ff.oid.slice(0, 7)}; merged it into ${branch} as ${outcome.oid.slice(0, 7)} for another gate`);
		return { applied: false, regate: outcome.oid };
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

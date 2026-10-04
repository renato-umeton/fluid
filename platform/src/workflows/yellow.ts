// Yellow Workflow: one instance per change that landed on a fork's main
// (repo, commit). The change is already live with a yellow badge. The
// end-to-end tiers run against the live fork SOAK_PASSES times with a short
// pause between runs; the browser tier runs once per yellow period. All
// passes turn the fork green. Any failure rolls main back to the last green
// commit with a new revert commit (only while main is still at the yellow
// commit) and opens a repair linked to the change's intent records. A run
// whose commit is no longer main, or that a newer change superseded, is
// cancelled: the newer run decides.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { fnv1a } from "../events/filter.ts";
import { readIntents } from "../forks/provision.ts";
import type { GateFailure, GateResult } from "../gate/tiers.ts";
import { newIntentId, userIdFromForkRepo } from "../lib/names.ts";
import { headOf, openRepo, readTextFile } from "../runtime/repo-files.ts";
import { pinnedTagOf } from "../stock/releases.ts";
import { fleetStub, quotaStub, runsStub } from "../stubs.ts";
import { parseUiPreferences, UI_PREFERENCES_PATH } from "../ui/preferences.ts";
import { browserPlan, launchFailure, runBrowserChecks, type BrowserTierResult } from "../yellow/browser.ts";
import { changeIntents, decideRollback, revertMain, rollbackIntent, rollbackMessage } from "../yellow/rollback.ts";
import { runE2E, type E2ERunResult } from "../yellow/run.ts";
import { SOAK_PASSES, type HealthFailure } from "../yellow/state.ts";
import { tierLine } from "../yellow/tiers.ts";
import { appExports, errorText, GATE_STEP, GIT_STEP, guarded, repoRemote, runLog, startInstance, steps, type YellowParams } from "./common.ts";

/** Pause between soak passes. */
export const SOAK_PAUSE = "10 seconds";
/** Browser sessions the whole platform may start per minute (a release lands many forks at once). */
export const BROWSER_BUDGET = { perMinute: 6 };
export const ORIGIN_KEY = "publicOrigin";

export function yellowRepairRunId(repo: string, commit: string): string {
	return `run_repair_y_${commit.slice(0, 12)}_${fnv1a(repo)}`;
}

/** Compact pass record kept on the run (the UI lists scenarios and failing steps from it). */
export interface PassRecord {
	pass: number;
	passed: boolean;
	at: string;
	durationMs: number;
	runner: string;
	stockTag: string | null;
	tiers: E2ERunResult["tiers"];
	failures: E2ERunResult["failures"];
}

export function failureOf(result: { failures: E2ERunResult["failures"] } | null, browser: BrowserTierResult | null): HealthFailure {
	const first = result?.failures[0];
	if (first) return { tier: first.tier, scenario: first.scenario, step: first.step, detail: `${first.path || "result"} ${first.op}: expected ${JSON.stringify(first.expected)}, got ${JSON.stringify(first.actual)}`.slice(0, 400) };
	const check = browser?.checks.find((c) => !c.passed);
	return { tier: "browser", scenario: check?.name ?? "browser checks", step: null, detail: check?.detail ?? browser?.detail ?? "failed" };
}

/** The soak's failures in the gate result shape the repair agent reads. */
export function repairGate(input: { repo: string; commit: string; stockTag: string | null; result: E2ERunResult | null; browser: BrowserTierResult | null; runId: string }): GateResult {
	const failures: GateFailure[] = (input.result?.failures ?? []).map((f) => ({
		tier: "e2e",
		probe: f.scenario,
		description: `${f.tier} end-to-end scenario${f.step ? `, step ${f.step}` : ""}${f.description ? `: ${f.description}` : ""}`,
		sample: 1,
		samples: 1,
		path: f.path,
		op: f.op,
		expected: f.expected,
		actual: f.actual,
	}));
	for (const check of input.browser?.status === "failed" ? input.browser.checks.filter((c) => !c.passed) : []) {
		failures.push({ tier: "browser", probe: check.name, sample: 1, samples: 1, path: "", op: "browser", expected: "the flow works in a real browser", actual: check.detail });
	}
	return { repo: input.repo, ref: "main", commit: input.commit, stockTag: input.stockTag, stockCommit: null, at: new Date().toISOString(), passed: false, tiers: { invariant: null, functional: null, user: null }, failures, durationMs: 0, runId: input.runId };
}

export class YellowWorkflow extends WorkflowEntrypoint<Env, YellowParams> {
	async run(event: Readonly<WorkflowEvent<YellowParams>>, workflowStep: WorkflowStep) {
		const p = event.payload;
		return guarded(steps(workflowStep), this.env, { runId: p.runId, kind: "yellow", repo: p.repo }, () => this.execute(event, workflowStep));
	}

	private async execute(event: Readonly<WorkflowEvent<YellowParams>>, workflowStep: WorkflowStep) {
		const step = steps(workflowStep);
		const p = event.payload;
		const log = runLog(this.env, p.runId);
		const exports = appExports(this.ctx);
		const short = p.commit.slice(0, 7);

		await step.do("start", async () => {
			await log.step(`Live on main in yellow at ${short}`, "done", `Landed by ${p.source}; the end-to-end suite runs ${SOAK_PASSES} times against the live fork, with the browser checks once`);
			return true;
		});

		let browser: BrowserTierResult | null = null;
		for (let pass = 1; pass <= SOAK_PASSES; pass++) {
			const current = await step.do(`check main ${pass}`, async () => this.stillCurrent(p));
			if (!current.ok) return this.cancel(step, p, current.reason);

			const result = await step.do(`e2e pass ${pass}`, GATE_STEP, async () => {
				await log.step(`Soak pass ${pass} of ${SOAK_PASSES}`, "running", "Running the end-to-end tiers against the live fork");
				const run = await runE2E({ env: this.env, exports }, { repo: p.repo, commit: p.commit, runId: p.runId });
				for (const tier of run.tiers) await log.step(`Pass ${pass}: ${tier.tier} scenarios`, tier.passed ? "done" : "failed", tierLine(tier));
				const record: PassRecord = { pass, passed: run.passed, at: run.at, durationMs: run.durationMs, runner: run.runner, stockTag: run.stockTag, tiers: run.tiers, failures: run.failures };
				const stored = ((await runsStub(this.env, p.runId).get())?.passes ?? []) as unknown as PassRecord[];
				await log.update({ passes: [...stored.filter((r) => r.pass !== pass), record] as never, stockTag: run.stockTag, testUser: run.testUser });
				await log.step(`Soak pass ${pass} of ${SOAK_PASSES}`, run.passed ? "done" : "failed", run.passed ? `All scenarios passed in ${run.durationMs} ms (${run.runner === "stock" ? `stock ${run.stockTag} suite` : `basic platform scenarios; stock ${run.stockTag} has no end-to-end suite`})` : `Failed: ${run.failures[0] ? `${run.failures[0].scenario}${run.failures[0].step ? ` at step ${run.failures[0].step}` : ""}` : "setup"}`);
				return run;
			});

			if (pass === 1) browser = await step.do("browser checks", { retries: { limit: 1, delay: "5 seconds" }, timeout: "3 minutes" }, async () => this.browserTier(p));

			if (!result.passed || browser?.status === "failed") return this.fail(step, p, result, pass === 1 ? browser : null);

			const recorded = await step.do(`record pass ${pass}`, async () => {
				const outcome = await fleetStub(this.env).yellowPass(p.repo, { runId: p.runId, pass });
				if (!outcome || outcome.stale) return { stale: true, health: null as string | null };
				await log.update({ pass, health: outcome.state.health });
				await this.updateParent(p, { health: outcome.state.health, pass, of: SOAK_PASSES, ...(browser ? { browser: { status: browser.status, detail: browser.detail } } : {}) }, outcome.state.health === "green" ? "done" : "running", outcome.state.health === "green" ? `Green: ${SOAK_PASSES} consecutive passes; ${short} is the last green commit` : `Soak pass ${pass} of ${SOAK_PASSES} passed`);
				return { stale: false, health: outcome.state.health };
			});
			if (recorded.stale) return this.cancel(step, p, "a newer change superseded this run");
			if (pass < SOAK_PASSES) await step.sleep(`pause ${pass}`, SOAK_PAUSE);
		}

		await step.do("finish green", async () => {
			await log.step("Green", "done", `${SOAK_PASSES} consecutive passes; ${short} is now the last green commit`);
			await log.status("passed", { health: "green" });
			return true;
		});
		return { repo: p.repo, commit: p.commit, health: "green" };
	}

	/** The run may continue only while its commit is main and it is the fork's current yellow run. */
	private async stillCurrent(p: YellowParams): Promise<{ ok: boolean; reason: string }> {
		const health = await fleetStub(this.env).health(p.repo);
		if (!health) return { ok: false, reason: `${p.repo} is no longer in the fleet` };
		if (health.runId !== p.runId) return { ok: false, reason: "a newer change landed on main; its yellow run decides" };
		using repo = await openRepo(this.env.ARTIFACTS, p.repo);
		const head = await headOf(repo, "main");
		if (head !== p.commit) return { ok: false, reason: `main moved to ${head?.slice(0, 7) ?? "nothing"}` };
		return { ok: true, reason: "" };
	}

	private async cancel(step: ReturnType<typeof steps>, p: YellowParams, reason: string) {
		await step.do("cancel", async () => {
			await fleetStub(this.env).yellowCancel(p.repo, { runId: p.runId, reason });
			await runLog(this.env, p.runId).step("Cancelled", "info", reason);
			await runLog(this.env, p.runId).status("cancelled", { cancelReason: reason });
			await this.updateParent(p, { health: "cancelled", reason }, "info", `Yellow run cancelled: ${reason}`);
			return true;
		});
		return { repo: p.repo, commit: p.commit, health: "cancelled", reason };
	}

	/** Browser tier, once per yellow period. Launch problems make it unavailable, never a failure. */
	private async browserTier(p: YellowParams): Promise<BrowserTierResult> {
		const log = runLog(this.env, p.runId);
		const fleet = fleetStub(this.env);
		const entry = await fleet.get(p.repo);
		const origin = (await fleet.getValue(ORIGIN_KEY)) as string | null;
		const env = this.env as Env & { BROWSER?: Fetcher };
		let result: BrowserTierResult;
		const plan = browserPlan({ hasBinding: Boolean(env.BROWSER), origin, seeded: entry?.seeded ?? false });
		if (!plan.run) {
			result = { status: plan.status, detail: plan.detail, checks: [], consoleErrors: [], durationMs: 0 };
		} else if (!(await quotaStub(this.env, "browser").take("session", BROWSER_BUDGET.perMinute, 60)).allowed) {
			result = { status: "skipped", detail: `the platform's browser budget (${BROWSER_BUDGET.perMinute} sessions per minute) is in use; the API tiers decide this run`, checks: [], consoleErrors: [], durationMs: 0 };
		} else {
			let prefsText: string | null;
			{
				using repo = await openRepo(this.env.ARTIFACTS, p.repo);
				prefsText = await readTextFile(repo, p.commit, UI_PREFERENCES_PATH);
			}
			const prefs = parseUiPreferences(prefsText);
			try {
				result = await runBrowserChecks(env.BROWSER!, { origin: origin!, repo: p.repo, persona: entry?.persona ?? "hospitalist-researcher", runId: p.runId, prefs: prefs.ok ? prefs.preferences : {}, sessionSecret: this.env.SESSION_SECRET });
			} catch (error) {
				result = { ...launchFailure(error), checks: [], consoleErrors: [], durationMs: 0 };
			}
		}
		await log.step("Browser checks (once per yellow period)", result.status === "failed" ? "failed" : result.status === "passed" ? "done" : "info", `${result.status}: ${result.detail}`);
		await log.update({ browser: result as never });
		await fleet.yellowBrowser(p.repo, { runId: p.runId, browser: { status: result.status, detail: result.detail } });
		return result;
	}

	/** Roll main back (when it is still at the yellow commit) and open a repair linked to the change's intent records. */
	private async fail(step: ReturnType<typeof steps>, p: YellowParams, result: E2ERunResult, browser: BrowserTierResult | null) {
		const log = runLog(this.env, p.runId);
		const failure = failureOf(result, browser);
		const rollback = await step.do("roll back", GIT_STEP, async () => {
			const fleet = fleetStub(this.env);
			const health = await fleet.health(p.repo);
			let head: string | null;
			{
				using repo = await openRepo(this.env.ARTIFACTS, p.repo);
				head = await headOf(repo, "main");
			}
			const decision = decideRollback({ mainHead: head, yellowCommit: p.commit, lastGreenCommit: health?.lastGreenCommit ?? null, currentRunId: health?.runId ?? null, runId: p.runId });
			if (decision.action === "cancel") return { action: "cancel" as const, reason: decision.reason, revertCommit: null as string | null, relies: [] as string[] };
			const relies = changeIntents(await readIntents(this.env, p.repo, p.commit), decision.action === "revert" ? await readIntents(this.env, p.repo, decision.to) : []).map((i) => i.id);
			if (decision.action === "none") {
				await fleet.yellowFailure(p.repo, { runId: p.runId, failure, revertCommit: null });
				await log.step("Roll back", "failed", `Not rolled back: ${decision.reason}`);
				return { action: "none" as const, reason: decision.reason, revertCommit: null as string | null, relies };
			}
			await log.step("Roll back", "running", `main moves back to the last green commit ${decision.to.slice(0, 7)} with a new revert commit`);
			let greenToml: string | null;
			{
				using repo = await openRepo(this.env.ARTIFACTS, p.repo);
				greenToml = await readTextFile(repo, decision.to, "fluid.toml");
			}
			const intentId = newIntentId();
			const stockTag = pinnedTagOf(greenToml) ?? "unknown";
			const intent = rollbackIntent({ id: intentId, userId: userIdFromForkRepo(p.repo) ?? p.repo, repo: p.repo, yellowCommit: p.commit, greenCommit: decision.to, failure, runId: p.runId, stockTag, relies });
			const remote = await repoRemote(this.env, p.repo, "write");
			let reverted;
			try {
				reverted = await revertMain({ remote, yellowCommit: p.commit, greenCommit: decision.to, intent, message: rollbackMessage({ yellowCommit: p.commit, greenCommit: decision.to, failure, runId: p.runId, relies }) });
			} catch (error) {
				// A refused push means main moved between the check and the push: the newer change decides.
				const again = await this.stillCurrent(p);
				if (!again.ok) return { action: "cancel" as const, reason: again.reason, revertCommit: null as string | null, relies };
				throw error;
			}
			if (!reverted.ok) return { action: "cancel" as const, reason: reverted.reason ?? "main moved", revertCommit: null as string | null, relies };
			await fleet.yellowFailure(p.repo, { runId: p.runId, failure, revertCommit: reverted.commit });
			const entry = await fleet.get(p.repo);
			if (entry && stockTag !== "unknown" && entry.pinnedTag !== stockTag) await fleet.update(p.repo, { pinnedTag: stockTag });
			await log.step("Roll back", "done", `main is back on the tree of ${decision.to.slice(0, 7)} with revert commit ${reverted.commit!.slice(0, 7)} (intent ${intentId}); ${p.commit.slice(0, 7)} stays in history`);
			await log.update({ revertCommit: reverted.commit, rolledBackTo: decision.to, rollbackIntent: intentId });
			return { action: "revert" as const, reason: "", revertCommit: reverted.commit, relies };
		});
		if (rollback.action === "cancel") return this.cancel(step, p, rollback.reason);

		const repairId = await step.do("open repair", async () => {
			const gate = repairGate({ repo: p.repo, commit: p.commit, stockTag: result.stockTag, result, browser, runId: p.runId });
			await log.update({ gate: gate as never, failure: failure as never, changeIntents: rollback.relies });
			const id = yellowRepairRunId(p.repo, p.commit);
			const parent = p.parentRunId ? await runsStub(this.env, p.parentRunId).get() : null;
			await startInstance(appExports(this.ctx).RepairWorkflow, id.replace(/^run_/, ""), {
				runId: id,
				repo: p.repo,
				branch: "main",
				commit: p.commit,
				reason: "yellow",
				gateRunId: p.runId,
				intentIds: rollback.relies,
				...(parent?.kind === "customize" ? { customizeRunId: p.parentRunId! } : {}),
			});
			await log.step("Repair agent", "running", `Started ${id}, linked to ${rollback.relies.length ? rollback.relies.join(", ") : "the change"}`);
			return id;
		});

		await step.do("finish failed", async () => {
			const detail = `${failure.tier} scenario ${failure.scenario}${failure.step ? ` failed at step ${failure.step}` : " failed"}`;
			await log.status("failed", { health: rollback.action === "revert" ? "rolled_back" : "yellow", repairRunId: repairId, failure: failure as never });
			await this.updateParent(p, { health: rollback.action === "revert" ? "rolled_back" : "yellow", failure, revertCommit: rollback.revertCommit, repairRunId: repairId }, "failed", rollback.action === "revert" ? `${detail}; main rolled back to the last green commit (revert ${rollback.revertCommit?.slice(0, 7)}); repair ${repairId}` : `${detail}; ${rollback.reason}; repair ${repairId}`);
			return true;
		});
		return { repo: p.repo, commit: p.commit, health: rollback.action === "revert" ? "rolled_back" : "yellow", failure };
	}

	/** Mirrors the yellow phase on the run that landed the change. Best effort: the yellow run record is the source of truth. */
	private async updateParent(p: YellowParams, yellow: Record<string, unknown>, status: "running" | "done" | "failed" | "info", detail: string): Promise<void> {
		if (!p.parentRunId) return;
		try {
			const parent = runLog(this.env, p.parentRunId);
			await parent.update({ yellow: { runId: p.runId, commit: p.commit, of: SOAK_PASSES, ...yellow } as never });
			await parent.step("Yellow: live on main, end-to-end soak", status, detail);
		} catch (error) {
			console.warn(`yellow parent ${p.parentRunId} update failed: ${errorText(error)}`);
		}
	}
}

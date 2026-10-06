// Import Workflow: one instance per push of a work/* branch to an inbox
// (instance id from importRunId, with -r1, -r2, ... when the same commit is
// pushed again after a refused or failed import), started by the queue
// consumer, which only acks. The heavy part (fetch, inflate, walk, push)
// runs here, so one large or hostile push stalls only its own import, never
// the shared consumer batch or other users' gate triggers. Quotas are taken before any clone
// and before the run record exists.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { gateInstanceId } from "../events/filter.ts";
import { contestJoinRefusal, joinContest } from "../contest/join.ts";
import { contestIdOfBranch } from "../contest/plan.ts";
import { liveImportIO, runImport, takeImportQuota, type ImportOutcome } from "../forks/inbox.ts";
import { outsideGrantKey, type OutsideGrant } from "../forks/outside.ts";
import { RepoNotFoundError } from "../runtime/repo-files.ts";
import { fleetStub, quotaStub } from "../stubs.ts";
import { appExports, ensureRun, guarded, runLog, startGateInstance, steps, type ImportParams } from "./common.ts";

/** Fetch and push may hit Artifacts hiccups; a few retries, then the run fails. */
const IMPORT_STEP = { retries: { limit: 2, delay: "5 seconds" as const, backoff: "exponential" as const }, timeout: "5 minutes" as const };

export class ImportWorkflow extends WorkflowEntrypoint<Env, ImportParams> {
	async run(event: Readonly<WorkflowEvent<ImportParams>>, workflowStep: WorkflowStep) {
		const p = event.payload;
		return guarded(steps(workflowStep), this.env, { runId: p.runId, kind: "import", repo: p.fork }, () => this.execute(event, workflowStep));
	}

	private async execute(event: Readonly<WorkflowEvent<ImportParams>>, workflowStep: WorkflowStep) {
		const step = steps(workflowStep);
		const p = event.payload;
		const imp = { inbox: p.inbox, fork: p.fork, branch: p.branch, commit: p.commit };
		const log = runLog(this.env, p.runId);

		// The quota is taken in its own step, before the run record exists: a refused push leaves no
		// run behind, only this instance's output and a log line. A retried later step never takes it again.
		const ready = await step.do("take the import quota", async () => {
			const fleet = fleetStub(this.env);
			const entry = await fleet.get(p.fork);
			const grant = (await fleet.getValue(outsideGrantKey(p.fork))) as OutsideGrant | null;
			if (!entry || entry.status === "provisioning" || grant?.inbox !== p.inbox) return { ok: false as const, reason: null };
			// A contest entry is imported only while its contest's join window is open; a refused one takes no quota.
			const closed = await contestJoinRefusal(this.env, p.fork, p.branch);
			if (closed) return { ok: false as const, reason: closed };
			const refused = await takeImportQuota((subject, bucket, limit, window) => quotaStub(this.env, subject).take(bucket, limit, window), p.fork);
			return refused ? { ok: false as const, reason: refused } : { ok: true as const, reason: null };
		});
		if (!ready.ok) {
			if (!ready.reason) return { status: "skipped" };
			console.warn(`import of ${p.branch} at ${p.commit.slice(0, 7)} from ${p.inbox} refused: ${ready.reason}`);
			return { status: "refused", reason: ready.reason };
		}
		await step.do("start", async () => {
			await ensureRun(this.env, { id: p.runId, kind: "import", repo: p.fork, fields: { inbox: p.inbox, branch: p.branch, commit: p.commit } });
			await log.step("Import from your inbox", "running", `${p.branch} at ${p.commit.slice(0, 7)} in ${p.inbox}; only this branch head is read`);
			return true;
		});

		const outcome = await step.do("import", IMPORT_STEP, async (): Promise<ImportOutcome> => {
			try {
				return await runImport(liveImportIO(this.env, imp, p.runId), imp);
			} catch (error) {
				// The inbox is replaced on every new token: a push to the old one has nothing left to import.
				if (error instanceof RepoNotFoundError) return { status: "refused", reason: "the inbox was replaced by a newer token; push again to the new inbox" };
				throw error;
			}
		});

		if (outcome.status === "refused") {
			await step.do("finish refused", async () => this.refuse(p.runId, outcome.reason));
			return { status: "refused" };
		}
		if (outcome.status === "moved") {
			await step.do("finish moved", async () => {
				await log.step("Import from your inbox", "info", `${p.branch} moved on to ${outcome.head.slice(0, 7)} in the inbox; that push is imported on its own`);
				await log.status("cancelled", { cancelReason: "the inbox branch moved on" });
				return true;
			});
			return { status: "moved" };
		}

		const branch = outcome.branch;
		if (contestIdOfBranch(branch)) {
			// A contest entry is not gated on its own: it joins the contest, which gates it in check mode with the others.
			await step.do("join the contest", async () => {
				await log.step("Import from your inbox", "done", `${branch} in ${p.fork} at ${p.commit.slice(0, 7)}`);
				const joined = await joinContest(this.env, this.ctx, { fork: p.fork, branch, commit: p.commit, importRunId: p.runId });
				if (!joined.ok) {
					const detail = `Not in the contest: ${joined.reason}. ${branch} stays in your fork; nothing is gated.`;
					await log.step("Join the contest", "failed", detail);
					await log.status("failed", { error: detail, forkBranch: branch });
					return true;
				}
				await log.step("Join the contest", "done", `Your agent's entry joined ${joined.runId}; the contest checks it next to the other contestants, and only the one you ship is gated in merge mode`);
				await log.status("passed", { contestRunId: joined.runId, forkBranch: branch });
				return true;
			});
			return { status: "imported", branch };
		}
		await step.do("start the gate", async () => {
			await log.step("Import from your inbox", "done", outcome.status === "imported" ? `${outcome.commits} commit${outcome.commits === 1 ? "" : "s"}, ${outcome.files} file${outcome.files === 1 ? "" : "s"}; pushed to ${branch} in ${p.fork}${outcome.replaced ? " (replacing an earlier import)" : ""}` : `${branch} in your fork is already at ${p.commit.slice(0, 7)}`);
			const started = await startGateInstance(appExports(this.ctx).GateWorkflow, gateInstanceId(p.fork, branch, p.commit), { repo: p.fork, branch, commit: p.commit, mode: "merge", source: "import", parentRunId: p.runId });
			await log.step("Gate", "done", `${started.runId} gates ${branch}; main moves only if it passes`);
			await log.status("passed", { gateRunId: started.runId, forkBranch: branch });
			return true;
		});
		return { status: "imported", branch };
	}

	private async refuse(runId: string, reason: string): Promise<boolean> {
		const detail = `Not imported: ${reason}. Nothing changed in your fork.`;
		await runLog(this.env, runId).step("Import from your inbox", "failed", detail);
		await runLog(this.env, runId).status("failed", { error: detail });
		return true;
	}
}

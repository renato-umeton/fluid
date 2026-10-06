// Import Workflow: one instance per push of a work/* branch to an inbox
// (instance id from importRunId), started by the queue consumer, which only
// acks. The heavy part (fetch, inflate, walk, push) runs here, so one large
// or hostile push stalls only its own import, never the shared consumer
// batch or other users' gate triggers. Quotas are taken before any clone.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { gateInstanceId } from "../events/filter.ts";
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

		const ready = await step.do("start", async () => {
			const fleet = fleetStub(this.env);
			const entry = await fleet.get(p.fork);
			const grant = (await fleet.getValue(outsideGrantKey(p.fork))) as OutsideGrant | null;
			if (!entry || entry.status === "provisioning" || grant?.inbox !== p.inbox) return { ok: false as const, reason: null };
			await ensureRun(this.env, { id: p.runId, kind: "import", repo: p.fork, fields: { inbox: p.inbox, branch: p.branch, commit: p.commit } });
			await log.step("Import from your inbox", "running", `${p.branch} at ${p.commit.slice(0, 7)} in ${p.inbox}; only this branch head is read`);
			const refused = await takeImportQuota((subject, bucket, limit, window) => quotaStub(this.env, subject).take(bucket, limit, window), p.fork);
			return refused ? { ok: false as const, reason: refused } : { ok: true as const, reason: null };
		});
		if (!ready.ok) {
			if (ready.reason) await step.do("refused by quota", async () => this.refuse(p.runId, ready.reason!));
			return { status: ready.reason ? "refused" : "skipped" };
		}

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

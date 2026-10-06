// Queue consumer for Artifacts push events. Each push to a fork work branch
// starts one Gate workflow; the instance id is derived from (repo, branch,
// commit), so a direct trigger for the same push and a redelivered message
// never start a second gate. Each new work/* head in an inbox repo starts one
// Import workflow (workflows/import.ts) the same way. The consumer does no
// git work itself, so one heavy push never stalls the batch.
import { importRunId } from "../forks/inbox.ts";
import { appExports, startGateInstance, startInstance } from "../workflows/common.ts";
import { filterPushEvent, gateInstanceId } from "./filter.ts";

export async function handlePushEvents(batch: MessageBatch<unknown>, _env: Env, ctx: ExecutionContext): Promise<void> {
	const exports = appExports(ctx);
	for (const message of batch.messages) {
		const result = filterPushEvent(message.body);
		if (!result.gate && result.import) {
			const { inbox, fork, branch, commit } = result.import;
			const runId = importRunId(fork, branch, commit);
			try {
				await startInstance(exports.ImportWorkflow, runId.slice("run_".length), { runId, inbox, fork, branch, commit });
				message.ack();
			} catch (error) {
				console.error(`import start failed for ${inbox} ${branch}: ${error instanceof Error ? error.message : String(error)}`);
				message.retry({ delaySeconds: 5 });
			}
			continue;
		}
		if (!result.gate) {
			message.ack();
			continue;
		}
		const { repo, branch, commit, mode } = result.trigger;
		try {
			const started = await startGateInstance(exports.GateWorkflow, gateInstanceId(repo, branch, commit), { repo, branch, commit, mode, source: "event" });
			console.log(`gate ${started.created ? "started" : "already running"}: ${repo} ${branch} ${commit.slice(0, 7)} -> ${started.id}`);
			message.ack();
		} catch (error) {
			console.error(`gate start failed for ${repo} ${branch}: ${error instanceof Error ? error.message : String(error)}`);
			message.retry({ delaySeconds: 5 });
		}
	}
}

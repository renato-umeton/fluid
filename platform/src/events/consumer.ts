// Queue consumer for Artifacts push events. Each push to a fork work branch
// starts one Gate workflow; the instance id is derived from (repo, branch,
// commit), so a direct trigger for the same push and a redelivered message
// never start a second gate.
import { appExports, startGateInstance } from "../workflows/common.ts";
import { filterPushEvent, gateInstanceId } from "./filter.ts";

export async function handlePushEvents(batch: MessageBatch<unknown>, _env: Env, ctx: ExecutionContext): Promise<void> {
	const exports = appExports(ctx);
	for (const message of batch.messages) {
		const result = filterPushEvent(message.body);
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

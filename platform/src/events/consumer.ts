// Queue consumer for Artifacts push events. Each push to a fork work branch
// starts one Gate workflow; the instance id is derived from (repo, branch,
// commit), so a direct trigger for the same push and a redelivered message
// never start a second gate. Each push to a fork's main goes to the main
// guard, which undoes it when the platform did not make it.
import { guardMainPush } from "../forks/main-guard.ts";
import { appExports, errorText, startGateInstance } from "../workflows/common.ts";
import { filterPushEvent, gateInstanceId } from "./filter.ts";

export async function handlePushEvents(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
	const exports = appExports(ctx);
	for (const message of batch.messages) {
		const result = filterPushEvent(message.body);
		if (!result.gate && result.guard) {
			// A push to main: allowed when the platform made it, undone otherwise (forks/main-guard.ts).
			const { repo, after } = result.guard;
			try {
				const decision = await guardMainPush(env, result.guard);
				if (decision.action !== "allow") console.log(`main guard ${decision.action}: ${repo} ${after.slice(0, 7)}: ${decision.reason}${"done" in decision && decision.done ? ` (${decision.done})` : ""}`);
				message.ack();
			} catch (error) {
				console.error(`main guard failed for ${repo} ${after.slice(0, 7)}: ${errorText(error)}`);
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

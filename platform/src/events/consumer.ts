// Queue consumer for Artifacts push events. Each push to a fork work branch
// starts one Gate workflow; the instance id is derived from (repo, branch,
// commit), so a direct trigger for the same push and a redelivered message
// never start a second gate. Each new work/* head in an inbox repo starts one
// Import workflow (workflows/import.ts) the same way, except that pushing a
// commit again after its import was refused or failed starts a new import
// (startImportInstance). The consumer does no
// git work itself, so one heavy push never stalls the batch.
import { startImportInstance } from "../forks/inbox.ts";
import { appExports, startGateInstance } from "../workflows/common.ts";
import { filterPushEvent, gateInstanceId } from "./filter.ts";

export async function handlePushEvents(batch: MessageBatch<unknown>, _env: Env, ctx: ExecutionContext): Promise<void> {
	const exports = appExports(ctx);
	for (const message of batch.messages) {
		const result = filterPushEvent(message.body);
		if (!result.gate && result.import) {
			const { inbox, branch } = result.import;
			try {
				const started = await startImportInstance(exports.ImportWorkflow, result.import);
				console.log(`import ${started.created ? "started" : "already handled"}: ${inbox} ${branch} -> ${started.id}`);
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

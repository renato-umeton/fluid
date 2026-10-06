// Queue consumer for Artifacts push events. Each push to a fork work branch
// starts one Gate workflow; the instance id is derived from (repo, branch,
// commit), so a direct trigger for the same push and a redelivered message
// never start a second gate. Each new work/* head in an inbox repo is
// imported into its fork (forks/inbox.ts), which then starts the gate.
import type { InboxImport } from "./filter.ts";
import { importInboxBranch } from "../forks/inbox.ts";
import { appExports, errorText, startGateInstance, type AppExports } from "../workflows/common.ts";
import { filterPushEvent, gateInstanceId } from "./filter.ts";

export interface ConsumerDeps {
	importBranch(env: Env, exports: AppExports, imp: InboxImport): Promise<void>;
}

const DEFAULT_DEPS: ConsumerDeps = { importBranch: importInboxBranch };

export async function handlePushEvents(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext, deps: ConsumerDeps = DEFAULT_DEPS): Promise<void> {
	const exports = appExports(ctx);
	for (const message of batch.messages) {
		const result = filterPushEvent(message.body);
		if (!result.gate && result.import) {
			const { inbox, branch, commit } = result.import;
			try {
				await deps.importBranch(env, exports, result.import);
				message.ack();
			} catch (error) {
				// Nothing reached the fork; the import runs again on redelivery (then the dead letter queue).
				console.error(`import failed for ${inbox} ${branch} ${commit.slice(0, 7)}: ${errorText(error)}`);
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

// Inbox cleanup: started when an outside token is minted, sleeps until the
// token has expired (plus a grace period for a last import), then deletes the
// inbox and the fork's grant, unless a newer token replaced it meanwhile (that
// token schedules its own cleanup). Nothing outside data piles up beyond one
// token's lifetime.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { inboxCleanupDelayMs, inboxCleanupDue, outsideGrantKey, type OutsideGrant } from "../forks/outside.ts";
import { fleetStub } from "../stubs.ts";
import { steps, type InboxCleanupParams } from "./common.ts";

export class InboxCleanupWorkflow extends WorkflowEntrypoint<Env, InboxCleanupParams> {
	async run(event: Readonly<WorkflowEvent<InboxCleanupParams>>, workflowStep: WorkflowStep) {
		const step = steps(workflowStep);
		const p = event.payload;
		await step.sleep("wait for the token to expire", inboxCleanupDelayMs(p.expiresAt, Date.parse(event.timestamp.toISOString())));
		return step.do("delete the inbox", { retries: { limit: 3, delay: "1 minute", backoff: "exponential" } }, async () => {
			const fleet = fleetStub(this.env);
			const lock = `lock:${outsideGrantKey(p.fork)}`;
			// The same lease as minting, so a token minted right now is not left without its inbox.
			const owner = crypto.randomUUID();
			if (!(await fleet.tryLock(lock, 30_000, owner))) throw new Error(`a token for ${p.fork} is being minted; try again`);
			try {
				const grant = (await fleet.getValue(outsideGrantKey(p.fork))) as OutsideGrant | null;
				if (!inboxCleanupDue(grant, p)) return { deleted: false };
				await this.env.ARTIFACTS.delete(p.inbox).catch((error: unknown) => {
					if (!/not found/i.test(String((error as Error)?.message))) throw error;
				});
				await fleet.deleteValue(outsideGrantKey(p.fork));
				return { deleted: true };
			} finally {
				await fleet.unlock(lock, owner);
			}
		});
	}
}

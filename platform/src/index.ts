// Fluid control plane Worker. Static assets (platform/public) are served as a
// single-page app; /api/* runs here first.
import { errorResponse, json } from "./api/http.ts";
import { handleApi } from "./api/routes.ts";
import { handlePushEvents } from "./events/consumer.ts";

export { UserLedger } from "./durable/user-ledger.ts";
export { Fleet } from "./durable/fleet.ts";
export { Runs } from "./durable/runs.ts";
export { Quota } from "./durable/quota.ts";
export { LlmHost } from "./runtime/llm-host.ts";
export { GateWorkflow } from "./workflows/gate.ts";
export { CustomizeWorkflow } from "./workflows/customize.ts";
export { RepairWorkflow } from "./workflows/repair.ts";
export { ReleaseWorkflow, UpgradeWorkflow } from "./workflows/upgrade.ts";
export { HarvestWorkflow, SeedFleetWorkflow, SeedForkWorkflow } from "./workflows/fleet.ts";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
		if (!env.SESSION_SECRET) return json({ error: "SESSION_SECRET is not configured" }, 503);
		try {
			return await handleApi({ request, env, ctx, url });
		} catch (error) {
			return errorResponse(error);
		}
	},

	/** Artifacts repo.pushed events from the account-level subscription (queue fluid-events). */
	async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
		await handlePushEvents(batch, env, ctx);
	},
} satisfies ExportedHandler<Env>;

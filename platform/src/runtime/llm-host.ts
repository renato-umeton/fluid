// RPC capability handed to fork isolates as env.LLM, only in the model
// variant of an isolate. A fork can only ask for a structured completion
// through the gateway, within a per-repo and a global call budget.
import { WorkerEntrypoint } from "cloudflare:workers";
import { quotaStub } from "../stubs.ts";
import { callModel, type JsonSchema } from "./llm.ts";

const MAX_PROMPT_CHARS = 8000;
export const LLM_LIMITS = { perRepoPerMinute: 20, globalPerMinute: 200 };

export class LlmHost extends WorkerEntrypoint<Env, { repo: string }> {
	async complete(prompt: string, schema: JsonSchema): Promise<Record<string, unknown>> {
		if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > MAX_PROMPT_CHARS) {
			throw new Error(`LLM.complete: prompt must be 1 to ${MAX_PROMPT_CHARS} characters`);
		}
		if (schema === null || typeof schema !== "object") throw new Error("LLM.complete: schema must be an object");
		const repo = this.ctx.props.repo;
		for (const [subject, limit] of [[`llm:${repo}`, LLM_LIMITS.perRepoPerMinute], ["llm:global", LLM_LIMITS.globalPerMinute]] as const) {
			const decision = await quotaStub(this.env, subject).take("llm", limit, 60);
			if (!decision.allowed) throw new Error(`LLM.complete: model call budget for ${subject === "llm:global" ? "the platform" : repo} is used up; retry in ${decision.retryAfterSeconds}s`);
		}
		return callModel(this.env.AI, prompt, schema);
	}
}

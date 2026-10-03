// RPC capability handed to fork isolates as env.LLM. A fork can only ask for
// a structured completion through the gateway; it gets no other platform access.
import { WorkerEntrypoint } from "cloudflare:workers";
import { callModel, type JsonSchema } from "./llm.ts";

const MAX_PROMPT_CHARS = 8000;

export class LlmHost extends WorkerEntrypoint<Env, { repo: string }> {
	async complete(prompt: string, schema: JsonSchema): Promise<Record<string, unknown>> {
		if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > MAX_PROMPT_CHARS) {
			throw new Error(`LLM.complete: prompt must be 1 to ${MAX_PROMPT_CHARS} characters`);
		}
		if (schema === null || typeof schema !== "object") throw new Error("LLM.complete: schema must be an object");
		return callModel(this.env.AI, prompt, schema);
	}
}

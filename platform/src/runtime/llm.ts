// Model calls through Workers AI behind the "fluid" AI Gateway. Fast,
// per-request structured calls use llama-3.3-70b fp8-fast; agent work uses a
// reasoning model. Output arrives in one of two shapes depending on the model,
// so a single parser reads both and validates required keys in code.

export const FAST_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const AGENT_MODEL = "@cf/openai/gpt-oss-120b";
export const GATEWAY_ID = "fluid";

export type JsonSchema = { type?: string; properties?: Record<string, unknown>; required?: readonly string[] | string[]; [key: string]: unknown };

/**
 * Extracts the JSON object from a Workers AI response: `res.response` (an
 * object or a JSON string, llama) or `res.choices[0].message.content` (a JSON
 * string, OpenAI-style models). Throws with context when nothing usable is there.
 */
export function parseModelOutput(res: unknown): Record<string, unknown> {
	const r = res as { response?: unknown; choices?: { message?: { content?: unknown } }[] } | null;
	const raw = r?.response ?? r?.choices?.[0]?.message?.content;
	if (raw === undefined || raw === null || raw === "") throw new Error("model returned no content");
	let value: unknown = raw;
	if (typeof raw === "string") {
		const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
		try {
			value = JSON.parse(text);
		} catch {
			throw new Error(`model returned text that is not JSON: ${text.slice(0, 120)}`);
		}
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("model output is not a JSON object");
	return value as Record<string, unknown>;
}

/** Checks the schema's required keys and top-level primitive types. */
export function validateAgainstSchema(value: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
	for (const key of schema.required ?? []) {
		if (!(key in value)) throw new Error(`model output is missing required key ${key}`);
	}
	for (const [key, spec] of Object.entries(schema.properties ?? {})) {
		const expected = (spec as { type?: string }).type;
		if (!(key in value) || !expected) continue;
		const actual = Array.isArray(value[key]) ? "array" : typeof value[key];
		const ok = expected === "integer" ? Number.isInteger(value[key]) : expected === "number" ? actual === "number" : actual === expected;
		if (!ok) throw new Error(`model output key ${key} should be ${expected}, got ${actual}`);
	}
	return value;
}

export interface ModelCallOptions {
	model?: string;
	system?: string;
	maxTokens?: number;
	/** Sampling temperature; the model's default when absent. Contests give each model plan its own. */
	temperature?: number;
}

/** One structured model call through the gateway. Returns the validated JSON object. */
export async function callModel(ai: Ai, prompt: string, schema: JsonSchema, options: ModelCallOptions = {}): Promise<Record<string, unknown>> {
	const model = options.model ?? FAST_MODEL;
	const res = await (ai as unknown as { run(model: string, input: unknown, opts: unknown): Promise<unknown> }).run(
		model,
		{
			messages: [
				{ role: "system", content: options.system ?? "Reply only with JSON that matches the schema." },
				{ role: "user", content: prompt },
			],
			response_format: { type: "json_schema", json_schema: schema },
			max_tokens: options.maxTokens ?? (model === FAST_MODEL ? 800 : 2400),
			...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
		},
		{ gateway: { id: GATEWAY_ID, skipCache: true } },
	);
	return validateAgainstSchema(parseModelOutput(res), schema);
}

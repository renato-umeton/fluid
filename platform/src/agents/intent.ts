// Build-time intent records (spec 8) written by agents. Requests are user
// free text and the records are readable by anyone through /api/intents and
// the fleet and harvest views, so the text is stripped of control characters
// and bounded before it is written.
import type { BuildTimeIntent } from "../forks/provision.ts";

export const MAX_REQUEST_CHARS = 500;
export const MAX_PURPOSE_CHARS = 400;

export function cleanText(text: string, max: number): string {
	return String(text ?? "")
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

export interface IntentInput {
	id: string;
	userId: string;
	agent: string;
	request: string;
	purpose: string;
	modes: string[];
	files: string[];
	testsAdded?: string[];
	stockTag: string;
	extra?: Record<string, unknown>;
}

export function buildIntent(input: IntentInput): BuildTimeIntent {
	return {
		id: input.id,
		author: `user:${input.userId}`,
		agent: input.agent,
		request: cleanText(input.request, MAX_REQUEST_CHARS),
		purpose: cleanText(input.purpose, MAX_PURPOSE_CHARS),
		modes_affected: input.modes.filter((m) => ["clinical", "research", "administrative"].includes(m)),
		files: [...new Set(input.files)].sort(),
		tests_added: input.testsAdded ?? [],
		stock_tag: input.stockTag,
		created_at: new Date().toISOString(),
		...(input.extra ?? {}),
	};
}

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((x) => typeof x === "string");

/**
 * Reads one .intent/<id>.json. Records can come from outside the platform,
 * so a record that does not parse, names another id, or has the wrong shape
 * is refused (null) instead of breaking every reader of the fork. Optional
 * fields get their empty values.
 */
export function parseIntentRecord(path: string, text: string): BuildTimeIntent | null {
	const id = /^\.intent\/([A-Za-z0-9._-]+)\.json$/.exec(path)?.[1];
	if (!id) return null;
	let record: Record<string, unknown>;
	try {
		record = JSON.parse(text) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!record || typeof record !== "object" || Array.isArray(record) || record.id !== id) return null;
	if (typeof record.author !== "string" || typeof record.request !== "string" || !isStringList(record.files)) return null;
	if (record.agent !== undefined && record.agent !== null && typeof record.agent !== "string") return null;
	for (const key of ["modes_affected", "tests_added"]) if (record[key] !== undefined && !isStringList(record[key])) return null;
	for (const key of ["purpose", "stock_tag"]) if (record[key] !== undefined && typeof record[key] !== "string") return null;
	return {
		...record,
		id,
		author: record.author,
		agent: (record.agent as string | null | undefined) ?? null,
		request: record.request,
		purpose: (record.purpose as string | undefined) ?? "",
		modes_affected: (record.modes_affected as string[] | undefined) ?? [],
		files: record.files,
		tests_added: (record.tests_added as string[] | undefined) ?? [],
		stock_tag: (record.stock_tag as string | undefined) ?? "unknown",
	};
}

export function intentPath(id: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`invalid intent id ${JSON.stringify(id)}`);
	return `.intent/${id}.json`;
}

export function intentJson(intent: BuildTimeIntent): string {
	return `${JSON.stringify(intent, null, 2)}\n`;
}

/** Branch-safe slug from a request: lowercase words, at most 40 characters. */
export function slugify(text: string, fallback = "change"): string {
	const slug = cleanText(text, 200)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.split("-")
		.filter(Boolean)
		.slice(0, 6)
		.join("-")
		.slice(0, 40)
		.replace(/-+$/g, "");
	return slug || fallback;
}

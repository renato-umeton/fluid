// Small HTTP helpers shared by the API routes.
import { scrubText } from "../git/tokens.ts";

export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly extra: Record<string, unknown> = {},
		readonly headers: Record<string, string> = {},
	) {
		super(message);
		this.name = "HttpError";
	}
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}

export function errorResponse(error: unknown): Response {
	if (error instanceof HttpError) return json({ error: scrubText(error.message), ...error.extra }, error.status, error.headers);
	const message = scrubText(error instanceof Error ? error.message : String(error));
	console.error("request failed:", message);
	return json({ error: message }, 500);
}

const MAX_BODY_BYTES = 64 * 1024;

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
	const text = await request.text();
	if (text.length > MAX_BODY_BYTES) throw new HttpError(413, `request body is larger than ${MAX_BODY_BYTES} bytes`);
	if (text.trim() === "") return {} as T;
	try {
		const value = JSON.parse(text) as unknown;
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
		return value as T;
	} catch {
		throw new HttpError(400, "request body must be a JSON object");
	}
}

export function requireString(body: Record<string, unknown>, key: string, maxLength = 2000): string {
	const value = body[key];
	if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, `${key} must be a non-empty string`);
	if (value.length > maxLength) throw new HttpError(400, `${key} must be at most ${maxLength} characters`);
	return value;
}

export function notImplemented(what: string): Response {
	return json({ error: `${what} is not implemented yet` }, 501);
}

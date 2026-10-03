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

/** Short random id that ties an error response to its log line. */
export function newRequestId(): string {
	return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Error response with a request id. An HttpError carries a message meant for
 * the client. Anything else is unexpected: the client gets "internal error"
 * and the details go only to the log, with tokens scrubbed.
 */
export function errorResponse(error: unknown, requestId: string): Response {
	const headers = { "x-request-id": requestId };
	if (error instanceof HttpError) return json({ error: scrubText(error.message), ...error.extra, requestId }, error.status, { ...error.headers, ...headers });
	const detail = error instanceof Error ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}` : String(error);
	console.error(`request ${requestId} failed: ${scrubText(detail)}`);
	return json({ error: "internal error", requestId }, 500, headers);
}

export const MAX_BODY_BYTES = 64 * 1024;

function tooLarge(): HttpError {
	return new HttpError(413, `request body is larger than ${MAX_BODY_BYTES} bytes`);
}

/** Reads the body as UTF-8, refusing it as soon as it passes MAX_BODY_BYTES (declared or actual). */
async function readBodyText(request: Request): Promise<string> {
	const declared = Number(request.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooLarge();
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_BODY_BYTES) {
			await reader.cancel().catch(() => undefined);
			throw tooLarge();
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
	const text = await readBodyText(request);
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

/** decodeURIComponent for a path segment; a malformed escape is the client's error. */
export function decodeParam(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new HttpError(400, "malformed escape in the request path");
	}
}

/**
 * Cross-site request guard for every POST: the body must be declared JSON
 * (a cross-site page can only send JSON after a CORS preflight, which this
 * API never grants), and a browser's Origin, when sent, must be this site.
 * This also stops login CSRF on POST /api/session.
 */
export function requireJsonPost(request: Request, url: URL): void {
	if (request.method !== "POST") return;
	const origin = request.headers.get("origin");
	if (origin !== null && origin !== url.origin) throw new HttpError(403, "cross-origin requests are not allowed");
	const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
	if (type !== "application/json") throw new HttpError(415, "POST requests must send content-type: application/json");
}

export function notImplemented(what: string): Response {
	return json({ error: `${what} is not implemented yet` }, 501);
}

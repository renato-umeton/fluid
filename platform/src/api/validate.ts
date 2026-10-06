// Request validation shared by the API routes, and the mapping from domain
// errors to client-facing HTTP errors with generic messages.
import { FleetFullError, ForkNotFoundError, ProvisioningBusyError, type Preferences } from "../forks/provision.ts";
import { InvalidRefError, isSha, RefNotFoundError, shortRef } from "../runtime/refs.ts";
import { RepoNotFoundError } from "../runtime/repo-files.ts";
import { HttpError } from "./http.ts";

const PREFERENCE_KEYS = ["auto_upgrade", "harvest_opt_in"] as const;

/** Fork preferences from a request body: an object with optional boolean keys and nothing else. */
export function parsePreferences(value: unknown): Preferences {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "preferences must be an object");
	const out: Preferences = {};
	for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
		if (!(PREFERENCE_KEYS as readonly string[]).includes(key)) throw new HttpError(400, `unknown preference ${JSON.stringify(key.slice(0, 40))}; allowed: ${PREFERENCE_KEYS.join(", ")}`);
		if (inner === undefined) continue;
		if (typeof inner !== "boolean") throw new HttpError(400, `preferences.${key} must be a boolean`);
		out[key as (typeof PREFERENCE_KEYS)[number]] = inner;
	}
	return out;
}

/**
 * The ref a caller may ask at. Visitors name branches or tags only: a raw
 * commit SHA is refused so nobody can point their own repo at an object they
 * do not own. The admin may pass a SHA (it is still checked to exist).
 */
export function askRef(value: unknown, admin: boolean): string {
	if (value === undefined || value === null) return "main";
	if (typeof value !== "string" || value.length > 200) throw new HttpError(400, "ref must be a branch or tag name");
	let short: string;
	try {
		short = shortRef(value);
	} catch {
		throw new HttpError(400, "ref must be a branch or tag name");
	}
	if (isSha(short) && !admin) throw new HttpError(400, "ref must be a branch or tag name");
	return short;
}

/** Maps known domain errors to HTTP errors with messages safe to show; other errors pass through. */
export function toHttpError(error: unknown): unknown {
	if (error instanceof HttpError) return error;
	if (error instanceof RefNotFoundError || error instanceof RepoNotFoundError) return new HttpError(404, "not found");
	if (error instanceof ForkNotFoundError) return new HttpError(404, "fork not found");
	if (error instanceof InvalidRefError) return new HttpError(400, "invalid ref: use a branch or tag name");
	if (error instanceof ProvisioningBusyError) return new HttpError(409, "this fork is already being provisioned; try again shortly", { reason: "busy" });
	if (error instanceof FleetFullError) return new HttpError(429, "the demo fleet is full; try again later", { reason: "fleet-full" });
	return error;
}

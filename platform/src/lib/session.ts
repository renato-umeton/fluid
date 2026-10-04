// Demo sessions: an HttpOnly cookie carrying { userId, persona, issuedAt, known }
// signed with HMAC-SHA256 under SESSION_SECRET. No server-side session store.

export const SESSION_COOKIE = "fluid_session";
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export interface Session {
	userId: string;
	persona: string;
	issuedAt: number;
	/** User ids of the other personas this browser used (persona id -> user id), so switching back keeps that fork. */
	known?: Record<string, string>;
}

const MAX_KNOWN_PERSONAS = 10;

/**
 * The session after switching to a persona. A persona used before in this
 * browser gets its earlier user id back (and with it its fork); a new one gets
 * a new user id.
 */
export function switchPersona(existing: Session | null, persona: string, now: number, newUserId: () => string): { session: Session; reused: boolean } {
	const known: Record<string, string> = { ...(existing?.known ?? {}) };
	if (existing) known[existing.persona] = existing.userId;
	const prior = known[persona];
	delete known[persona];
	const kept = Object.fromEntries(Object.entries(known).slice(-MAX_KNOWN_PERSONAS));
	return { session: { userId: prior ?? newUserId(), persona, issuedAt: now, known: kept }, reused: prior !== undefined };
}

function isKnownMap(value: unknown): boolean {
	if (value === undefined) return true;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const entries = Object.entries(value);
	return entries.length <= MAX_KNOWN_PERSONAS && entries.every(([, v]) => typeof v === "string");
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
	const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	if (typeof secret !== "string" || secret.length < 16) throw new Error("SESSION_SECRET must be set to at least 16 characters");
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signSession(session: Session, secret: string): Promise<string> {
	const payload = base64url(encoder.encode(JSON.stringify(session)));
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload)));
	return `${payload}.${base64url(signature)}`;
}

/** Returns the session when the signature is valid and the cookie is not expired; otherwise null. */
export async function verifySession(value: string | null | undefined, secret: string, now = Date.now()): Promise<Session | null> {
	if (!value) return null;
	const [payload, signature, extra] = value.split(".");
	if (!payload || !signature || extra !== undefined) return null;
	let valid: boolean;
	try {
		valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromBase64url(signature), encoder.encode(payload));
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("SESSION_SECRET")) throw error;
		return null;
	}
	if (!valid) return null;
	let session: Session;
	try {
		session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as Session;
	} catch {
		return null;
	}
	if (typeof session.userId !== "string" || typeof session.persona !== "string" || typeof session.issuedAt !== "number" || !isKnownMap(session.known)) return null;
	if (now - session.issuedAt > SESSION_MAX_AGE_SECONDS * 1000) return null;
	return session;
}

export function readCookie(header: string | null, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return null;
}

export function sessionCookieHeader(value: string, secure: boolean): string {
	return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

/** Constant-time string comparison for the admin token. */
export function safeEqual(a: string, b: string): boolean {
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	let diff = left.length ^ right.length;
	for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
	return diff === 0;
}

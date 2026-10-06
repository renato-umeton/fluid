// Artifacts tokens look like "art_v2_<secret>?expires=<unix>". Only the part
// before "?expires=" is the credential. The platform's own tokens are never
// logged, returned to clients, written to git config, or embedded in URLs.
// The one exception is the outside token route (forks/outside.ts), which
// hands a one hour token to the fork's owner and nobody else.

export function tokenSecret(token: string): string {
	if (typeof token !== "string" || token === "") throw new Error("tokenSecret: token must be a non-empty string");
	return token.split("?expires=")[0]!;
}

/** Expiry encoded in the token, as a unix timestamp in seconds, or null if absent. */
export function tokenExpiry(token: string): number | null {
	const match = /\?expires=(\d+)/.exec(token);
	return match ? Number(match[1]) : null;
}

/** isomorphic-git onAuth callback for a repo-scoped token. */
export function onAuthFor(token: string): () => { username: string; password: string } {
	const password = tokenSecret(token);
	return () => ({ username: "x", password });
}

/** Safe description of a token for diagnostics: prefix and length only. */
export function redactToken(token: unknown): string {
	if (typeof token !== "string") return "<none>";
	const secret = token.split("?")[0]!;
	return `${secret.slice(0, 7)}<redacted len=${secret.length}>`;
}

/** Deep copy with every token-like field redacted, for error payloads. */
export function redactTokens<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(redactTokens) as T;
	const out: Record<string, unknown> = {};
	for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
		out[key] = key === "token" || key === "plaintext" ? redactToken(inner) : redactTokens(inner);
	}
	return out as T;
}

/** Removes anything that looks like an Artifacts token from free text (error messages). */
export function scrubText(text: string): string {
	return text.replace(/art_v\d+_[A-Za-z0-9_-]+(\?expires=\d+)?/g, "<redacted-token>");
}

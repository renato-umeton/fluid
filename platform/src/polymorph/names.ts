// Names for one polymorphic copy of a fork. The seed is an HMAC of the fork,
// commit, and epoch under a platform secret, so names differ per fork, per
// commit, and over time, and nobody can predict them from public source. Each
// listed name gets its own suffix, an HMAC of that name under the seed, so
// learning one renamed name reveals nothing about the others.

const encoder = new TextEncoder();

const SEED_PATTERN = /^[0-9a-f]{64}$/;
/** A full git commit id: SHA-1 (40 hex characters) or SHA-256 (64), lowercase as git writes them. */
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SUFFIX_SPACE = 36 ** 8;

/** A renamed name: a listed name, "$", and eight base36 characters. Groups: the listed name, the suffix. */
export const VARIANT_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)\$([0-9a-z]{8})$/;

/** The secret seed of one copy: hex HMAC-SHA256 of "polymorph:v1:<repo>:<sha>:<epoch>" under the platform secret. */
export async function deriveSeed(secret: string, repo: string, sha: string, epoch: number): Promise<string> {
	if (typeof secret !== "string" || secret.length < 16) throw new Error("polymorph secret must be at least 16 characters");
	// A colon in the repo would let two different (repo, sha) pairs share one message, and so one seed; a hex sha has none.
	if (typeof repo !== "string" || repo === "" || repo.includes(":")) throw new Error(`polymorph seed: repo must be a non-empty string without ":", got ${JSON.stringify(repo)}`);
	if (typeof sha !== "string" || !COMMIT_PATTERN.test(sha)) throw new Error(`polymorph seed: sha must be a lowercase hex commit id of 40 or 64 characters, got ${JSON.stringify(sha)}`);
	if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error(`polymorph seed: epoch must be a non-negative integer, got ${JSON.stringify(epoch)}`);
	return hex(await sign(await hmacKey(secret), `polymorph:v1:${repo}:${sha}:${epoch}`));
}

/** Maps each name to name + "$" + eight base36 characters taken from HMAC-SHA256(seed, name). */
export async function variantNames(seed: string, names: readonly string[]): Promise<Map<string, string>> {
	const key = await seedKey(seed);
	const unique = [...new Set(names)];
	const digests = await Promise.all(unique.map((name) => sign(key, name)));
	return new Map(unique.map((name, i) => [name, `${name}$${base36Suffix(digests[i]!)}`]));
}

/**
 * Eight hex characters that tell copies apart in the platform's logs. The
 * message contains ":", which no listed name can, so the fingerprint is never
 * part of a suffix, and an HMAC output reveals nothing about its key. It
 * still lets whoever sees it test a guess of the secret, so answers name a
 * copy by a random variant instead (Fleet's MorphState).
 */
export async function fingerprint(seed: string): Promise<string> {
	return hex(await sign(await seedKey(seed), "polymorph:v1:fingerprint")).slice(0, 8);
}

/**
 * Eight hex characters naming which listed names a copy renamed: SHA-256 over
 * the names, sorted and joined with ",", which no name contains. A copy is the
 * one the gate verified only when its seed and this hash both match, since a
 * platform change could skip different names with the same seed.
 */
export async function namesHash(names: Iterable<string>): Promise<string> {
	const sorted = [...new Set(names)].sort();
	return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(sorted.join(","))))).slice(0, 8);
}

async function seedKey(seed: string): Promise<CryptoKey> {
	if (typeof seed !== "string" || !SEED_PATTERN.test(seed)) throw new Error("polymorph seed must be 64 lowercase hex characters, as deriveSeed returns");
	return hmacKey(seed);
}

function hmacKey(key: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function sign(key: CryptoKey, message: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function hex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The first six digest bytes (exact in a double) reduced modulo 36^8; every suffix is within one percent of uniformly likely. */
function base36Suffix(digest: Uint8Array): string {
	let value = 0;
	for (const byte of digest.subarray(0, 6)) value = value * 256 + byte;
	return (value % SUFFIX_SPACE).toString(36).padStart(8, "0");
}

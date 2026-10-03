// Ref handling for the Artifacts binding. The binding only understands short
// names (main, v1.0.0, repair/v1.1.0) and commit SHAs; full refs such as
// refs/heads/main silently return null or an empty log. Every ref is
// normalized here and resolved to a commit SHA once, so caches key by SHA.

export const SHA_PATTERN = /^[0-9a-f]{40}$/;

export function isSha(ref: string): boolean {
	return SHA_PATTERN.test(ref);
}

/** Converts refs/heads/x and refs/tags/x to x. Other full refs are rejected. */
export function shortRef(ref: string): string {
	if (typeof ref !== "string" || ref.trim() === "") throw new Error("ref must be a non-empty string");
	const trimmed = ref.trim();
	for (const prefix of ["refs/heads/", "refs/tags/"]) {
		if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
	}
	if (trimmed.startsWith("refs/")) throw new Error(`unsupported ref ${trimmed}: use a branch, tag, or commit SHA`);
	if (trimmed.includes("..") || /[\s~^:?*[\\]/.test(trimmed)) throw new Error(`invalid ref ${JSON.stringify(trimmed)}`);
	return trimmed;
}

export interface LogReader {
	log(options: { ref: string; limit: number }): Promise<{ hash: string }[]>;
}

/** Resolves a branch, tag (annotated or lightweight), or SHA to a commit SHA through repo.log. */
export async function resolveCommit(repo: LogReader, ref: string): Promise<string> {
	const short = shortRef(ref);
	if (isSha(short)) return short;
	const entries = await repo.log({ ref: short, limit: 1 });
	const hash = entries[0]?.hash;
	if (!hash) throw new RefNotFoundError(short);
	return hash;
}

export class RefNotFoundError extends Error {
	constructor(readonly ref: string) {
		super(`ref ${ref} not found`);
		this.name = "RefNotFoundError";
	}
}

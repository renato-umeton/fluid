// Reads a commit's files through the Artifacts binding: readCommit for the
// tree, readTree per directory, readBlob per file. Blobs are content
// addressed, so they are cached by hash across forks and commits.

export interface FileFilter {
	/** Files to read. */
	file(path: string): boolean;
	/** Directories worth descending into (path without trailing slash). Defaults to all. */
	dir?(path: string): boolean;
}

const BLOB_CACHE_LIMIT = 2000;
const blobCache = new Map<string, string>();
const READ_CONCURRENCY = 8;

export async function openRepo(artifacts: Artifacts, name: string): Promise<ArtifactsRepo> {
	try {
		return await artifacts.get(name);
	} catch (error) {
		throw new RepoNotFoundError(name, error);
	}
}

export class RepoNotFoundError extends Error {
	constructor(readonly repo: string, cause?: unknown) {
		super(`repository ${repo} not found${cause instanceof Error ? `: ${cause.message}` : ""}`);
		this.name = "RepoNotFoundError";
	}
}

/** Lists blob paths and hashes at a commit, descending only into directories the filter allows. */
export async function listCommitFiles(repo: ArtifactsRepo, sha: string, filter: FileFilter): Promise<{ path: string; hash: string }[]> {
	const commit = await repo.readCommit(sha);
	if (!commit) throw new Error(`commit ${sha} not found`);
	const out: { path: string; hash: string }[] = [];
	const walk = async (treeHash: string, prefix: string): Promise<void> => {
		const entries = await repo.readTree(treeHash);
		if (!entries) throw new Error(`tree ${treeHash} (${prefix || "/"}) not found at ${sha}`);
		const subtrees: Promise<void>[] = [];
		for (const entry of entries) {
			const path = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.type === "tree") {
				if (!filter.dir || filter.dir(path)) subtrees.push(walk(entry.hash, path));
			} else if ((entry.type === "blob" || entry.type === "exec") && filter.file(path)) {
				out.push({ path, hash: entry.hash });
			}
		}
		await Promise.all(subtrees);
	};
	await walk(commit.treeHash, "");
	return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Reads matching files at a commit as text, keyed by repo path. */
export async function readCommitFiles(repo: ArtifactsRepo, sha: string, filter: FileFilter): Promise<Record<string, string>> {
	const listed = await listCommitFiles(repo, sha, filter);
	const files: Record<string, string> = {};
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < listed.length) {
			const { path, hash } = listed[next++]!;
			files[path] = await readBlobText(repo, hash, path);
		}
	};
	await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, listed.length) }, worker));
	return files;
}

async function readBlobText(repo: ArtifactsRepo, hash: string, path: string): Promise<string> {
	const cached = blobCache.get(hash);
	if (cached !== undefined) return cached;
	const blob = await repo.readBlob(hash);
	if (!blob) throw new Error(`blob ${hash} for ${path} not found`);
	const text = await blob.text();
	if (blobCache.size >= BLOB_CACHE_LIMIT) blobCache.delete(blobCache.keys().next().value!);
	blobCache.set(hash, text);
	return text;
}

/** Reads one file at a ref or SHA (short refs only), or null if absent. */
export async function readTextFile(repo: ArtifactsRepo, ref: string, path: string): Promise<string | null> {
	const blob = await repo.readFile({ ref, path });
	return blob ? blob.text() : null;
}

/** Commit SHA a short ref points at, or null when the ref (or any commit) does not exist. */
export async function headOf(repo: ArtifactsRepo, ref: string): Promise<string | null> {
	try {
		return (await repo.log({ ref, limit: 1 }))[0]?.hash ?? null;
	} catch {
		return null;
	}
}

/** True for binding errors that mean the repository does not exist. */
export function isNotFound(error: unknown): boolean {
	return (error as { code?: string })?.code === "NOT_FOUND" || /not found/i.test(String((error as Error)?.message ?? error));
}

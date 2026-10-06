// Git write operations over an in-memory working copy. The Artifacts binding
// handles reads and forks; everything that creates commits, branches, tags,
// or merges goes through these helpers.
import { Buffer } from "node:buffer";
import git, { Errors } from "isomorphic-git";
import webHttp from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs.ts";
import { onAuthFor } from "./tokens.ts";

(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;

export interface GitAuthor {
	name: string;
	email: string;
}

export const PLATFORM_AUTHOR: GitAuthor = { name: "Fluid Platform", email: "platform@fluid.invalid" };

/** HTTP client used for network operations. Injectable so tests never touch the network. */
export type GitHttp = typeof webHttp;

export interface Workspace {
	fs: MemoryFS;
	dir: string;
	http: GitHttp;
}

export interface Remote {
	url: string;
	token: string;
}

export function newWorkspace(http: GitHttp = webHttp, dir = "/repo"): Workspace {
	return { fs: new MemoryFS(), dir, http };
}

/** Initializes an empty repository (used to publish into a freshly created, empty Artifacts repo). */
export async function initRepo(defaultBranch = "main", http: GitHttp = webHttp): Promise<Workspace> {
	const ws = newWorkspace(http);
	await git.init({ fs: ws.fs, dir: ws.dir, defaultBranch });
	return ws;
}

export interface CloneOptions extends Remote {
	ref?: string;
	singleBranch?: boolean;
	depth?: number;
	http?: GitHttp;
}

/** Clones a remote ref into memory. Default: the whole repo with every branch, checked out at `ref` (main). */
export async function cloneRepo(options: CloneOptions): Promise<Workspace> {
	const ws = newWorkspace(options.http);
	await git.clone({
		fs: ws.fs,
		http: ws.http,
		dir: ws.dir,
		url: options.url,
		ref: options.ref ?? "main",
		singleBranch: options.singleBranch ?? false,
		depth: options.depth,
		onAuth: onAuthFor(options.token),
	});
	return ws;
}

export type FileContent = string | Uint8Array;

/** Writes files (relative paths) into the working tree and stages them. */
export async function writeFiles(ws: Workspace, files: Record<string, FileContent>): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		assertRelativePath(path);
		await ws.fs.promises.writeFile(`${ws.dir}/${path}`, content);
		await git.add({ fs: ws.fs, dir: ws.dir, filepath: path });
	}
}

/** Removes files from the working tree and the index. Missing files are ignored. */
export async function removeFiles(ws: Workspace, paths: string[]): Promise<void> {
	for (const path of paths) {
		assertRelativePath(path);
		try {
			await ws.fs.promises.unlink(`${ws.dir}/${path}`);
		} catch (error) {
			if ((error as { code?: string }).code !== "ENOENT") throw error;
		}
		await git.remove({ fs: ws.fs, dir: ws.dir, filepath: path });
	}
}

/**
 * Makes the tree exactly `files`: writes every given file and removes tracked
 * files not in the set. Used when publishing a complete release.
 */
export async function replaceTree(ws: Workspace, files: Record<string, FileContent>): Promise<void> {
	const tracked = await listTrackedFiles(ws);
	await removeFiles(ws, tracked.filter((path) => !(path in files)));
	await writeFiles(ws, files);
}

export async function listTrackedFiles(ws: Workspace, ref?: string): Promise<string[]> {
	if (ref) return git.listFiles({ fs: ws.fs, dir: ws.dir, ref });
	return git.listFiles({ fs: ws.fs, dir: ws.dir });
}

export async function readWorkspaceFile(ws: Workspace, path: string): Promise<string | null> {
	assertRelativePath(path);
	try {
		return (await ws.fs.promises.readFile(`${ws.dir}/${path}`, "utf8")) as string;
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return null;
		throw error;
	}
}

/** Appends an `Intent-Id:` trailer (spec section 8) to a commit message. */
export function withIntentTrailer(message: string, intentId?: string | null): string {
	const trimmed = message.trimEnd();
	if (!intentId) return `${trimmed}\n`;
	if (!/^[A-Za-z0-9._-]+$/.test(intentId)) throw new Error(`withIntentTrailer: invalid intent id ${JSON.stringify(intentId)}`);
	return `${trimmed}\n\nIntent-Id: ${intentId}\n`;
}

/** Reads `Key: value` trailers from the last paragraph of a commit message. */
export function parseTrailers(message: string): Record<string, string> {
	const paragraphs = message.trim().split(/\n\s*\n/);
	if (paragraphs.length < 2) return {};
	const out: Record<string, string> = {};
	for (const line of paragraphs[paragraphs.length - 1]!.split("\n")) {
		const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.+)$/.exec(line.trim());
		if (!match) return {};
		out[match[1]!] = match[2]!.trim();
	}
	return out;
}

export interface CommitOptions {
	message: string;
	intentId?: string | null;
	author?: GitAuthor;
	/** Branch to commit on. It is created from the current HEAD and checked out if missing. */
	branch?: string;
	/** Explicit parents (merge resolution). */
	parents?: string[];
}

/** Commits the staged changes and returns the commit SHA. */
export async function commitChanges(ws: Workspace, options: CommitOptions): Promise<string> {
	if (options.branch) await checkoutBranch(ws, options.branch, { create: true });
	return git.commit({
		fs: ws.fs,
		dir: ws.dir,
		message: withIntentTrailer(options.message, options.intentId),
		author: options.author ?? PLATFORM_AUTHOR,
		...(options.parents ? { parent: options.parents } : {}),
	});
}

/** Checks out a local branch, creating it from HEAD (or `from`) when `create` is set and it does not exist. */
export async function checkoutBranch(ws: Workspace, branch: string, options: { create?: boolean; from?: string } = {}): Promise<void> {
	const branches = await git.listBranches({ fs: ws.fs, dir: ws.dir });
	if (!branches.includes(branch)) {
		const remoteRef = await resolveOrNull(ws, `refs/remotes/origin/${branch}`);
		if (remoteRef) {
			await git.branch({ fs: ws.fs, dir: ws.dir, ref: branch, object: remoteRef });
		} else if (options.create) {
			const object = options.from ? await peelToCommit(ws, await git.resolveRef({ fs: ws.fs, dir: ws.dir, ref: options.from })) : undefined;
			await git.branch({ fs: ws.fs, dir: ws.dir, ref: branch, ...(object ? { object } : {}) });
		} else {
			throw new Error(`checkoutBranch: branch ${branch} does not exist`);
		}
	}
	await git.checkout({ fs: ws.fs, dir: ws.dir, ref: branch, force: true });
}

export async function currentBranch(ws: Workspace): Promise<string | null> {
	return (await git.currentBranch({ fs: ws.fs, dir: ws.dir, fullname: false })) ?? null;
}

export async function headCommit(ws: Workspace, ref = "HEAD"): Promise<string> {
	return peelToCommit(ws, await git.resolveRef({ fs: ws.fs, dir: ws.dir, ref }));
}

async function resolveOrNull(ws: Workspace, ref: string): Promise<string | null> {
	try {
		return await git.resolveRef({ fs: ws.fs, dir: ws.dir, ref });
	} catch (error) {
		if (error instanceof Errors.NotFoundError) return null;
		throw error;
	}
}

/** Follows annotated tag objects to the commit they point at. git.merge does not peel tags itself. */
export async function peelToCommit(ws: Workspace, oid: string): Promise<string> {
	let current = oid;
	for (let depth = 0; depth < 10; depth++) {
		const { type, object } = await git.readObject({ fs: ws.fs, dir: ws.dir, oid: current, format: "parsed" });
		if (type === "commit") return current;
		if (type !== "tag") throw new Error(`peelToCommit: ${oid} resolves to a ${type}, not a commit`);
		current = (object as { object: string }).object;
	}
	throw new Error(`peelToCommit: tag chain from ${oid} is too deep`);
}

export interface TagOptions {
	tag: string;
	message: string;
	/** Ref or SHA to tag; defaults to HEAD. */
	ref?: string;
	tagger?: GitAuthor;
}

/** Creates an annotated tag and returns the tag object OID. */
export async function createTag(ws: Workspace, options: TagOptions): Promise<string> {
	const object = await headCommit(ws, options.ref ?? "HEAD");
	await git.annotatedTag({
		fs: ws.fs,
		dir: ws.dir,
		ref: options.tag,
		object,
		message: options.message,
		tagger: options.tagger ?? PLATFORM_AUTHOR,
	});
	return git.resolveRef({ fs: ws.fs, dir: ws.dir, ref: `refs/tags/${options.tag}` });
}

export async function listTags(ws: Workspace): Promise<string[]> {
	return git.listTags({ fs: ws.fs, dir: ws.dir });
}

export interface PushResult {
	ok: boolean;
	ref: string;
}

/** Pushes a local branch to the remote branch of the same name. */
export async function pushBranch(ws: Workspace, remote: Remote, branch: string, options: { force?: boolean } = {}): Promise<PushResult> {
	const result = await git.push({
		fs: ws.fs,
		http: ws.http,
		dir: ws.dir,
		url: remote.url,
		ref: branch,
		remoteRef: branch,
		force: options.force ?? false,
		onAuth: onAuthFor(remote.token),
	});
	if (!result.ok) throw new Error(`pushBranch: push of ${branch} was rejected: ${JSON.stringify(result.refs)}`);
	return { ok: true, ref: `refs/heads/${branch}` };
}

/**
 * Deletes a branch on the remote. isomorphic-git needs a local ref of the
 * same name to expand, so a throwaway local branch is created first.
 */
export async function deleteRemoteBranch(ws: Workspace, remote: Remote, branch: string): Promise<void> {
	const local = await git.listBranches({ fs: ws.fs, dir: ws.dir });
	if (!local.includes(branch)) await git.branch({ fs: ws.fs, dir: ws.dir, ref: branch });
	const result = await git.push({ fs: ws.fs, http: ws.http, dir: ws.dir, url: remote.url, ref: branch, remoteRef: branch, delete: true, onAuth: onAuthFor(remote.token) });
	if (!result.ok) throw new Error(`deleteRemoteBranch: deleting ${branch} was rejected: ${JSON.stringify(result.refs)}`);
	await git.deleteBranch({ fs: ws.fs, dir: ws.dir, ref: branch }).catch(() => undefined);
}

/** Tags must be pushed explicitly. */
export async function pushTag(ws: Workspace, remote: Remote, tag: string): Promise<PushResult> {
	const ref = `refs/tags/${tag}`;
	const result = await git.push({ fs: ws.fs, http: ws.http, dir: ws.dir, url: remote.url, ref, onAuth: onAuthFor(remote.token) });
	if (!result.ok) throw new Error(`pushTag: push of ${tag} was rejected: ${JSON.stringify(result.refs)}`);
	return { ok: true, ref };
}

/** Fetches one remote branch into a working copy (refs/remotes/origin/<branch>) so its commits can be merged. */
export async function fetchBranch(ws: Workspace, remote: Remote, branch: string): Promise<void> {
	await git.fetch({ fs: ws.fs, http: ws.http, dir: ws.dir, url: remote.url, ref: branch, remoteRef: branch, singleBranch: true, tags: false, onAuth: onAuthFor(remote.token) });
}

/** Lists refs on a remote without cloning. With peelTags, annotated tags carry the commit they point at in `peeled`. */
export async function listRemoteRefs(remote: Remote, http: GitHttp = webHttp, options: { prefix?: string; peelTags?: boolean } = {}): Promise<{ ref: string; oid: string; peeled?: string }[]> {
	const refs = await git.listServerRefs({ http, url: remote.url, onAuth: onAuthFor(remote.token), ...(options.prefix ? { prefix: options.prefix } : {}), ...(options.peelTags ? { peelTags: true } : {}) });
	return refs.map((r) => ({ ref: r.ref, oid: r.oid, ...(r.peeled ? { peeled: r.peeled } : {}) }));
}

/**
 * Fetches a stock tag into a fork working copy (remote "stock") and returns
 * the peeled commit SHA ready for mergeInto.
 */
export async function fetchStockTag(ws: Workspace, stock: Remote, tag: string): Promise<string> {
	const remotes = await git.listRemotes({ fs: ws.fs, dir: ws.dir });
	if (!remotes.some((r) => r.remote === "stock")) await git.addRemote({ fs: ws.fs, dir: ws.dir, remote: "stock", url: stock.url });
	await git.fetch({ fs: ws.fs, http: ws.http, dir: ws.dir, remote: "stock", ref: tag, tags: true, singleBranch: true, onAuth: onAuthFor(stock.token) });
	return headCommit(ws, `refs/tags/${tag}`);
}

export interface MergeConflict {
	filepaths: string[];
	bothModified: string[];
	deleteByUs: string[];
	deleteByTheirs: string[];
}

export type MergeOutcome =
	| { ok: true; oid: string; fastForward: boolean; alreadyMerged: boolean }
	| { ok: false; conflicts: MergeConflict };

/**
 * Merges `theirs` (branch, tag, or SHA; tags are peeled) into local branch
 * `ours`, leaving `ours` checked out. On conflict the branch is unchanged and
 * the conflicting paths are returned instead of thrown.
 */
export async function mergeInto(ws: Workspace, options: { ours: string; theirs: string; message?: string; author?: GitAuthor }): Promise<MergeOutcome> {
	await checkoutBranch(ws, options.ours);
	const theirsOid = await peelToCommit(ws, await resolveAnyRef(ws, options.theirs));
	try {
		const result = await git.merge({
			fs: ws.fs,
			dir: ws.dir,
			ours: options.ours,
			theirs: theirsOid,
			author: options.author ?? PLATFORM_AUTHOR,
			message: options.message ?? `Merge ${options.theirs} into ${options.ours}`,
		});
		await git.checkout({ fs: ws.fs, dir: ws.dir, ref: options.ours, force: true });
		return { ok: true, oid: result.oid ?? (await headCommit(ws)), fastForward: result.fastForward === true, alreadyMerged: result.alreadyMerged === true };
	} catch (error) {
		if (error instanceof Errors.MergeConflictError) {
			const data = error.data as Partial<MergeConflict>;
			await git.checkout({ fs: ws.fs, dir: ws.dir, ref: options.ours, force: true });
			return {
				ok: false,
				conflicts: {
					filepaths: data.filepaths ?? [],
					bothModified: data.bothModified ?? [],
					deleteByUs: data.deleteByUs ?? [],
					deleteByTheirs: data.deleteByTheirs ?? [],
				},
			};
		}
		throw error;
	}
}

/**
 * Moves local branch `branch` to `commit` only when that is a fast-forward
 * (the commit contains the branch head). "already": the branch already
 * contains the commit. "diverged": the branch moved on; nothing changes and
 * `oid` is the branch head. Pushing the result without force is then a
 * compare-and-swap: the remote refuses it if its branch moved meanwhile.
 */
export async function fastForward(ws: Workspace, branch: string, commit: string): Promise<{ outcome: "fast-forward" | "already" | "diverged"; oid: string }> {
	await checkoutBranch(ws, branch);
	const head = await headCommit(ws, branch);
	const target = await peelToCommit(ws, await resolveAnyRef(ws, commit));
	if (head === target || (await git.isDescendent({ fs: ws.fs, dir: ws.dir, oid: head, ancestor: target, depth: -1 }))) return { outcome: "already", oid: head };
	if (!(await git.isDescendent({ fs: ws.fs, dir: ws.dir, oid: target, ancestor: head, depth: -1 }))) return { outcome: "diverged", oid: head };
	await git.writeRef({ fs: ws.fs, dir: ws.dir, ref: `refs/heads/${branch}`, value: target, force: true });
	await git.checkout({ fs: ws.fs, dir: ws.dir, ref: branch, force: true });
	return { outcome: "fast-forward", oid: target };
}

/** Points local branch `branch` at `commit` (any commit in the working copy) and checks it out. Pushing the result needs force. */
export async function resetBranch(ws: Workspace, branch: string, commit: string): Promise<void> {
	const target = await peelToCommit(ws, await resolveAnyRef(ws, commit));
	await git.writeRef({ fs: ws.fs, dir: ws.dir, ref: `refs/heads/${branch}`, value: target, force: true });
	await git.checkout({ fs: ws.fs, dir: ws.dir, ref: branch, force: true });
}

/**
 * Makes the working tree exactly the tree of `commit` (an ancestor in this
 * working copy), plus `extra` files, and stages it. Committing the result on
 * a branch reverts the branch to that tree with a new commit: history is kept
 * and nothing is rewritten.
 */
export async function restoreTreeFrom(ws: Workspace, commit: string, extra: Record<string, FileContent> = {}): Promise<void> {
	const target = await peelToCommit(ws, await resolveAnyRef(ws, commit));
	const paths = await git.listFiles({ fs: ws.fs, dir: ws.dir, ref: target });
	const files: Record<string, FileContent> = {};
	for (const path of paths) files[path] = (await git.readBlob({ fs: ws.fs, dir: ws.dir, oid: target, filepath: path })).blob;
	await replaceTree(ws, { ...files, ...extra });
}

export interface FileChange {
	path: string;
	status: "added" | "modified" | "deleted";
}

/** The best common ancestor of two commits, or null when they share no history. */
export async function mergeBase(ws: Workspace, a: string, b: string): Promise<string | null> {
	const [base] = await git.findMergeBase({ fs: ws.fs, dir: ws.dir, oids: [a, b] });
	return (base as string | undefined) ?? null;
}

/** Files that differ between two commits (base null: every file in head is added), sorted by path. */
export async function changedFiles(ws: Workspace, base: string | null, head: string): Promise<FileChange[]> {
	const blobs = async (oid: string | null) => {
		const out = new Map<string, string>();
		if (!oid) return out;
		await git.walk({
			fs: ws.fs,
			dir: ws.dir,
			trees: [git.TREE({ ref: oid })],
			map: async (path, [entry]) => {
				if (!entry || path === ".") return true;
				if ((await entry.type()) === "blob") out.set(path, await entry.oid());
				return true;
			},
		});
		return out;
	};
	const [before, after] = await Promise.all([blobs(base), blobs(head)]);
	const changes: FileChange[] = [];
	for (const [path, oid] of after) {
		const old = before.get(path);
		if (old === undefined) changes.push({ path, status: "added" });
		else if (old !== oid) changes.push({ path, status: "modified" });
	}
	for (const path of before.keys()) if (!after.has(path)) changes.push({ path, status: "deleted" });
	return changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/** How far back from base commitsBetween looks to recognize history the branch shares with it. */
const BASE_HISTORY_WALK = 1000;

/**
 * Commits reachable from head but not from base, oldest first, at most
 * `limit`. Bounded: base's history is read at most BASE_HISTORY_WALK commits
 * deep, and at most 4 x limit commits are visited from head.
 */
export async function commitsBetween(ws: Workspace, base: string | null, head: string, limit = 50): Promise<{ oid: string; message: string }[]> {
	const shared = new Set<string>();
	if (base) for (const entry of await git.log({ fs: ws.fs, dir: ws.dir, ref: base, depth: BASE_HISTORY_WALK })) shared.add(entry.oid);
	const out: { oid: string; message: string }[] = [];
	const queue = [head];
	const seen = new Set<string>();
	while (queue.length > 0 && out.length < limit && seen.size < limit * 4) {
		const oid = queue.shift()!;
		if (seen.has(oid) || shared.has(oid)) continue;
		seen.add(oid);
		const { commit } = await git.readCommit({ fs: ws.fs, dir: ws.dir, oid });
		out.push({ oid, message: commit.message });
		queue.push(...commit.parent);
	}
	return out.reverse();
}

/** First parent of a commit (the branch a merge was made on), or null for a root commit. */
export async function firstParent(ws: Workspace, oid: string): Promise<string | null> {
	const { commit } = await git.readCommit({ fs: ws.fs, dir: ws.dir, oid });
	return commit.parent[0] ?? null;
}

export interface ConflictVersions {
	path: string;
	base: string | null;
	ours: string | null;
	theirs: string | null;
	/** Worktree text with conflict markers, when git produced one. */
	marked: string | null;
}

/** Content to keep for a conflicted path; null deletes it. */
export type ConflictResolver = (versions: ConflictVersions[]) => Promise<Record<string, string | null>>;

export type ResolvedMergeOutcome =
	| { ok: true; oid: string; fastForward: boolean; alreadyMerged: boolean; conflicts: string[] }
	| { ok: false; error: string; conflicts: string[] };

/**
 * Merges `theirs` into local branch `ours`. Clean merges behave like
 * mergeInto. On textual conflicts, git's merge result is kept for every
 * clean path, `resolve` decides each conflicted path from its base, ours,
 * and theirs versions, and a two-parent merge commit is written on `ours`.
 */
export async function mergeWithResolver(
	ws: Workspace,
	options: { ours: string; theirs: string; message: string; author?: GitAuthor; resolve: ConflictResolver },
): Promise<ResolvedMergeOutcome> {
	const first = await mergeInto(ws, options);
	if (first.ok) return { ...first, conflicts: [] };
	const conflicts = first.conflicts.filepaths;
	await checkoutBranch(ws, options.ours);
	const oursOid = await headCommit(ws, options.ours);
	const theirsOid = await peelToCommit(ws, await resolveAnyRef(ws, options.theirs));
	const [baseOid] = await git.findMergeBase({ fs: ws.fs, dir: ws.dir, oids: [oursOid, theirsOid] });
	try {
		await git.merge({ fs: ws.fs, dir: ws.dir, ours: options.ours, theirs: theirsOid, author: options.author ?? PLATFORM_AUTHOR, message: options.message, abortOnConflict: false });
	} catch (error) {
		if (!(error instanceof Errors.MergeConflictError)) throw error;
	}
	const versions: ConflictVersions[] = [];
	for (const path of conflicts) {
		versions.push({
			path,
			base: baseOid ? await readBlobAt(ws, baseOid as string, path) : null,
			ours: await readBlobAt(ws, oursOid, path),
			theirs: await readBlobAt(ws, theirsOid, path),
			marked: await readWorkspaceFile(ws, path),
		});
	}
	let resolved: Record<string, string | null>;
	try {
		resolved = await options.resolve(versions);
	} catch (error) {
		await git.checkout({ fs: ws.fs, dir: ws.dir, ref: options.ours, force: true });
		return { ok: false, error: `conflict resolution failed: ${error instanceof Error ? error.message : String(error)}`, conflicts };
	}
	for (const path of conflicts) {
		if (!(path in resolved)) {
			await git.checkout({ fs: ws.fs, dir: ws.dir, ref: options.ours, force: true });
			return { ok: false, error: `no resolution for ${path}`, conflicts };
		}
	}
	for (const [path, content] of Object.entries(resolved)) {
		if (content === null) await removeFiles(ws, [path]);
		else await writeFiles(ws, { [path]: content });
	}
	// Stage everything git's merge left in the worktree (clean merges, additions, deletions).
	for (const [filepath, head, workdir] of await git.statusMatrix({ fs: ws.fs, dir: ws.dir })) {
		if (workdir === 0 && head === 1) await git.remove({ fs: ws.fs, dir: ws.dir, filepath });
		else if (workdir !== 0) await git.add({ fs: ws.fs, dir: ws.dir, filepath });
	}
	const oid = await git.commit({ fs: ws.fs, dir: ws.dir, message: options.message.endsWith("\n") ? options.message : `${options.message}\n`, author: options.author ?? PLATFORM_AUTHOR, parent: [oursOid, theirsOid] });
	return { ok: true, oid, fastForward: false, alreadyMerged: false, conflicts };
}

async function readBlobAt(ws: Workspace, commitOid: string, path: string): Promise<string | null> {
	try {
		const { blob } = await git.readBlob({ fs: ws.fs, dir: ws.dir, oid: commitOid, filepath: path });
		return new TextDecoder().decode(blob);
	} catch (error) {
		if (error instanceof Errors.NotFoundError) return null;
		throw error;
	}
}

/** Resolves a short name (branch, tag, remote branch) or SHA to an object id. */
export async function resolveAnyRef(ws: Workspace, ref: string): Promise<string> {
	if (/^[0-9a-f]{40}$/.test(ref)) return ref;
	for (const candidate of [ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/remotes/origin/${ref}`]) {
		const oid = await resolveOrNull(ws, candidate);
		if (oid) return oid;
	}
	throw new Error(`resolveAnyRef: ${ref} not found`);
}

/** One entry of a commit's tree: its object id, its git mode, and its text when it is valid UTF-8 (null otherwise). */
export interface TreeFile {
	oid: string;
	mode: string;
	text: string | null;
}

/**
 * Every entry of a commit's tree, by path. Text is decoded strictly (an
 * invalid UTF-8 blob reads as null, and a byte order mark is kept), so a
 * file's text encodes back to exactly its bytes.
 */
export async function readTree(ws: Workspace, commit: string): Promise<Record<string, TreeFile>> {
	const oid = await peelToCommit(ws, await resolveAnyRef(ws, commit));
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	const out: Record<string, TreeFile> = {};
	const walk = async (treeOid: string, prefix: string): Promise<void> => {
		const { tree } = await git.readTree({ fs: ws.fs, dir: ws.dir, oid: treeOid });
		for (const entry of tree) {
			const path = prefix ? `${prefix}/${entry.path}` : entry.path;
			if (entry.type === "tree") {
				await walk(entry.oid, path);
				continue;
			}
			let text: string | null = null;
			if (entry.type === "blob") {
				try {
					text = decoder.decode((await git.readBlob({ fs: ws.fs, dir: ws.dir, oid: entry.oid })).blob);
				} catch {
					text = null;
				}
			}
			out[path] = { oid: entry.oid, mode: entry.mode, text };
		}
	};
	const { commit: parsed } = await git.readCommit({ fs: ws.fs, dir: ws.dir, oid });
	await walk(parsed.tree, "");
	return out;
}

/** The text files of a commit's tree (binary and non-UTF-8 blobs are left out). */
export async function readTreeFiles(ws: Workspace, commit: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	for (const [path, entry] of Object.entries(await readTree(ws, commit))) if (entry.text !== null) files[path] = entry.text;
	return files;
}

/** A blob's bytes by object id. */
export async function readBlobBytes(ws: Workspace, oid: string): Promise<Uint8Array> {
	return (await git.readBlob({ fs: ws.fs, dir: ws.dir, oid })).blob;
}

/** Intent ids named by Intent-Id trailers in the history of `ref`, oldest first, each once. */
export async function intentCommitOrder(ws: Workspace, ref: string, depth = 1000): Promise<string[]> {
	const entries = await git.log({ fs: ws.fs, dir: ws.dir, ref, depth });
	const ids: string[] = [];
	for (const entry of [...entries].reverse()) {
		const id = parseTrailers(entry.commit.message)["Intent-Id"];
		if (id && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/** Reads a commit message, e.g. to find its Intent-Id trailer. */
export async function readCommitMessage(ws: Workspace, oid: string): Promise<string> {
	const { commit } = await git.readCommit({ fs: ws.fs, dir: ws.dir, oid });
	return commit.message;
}

function assertRelativePath(path: string): void {
	if (path === "" || path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "." || part === "")) {
		throw new Error(`invalid repository path ${JSON.stringify(path)}`);
	}
	if (path === ".git" || path.startsWith(".git/")) throw new Error(`refusing to write inside .git: ${path}`);
}

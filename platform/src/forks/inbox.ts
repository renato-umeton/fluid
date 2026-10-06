// Import from an inbox. The owner's own agent pushes to inbox-<fork> (the
// only repo its token can write). Each push event for a work/<name> branch
// there starts one ImportWorkflow (workflows/import.ts), so memory, CPU, and
// retries belong to that import alone. The import fetches only that branch
// head (no tags, no other refs), checks it against the caps and for unsafe
// paths, and pushes it to the real fork as work/inbox/<name>, a name no
// platform workflow uses. The gate then runs as for any other push. The
// platform never deletes, and never overwrites a branch an import did not
// make. Anything over a cap is refused with a clear run message.
import git, { Errors } from "isomorphic-git";
import { fnv1a, type InboxImport } from "../events/filter.ts";
import { changedFiles, cloneRepo, commitsBetween, headCommit, listRemoteRefs, mergeBase, TreeTooLargeError, type GitHttp, type Remote, type Workspace } from "../git/ops.ts";
import { onAuthFor } from "../git/tokens.ts";
import type { QuotaDecision } from "../durable/quota.ts";
import { fleetStub, runsStub } from "../stubs.ts";
import { ensureRun, errorText, linkGateParent, repoRemote, startInstance, type ImportParams, type InstanceHandle, type WorkflowBinding } from "../workflows/common.ts";
import { outsideGrantKey, type OutsideGrant } from "./outside.ts";

export const IMPORT_LIMITS = {
	/** Bytes the fetch from the inbox may download (the pack holds only what the fork does not have). */
	maxPackBytes: 8 * 1024 * 1024,
	maxCommits: 50,
	maxFiles: 200,
	maxBlobBytes: 1024 * 1024,
	/** Files and directories in the fork's tree and in the pushed tree, counted before the diff is built. */
	maxTreeEntries: 5000,
};
export type ImportLimits = typeof IMPORT_LIMITS;

/** Imports per fork per hour (the same as customizations per user) and across the platform. */
export const IMPORT_QUOTAS = { perForkPerHour: 10, globalPerHour: 200 };

/** Imported branches live under this prefix in the fork. Customize and seed branches never contain a slash after work/. */
export const IMPORT_NAMESPACE = "work/inbox/";

export class ImportTooLargeError extends Error {
	constructor(readonly limit: number) {
		super(`the push is larger than ${limit} bytes to download`);
		this.name = "ImportTooLargeError";
	}
}

/** The fork branch an inbox branch is imported to: work/<name> becomes work/inbox/<name>. */
export function forkBranchFor(inboxBranch: string): string {
	return `${IMPORT_NAMESPACE}${inboxBranch.slice("work/".length)}`;
}

/** An HTTP client for isomorphic-git that stops reading a response once it passes maxBytes. */
export function cappedHttp(http: GitHttp, maxBytes: number): GitHttp {
	return {
		async request(request) {
			const response = await http.request(request);
			const body = response.body;
			if (!body) return response;
			let total = 0;
			response.body = (async function* () {
				for await (const chunk of body) {
					total += chunk.byteLength;
					if (total > maxBytes) throw new ImportTooLargeError(maxBytes);
					yield chunk;
				}
			})();
			return response;
		},
	};
}

/** A path git or the platform could misread: empty, ".", or ".." parts, a .git part (any case), a backslash, or a control character. */
export function unsafePath(path: string): boolean {
	if (path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return true;
	return path.split("/").some((part) => part === "" || part === "." || part === ".." || part.trim().toLowerCase() === ".git");
}

/** Checks a fetched head against the caps: tree size, commits since the fork's main, files changed, unsafe paths, and each file's size. */
export async function checkImport(ws: Workspace, input: { base: string | null; head: string }, limits: ImportLimits = IMPORT_LIMITS): Promise<{ ok: true; commits: number; files: number } | { ok: false; reason: string }> {
	let changes;
	try {
		changes = await changedFiles(ws, input.base, input.head, { maxEntries: limits.maxTreeEntries });
	} catch (error) {
		if (error instanceof TreeTooLargeError) return { ok: false, reason: error.message };
		throw error;
	}
	const unsafe = changes.find((c) => unsafePath(c.path));
	if (unsafe) return { ok: false, reason: `the branch has an unsafe path ${JSON.stringify(unsafe.path.slice(0, 200))}` };
	const commits = await commitsBetween(ws, input.base, input.head, limits.maxCommits + 1);
	if (commits.length > limits.maxCommits) return { ok: false, reason: `the branch has more than ${limits.maxCommits} commits since your fork's main` };
	if (changes.length > limits.maxFiles) return { ok: false, reason: `the branch changes ${changes.length} files; at most ${limits.maxFiles} are imported` };
	for (const change of changes) {
		if (change.status === "deleted") continue;
		const { blob } = await git.readBlob({ fs: ws.fs, dir: ws.dir, oid: input.head, filepath: change.path });
		if (blob.byteLength > limits.maxBlobBytes) return { ok: false, reason: `${change.path} is ${blob.byteLength} bytes; at most ${limits.maxBlobBytes}` };
	}
	return { ok: true, commits: commits.length, files: changes.length };
}

/** create: new branch in the fork. update: a branch an earlier import made. refuse: anything else. */
export function importPushMode(input: { exists: boolean; imported: boolean }): "create" | "update" | "refuse" {
	if (!input.exists) return "create";
	return input.imported ? "update" : "refuse";
}

export function importRunId(fork: string, branch: string, commit: string): string {
	return `run_import_${commit.slice(0, 12)}_${fnv1a(`${fork}\n${branch}`)}`;
}

/** Imports of one (fork, branch, commit) at most: the first plus 19 pushed again after a refusal. */
export const IMPORT_ATTEMPTS = 20;

/**
 * Whether an import instance ended without importing: refused (quota, caps,
 * a replaced inbox), skipped, cancelled because the branch moved, or errored.
 * Pushing the same commit again then deserves a new import.
 */
function importEndedWithout(state: Awaited<ReturnType<InstanceHandle["status"]>>): boolean {
	if (state.status === "errored" || state.status === "terminated") return true;
	if (state.status !== "complete") return false;
	const outcome = (state.output as { status?: unknown } | undefined)?.status;
	return outcome === "refused" || outcome === "skipped" || outcome === "moved";
}

/**
 * Starts the import for one inbox push. Ids are the one from importRunId,
 * then -r1, -r2, and so on. An attempt that is running or imported means the
 * push is already handled (a redelivered event); one that ended without
 * importing is skipped, so pushing the same commit again after a refusal
 * starts a new import. A redelivery after a refusal starts one too (the
 * event carries nothing that tells the two apart); it is checked and
 * refused or imported like any push.
 */
export async function startImportInstance(binding: WorkflowBinding<ImportParams>, imp: InboxImport): Promise<{ id: string; created: boolean }> {
	const base = importRunId(imp.fork, imp.branch, imp.commit).slice("run_".length);
	let id = base;
	for (let attempt = 0; attempt < IMPORT_ATTEMPTS; attempt++) {
		id = attempt === 0 ? base : `${base}-r${attempt}`;
		const started = await startInstance(binding, id, { runId: `run_${id}`, ...imp });
		if (started.created) return { id, created: true };
		const state = await (await binding.get(id)).status().catch(() => ({ status: "unknown" }));
		if (!importEndedWithout(state)) return { id, created: false };
	}
	console.warn(`import of ${imp.branch} at ${imp.commit.slice(0, 7)} for ${imp.fork} was tried ${IMPORT_ATTEMPTS} times; not started again`);
	return { id, created: false };
}

/** Record that an import made this fork branch, keyed by the full branch name. */
export function importedMarkName(fork: string, branch: string): string {
	return `imported_${fork}_${branch}`;
}

/**
 * Takes one import from the fork's hourly quota and the global one. Returns
 * why the import is refused, or null.
 */
export async function takeImportQuota(take: (subject: string, bucket: string, limit: number, windowSeconds: number) => Promise<QuotaDecision>, fork: string): Promise<string | null> {
	const own = await take(`fork:${fork}`, "import", IMPORT_QUOTAS.perForkPerHour, 3600);
	if (!own.allowed) return `this fork already imported ${IMPORT_QUOTAS.perForkPerHour} pushes in the last hour; push again in ${own.retryAfterSeconds} seconds`;
	const all = await take("global", "import", IMPORT_QUOTAS.globalPerHour, 3600);
	if (!all.allowed) return `the platform is importing ${IMPORT_QUOTAS.globalPerHour} pushes an hour already; push again in ${all.retryAfterSeconds} seconds`;
	return null;
}

/** What runImport needs from the outside world, so it can run on in-memory repos in tests. */
export interface ImportIO {
	cloneFork(): Promise<Workspace>;
	/** Fetches refs/heads/<branch> of the inbox into refs/remotes/inbox/<branch> and returns its head. */
	fetchInbox(ws: Workspace, branch: string): Promise<string>;
	forkBranchHead(branch: string): Promise<string | null>;
	/** Pushes the full ref name to the same full ref name in the fork. */
	pushFork(ws: Workspace, ref: string, force: boolean): Promise<void>;
	isMarked(branch: string): Promise<boolean>;
	mark(branch: string): Promise<void>;
	/** Records the import run as the parent of the gate for this push, before the push. */
	linkGate(branch: string, commit: string): Promise<void>;
}

export type ImportOutcome =
	| { status: "imported"; branch: string; commits: number; files: number; replaced: boolean }
	| { status: "already"; branch: string }
	| { status: "moved"; head: string }
	| { status: "refused"; reason: string };

/**
 * One import. Problems with the push itself (over a cap, an unsafe path, a
 * branch the import may not replace) are "refused" and never retried;
 * anything else is thrown so the workflow step retries it.
 */
export async function runImport(io: ImportIO, imp: InboxImport, limits: ImportLimits = IMPORT_LIMITS): Promise<ImportOutcome> {
	try {
		const ws = await io.cloneFork();
		const head = await io.fetchInbox(ws, imp.branch);
		if (head !== imp.commit) return { status: "moved", head };
		const checked = await checkImport(ws, { base: await mergeBase(ws, await headCommit(ws, "main"), imp.commit), head: imp.commit }, limits);
		if (!checked.ok) return { status: "refused", reason: checked.reason };
		const target = forkBranchFor(imp.branch);
		const existing = await io.forkBranchHead(target);
		if (existing === imp.commit) {
			// A retry after a push that succeeded: make the mark consistent and go on to the gate.
			await io.mark(target);
			return { status: "already", branch: target };
		}
		const mode = importPushMode({ exists: existing !== null, imported: existing !== null && (await io.isMarked(target)) });
		if (mode === "refuse") return { status: "refused", reason: `${target} already exists in your fork and was not made by an import` };
		await io.linkGate(target, imp.commit);
		const ref = `refs/heads/${target}`;
		await git.writeRef({ fs: ws.fs, dir: ws.dir, ref, value: imp.commit, force: true });
		await io.pushFork(ws, ref, mode === "update");
		await io.mark(target);
		return { status: "imported", branch: target, commits: checked.commits, files: checked.files, replaced: mode === "update" };
	} catch (error) {
		if (error instanceof ImportTooLargeError || error instanceof TreeTooLargeError) return { status: "refused", reason: error.message };
		if (error instanceof Errors.UnsafeFilepathError) return { status: "refused", reason: `the branch has an unsafe path: ${errorText(error)}` };
		throw error;
	}
}

/** The live ImportIO: Artifacts remotes with short-lived platform tokens, the capped fetch, and Runs records for marks and gate links. */
export function liveImportIO(env: Env, imp: InboxImport, runId: string): ImportIO {
	let fork: Remote | null = null;
	const forkRemote = async () => (fork ??= await repoRemote(env, imp.fork, "write"));
	return {
		cloneFork: async () => cloneRepo({ ...(await forkRemote()), ref: "main", singleBranch: true }),
		fetchInbox: async (ws, branch) => {
			const inbox = await repoRemote(env, imp.inbox, "read");
			await git.addRemote({ fs: ws.fs, dir: ws.dir, remote: "inbox", url: inbox.url, force: true });
			await git.fetch({ fs: ws.fs, http: cappedHttp(ws.http, IMPORT_LIMITS.maxPackBytes), dir: ws.dir, remote: "inbox", ref: `refs/heads/${branch}`, singleBranch: true, tags: false, onAuth: onAuthFor(inbox.token) });
			return headCommit(ws, `refs/remotes/inbox/${branch}`);
		},
		forkBranchHead: async (branch) => (await listRemoteRefs(await forkRemote(), undefined, { prefix: `refs/heads/${branch}` })).find((r) => r.ref === `refs/heads/${branch}`)?.oid ?? null,
		pushFork: async (ws, ref, force) => {
			const remote = await forkRemote();
			const result = await git.push({ fs: ws.fs, http: ws.http, dir: ws.dir, url: remote.url, ref, remoteRef: ref, force, onAuth: onAuthFor(remote.token) });
			if (!result.ok) throw new Error(`push of ${ref} to ${imp.fork} was rejected: ${JSON.stringify(result.refs)}`);
		},
		isMarked: async (branch) => (await runsStub(env, importedMarkName(imp.fork, branch)).get()) !== null,
		mark: async (branch) => ensureRun(env, { id: importedMarkName(imp.fork, branch), kind: "import", repo: imp.fork, fields: { branch, importedMark: true } }),
		linkGate: async (branch, commit) => linkGateParent(env, imp.fork, branch, commit, { parentRunId: runId, source: "import" }),
	};
}

/**
 * Points the inbox's main at the fork's main, so the outside agent can pull
 * the latest gated main. Best effort: a failure is logged and changes nothing.
 */
export async function syncInboxMain(env: Env, fork: string): Promise<void> {
	try {
		const grant = (await fleetStub(env).getValue(outsideGrantKey(fork))) as OutsideGrant | null;
		if (!grant?.inbox) return;
		const forkRemote = await repoRemote(env, fork, "read");
		const inboxRemote = await repoRemote(env, grant.inbox, "write");
		const ws = await cloneRepo({ ...forkRemote, ref: "main", singleBranch: true });
		await git.push({ fs: ws.fs, http: ws.http, dir: ws.dir, url: inboxRemote.url, ref: "refs/heads/main", remoteRef: "refs/heads/main", force: true, onAuth: onAuthFor(inboxRemote.token) });
	} catch (error) {
		console.warn(`inbox main sync for ${fork} failed: ${errorText(error)}`);
	}
}

// Import from an inbox. The owner's own agent pushes to inbox-<fork> (the
// only repo its token can write). On each push event for a work/* branch
// there, the platform fetches only that branch head (no tags, no other refs),
// checks it against the caps, and pushes it to the real fork under the same
// work/* name, where the gate runs as for any other push. The platform never
// deletes, and never overwrites a branch it did not create by an import. A
// change over the caps is refused with a clear run message.
import git from "isomorphic-git";
import { fnv1a, gateInstanceId, type InboxImport } from "../events/filter.ts";
import { changedFiles, cloneRepo, commitsBetween, headCommit, listRemoteRefs, mergeBase, type GitHttp, type Remote, type Workspace } from "../git/ops.ts";
import { onAuthFor } from "../git/tokens.ts";
import { fleetStub, runsStub } from "../stubs.ts";
import { ensureRun, errorText, linkGateParent, repoRemote, runLog, startGateInstance, type AppExports } from "../workflows/common.ts";
import { outsideGrantKey, type OutsideGrant } from "./outside.ts";

export const IMPORT_LIMITS = {
	/** Bytes the fetch from the inbox may download (the pack holds only what the fork does not have). */
	maxPackBytes: 8 * 1024 * 1024,
	maxCommits: 50,
	maxFiles: 200,
	maxBlobBytes: 1024 * 1024,
};
export type ImportLimits = typeof IMPORT_LIMITS;

export class ImportTooLargeError extends Error {
	constructor(readonly limit: number) {
		super(`the push is larger than ${limit} bytes to download`);
		this.name = "ImportTooLargeError";
	}
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

/** Checks a fetched head against the caps: commits since the fork's main, files changed, and each file's size. */
export async function checkImport(ws: Workspace, input: { base: string | null; head: string }, limits: ImportLimits = IMPORT_LIMITS): Promise<{ ok: true; commits: number; files: number } | { ok: false; reason: string }> {
	const commits = await commitsBetween(ws, input.base, input.head, limits.maxCommits + 1);
	if (commits.length > limits.maxCommits) return { ok: false, reason: `the branch has more than ${limits.maxCommits} commits since your fork's main` };
	const changes = await changedFiles(ws, input.base, input.head);
	if (changes.length > limits.maxFiles) return { ok: false, reason: `the branch changes ${changes.length} files; at most ${limits.maxFiles} are imported` };
	for (const change of changes) {
		if (change.status === "deleted") continue;
		const { blob } = await git.readBlob({ fs: ws.fs, dir: ws.dir, oid: input.head, filepath: change.path });
		if (blob.byteLength > limits.maxBlobBytes) return { ok: false, reason: `${change.path} is ${blob.byteLength} bytes; at most ${limits.maxBlobBytes}` };
	}
	return { ok: true, commits: commits.length, files: changes.length };
}

/** create: new branch in the fork. update: a branch an earlier import made. refuse: a branch the platform made. */
export function importPushMode(input: { exists: boolean; imported: boolean }): "create" | "update" | "refuse" {
	if (!input.exists) return "create";
	return input.imported ? "update" : "refuse";
}

export function importRunId(fork: string, branch: string, commit: string): string {
	return `run_import_${commit.slice(0, 12)}_${fnv1a(`${fork}\n${branch}`)}`;
}

function importedMarkName(fork: string, branch: string): string {
	return `imported_${fork}_${fnv1a(branch)}`;
}

/**
 * Copies one inbox work branch head into the fork and starts its gate.
 * Problems with the push itself end the run as failed and return; anything
 * else (Artifacts unreachable) is thrown so the queue message is retried.
 */
export async function importInboxBranch(env: Env, exports: AppExports, imp: InboxImport): Promise<void> {
	const fleet = fleetStub(env);
	const entry = await fleet.get(imp.fork);
	const grant = (await fleet.getValue(outsideGrantKey(imp.fork))) as OutsideGrant | null;
	if (!entry || entry.status === "provisioning" || grant?.inbox !== imp.inbox) {
		console.log(`import skipped: ${imp.inbox} ${imp.branch}: no fork with this inbox`);
		return;
	}
	const runId = importRunId(imp.fork, imp.branch, imp.commit);
	await ensureRun(env, { id: runId, kind: "import", repo: imp.fork, fields: { inbox: imp.inbox, branch: imp.branch, commit: imp.commit } });
	const log = runLog(env, runId);
	const fail = async (detail: string) => {
		await log.step("Import from your inbox", "failed", detail);
		await log.status("failed", { error: detail });
	};
	await log.step("Import from your inbox", "running", `${imp.branch} at ${imp.commit.slice(0, 7)} in ${imp.inbox}; only this branch head is read`);

	const forkRemote = await repoRemote(env, imp.fork, "write");
	const inboxRemote = await repoRemote(env, imp.inbox, "read");
	const ws = await cloneRepo({ ...forkRemote, ref: "main", singleBranch: true });
	const fetched = await fetchInboxBranch(ws, inboxRemote, imp.branch);
	if (!fetched.ok) return fail(`Not imported: ${fetched.reason}. Nothing changed in your fork.`);
	if (fetched.head !== imp.commit) {
		await log.step("Import from your inbox", "info", `${imp.branch} moved on to ${fetched.head.slice(0, 7)} in the inbox; that push is imported on its own`);
		await log.status("cancelled", { cancelReason: "the inbox branch moved on" });
		return;
	}
	const main = await headCommit(ws, "main");
	const checked = await checkImport(ws, { base: await mergeBase(ws, main, imp.commit), head: imp.commit });
	if (!checked.ok) return fail(`Not imported: ${checked.reason}. Nothing changed in your fork; split the change and push again.`);

	const existing = (await listRemoteRefs(forkRemote, undefined, { prefix: `refs/heads/${imp.branch}` })).find((r) => r.ref === `refs/heads/${imp.branch}`);
	const marks = runsStub(env, importedMarkName(imp.fork, imp.branch));
	const mode = importPushMode({ exists: Boolean(existing), imported: (await marks.get()) !== null });
	if (mode === "refuse") return fail(`Not imported: ${imp.branch} already exists in your fork and was made by the platform, not by an import. Push under another work/ name.`);
	if (existing?.oid === imp.commit) {
		await log.step("Import from your inbox", "done", `${imp.branch} in your fork is already at ${imp.commit.slice(0, 7)}`);
	} else {
		if (mode === "create") await ensureRun(env, { id: importedMarkName(imp.fork, imp.branch), kind: "import", repo: imp.fork, fields: { branch: imp.branch, importedMark: true } });
		// Recorded before the push: the push event may start the gate before this import does.
		await linkGateParent(env, imp.fork, imp.branch, imp.commit, { parentRunId: runId, source: "import" });
		await git.writeRef({ fs: ws.fs, dir: ws.dir, ref: `refs/heads/${imp.branch}`, value: imp.commit, force: true });
		// Full ref names on both sides: nothing named like the branch (a tag) can stand in for it.
		const result = await git.push({ fs: ws.fs, http: ws.http, dir: ws.dir, url: forkRemote.url, ref: `refs/heads/${imp.branch}`, remoteRef: `refs/heads/${imp.branch}`, force: mode === "update", onAuth: onAuthFor(forkRemote.token) });
		if (!result.ok) throw new Error(`push of ${imp.branch} to ${imp.fork} was rejected: ${JSON.stringify(result.refs)}`);
		await log.step("Import from your inbox", "done", `${checked.commits} commit${checked.commits === 1 ? "" : "s"}, ${checked.files} file${checked.files === 1 ? "" : "s"}; pushed to ${imp.branch} in ${imp.fork}${mode === "update" ? " (replacing an earlier import)" : ""}`);
	}
	const started = await startGateInstance(exports.GateWorkflow, gateInstanceId(imp.fork, imp.branch, imp.commit), { repo: imp.fork, branch: imp.branch, commit: imp.commit, mode: "merge", source: "import", parentRunId: runId });
	await log.step("Gate", "done", `${started.runId} gates ${imp.branch}; main moves only if it passes`);
	await log.status("passed", { gateRunId: started.runId });
}

/** Fetches refs/heads/<branch> of the inbox, and nothing else, with the download capped. */
async function fetchInboxBranch(ws: Workspace, inbox: Remote, branch: string): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
	await git.addRemote({ fs: ws.fs, dir: ws.dir, remote: "inbox", url: inbox.url, force: true });
	try {
		await git.fetch({ fs: ws.fs, http: cappedHttp(ws.http, IMPORT_LIMITS.maxPackBytes), dir: ws.dir, remote: "inbox", ref: `refs/heads/${branch}`, singleBranch: true, tags: false, onAuth: onAuthFor(inbox.token) });
	} catch (error) {
		if (error instanceof ImportTooLargeError) return { ok: false, reason: error.message };
		throw error;
	}
	return { ok: true, head: await headCommit(ws, `refs/remotes/inbox/${branch}`) };
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

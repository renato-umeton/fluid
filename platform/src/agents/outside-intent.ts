// Intent records for changes from outside the platform (the owner's own
// agent, imported from the fork's inbox). Every change that reaches main
// carries a build-time record, so when a branch adds none, the gate drafts
// one from the commit messages and the files touched, commits it onto the
// branch, and gates that commit instead. Branches that already add a valid
// .intent/<id>.json are gated as they are. For every gated branch the gate
// also checks that existing records are only ever added to, never changed or
// deleted, and records the floor files the real diff touches (for harvest).
import git from "isomorphic-git";
import type { BuildTimeIntent } from "../forks/provision.ts";
import { changedFiles, checkoutBranch, commitChanges, commitsBetween, firstParent, headCommit, mergeBase, parseTrailers, readCommitMessage, readWorkspaceFile, withIntentTrailer, writeFiles, type FileChange, type Workspace } from "../git/ops.ts";
import { pinnedTagOf } from "../stock/releases.ts";
import type { GateParams } from "../workflows/common.ts";
import { FLOOR_FILES } from "./harvest-cluster.ts";
import { cleanText, intentJson, intentPath, MAX_REQUEST_CHARS, parseIntentRecord } from "./intent.ts";

export const OUTSIDE_AGENT = "outside-agent";
export const OUTSIDE_SOURCE = "outside-push";
const MAX_COMMITS_LISTED = 20;
/** Files listed in a drafted record; files_total keeps the real count. */
export const MAX_DRAFT_FILES = 100;
/**
 * Agents only the platform writes records for. Repair, harvest, and intent
 * replay trust these names (a "customization-agent" record can be a replay
 * wish), so a change from outside may not add a record that claims one.
 */
export const PLATFORM_AGENTS = ["customization-agent", "seed-customization", "merge-agent", "onboarding", "repair-agent", "yellow-rollback", "harvester", OUTSIDE_AGENT];

const INTENT_FILE = /^\.intent\/([A-Za-z0-9._-]+)\.json$/;

/**
 * Sources whose branch may lack an intent record: an import from the inbox,
 * the queue event of a push nobody on the platform made, and the owner's
 * direct trigger. Re-gates of a merge, check mode, and pushes made by
 * platform workflows are skipped.
 */
export function needsIntentCheck(p: Pick<GateParams, "branch" | "mode" | "regateOf">, source: GateParams["source"]): boolean {
	if (p.mode !== "merge" || p.regateOf) return false;
	if (p.branch.startsWith("repair/") || p.branch.startsWith("upgrade/")) return false;
	return source === "event" || source === "direct" || source === "import";
}

/** Ids of intent records the branch adds that pass the record schema (parseIntentRecord). */
export function addedIntentIds(changes: FileChange[], contents: Record<string, string | null>): string[] {
	const ids: string[] = [];
	for (const change of changes) {
		if (change.status !== "added" || !INTENT_FILE.test(change.path)) continue;
		const record = parseIntentRecord(change.path, contents[change.path] ?? "");
		if (record) ids.push(record.id);
	}
	return ids;
}

function modesOf(paths: string[]): string[] {
	const modes = new Set<string>();
	for (const path of paths) {
		if (/^policies\/clinical/.test(path)) modes.add("clinical");
		if (/^policies\/research/.test(path)) modes.add("research");
		if (/^policies\/admin/.test(path)) modes.add("administrative");
	}
	return ["clinical", "research", "administrative"].filter((m) => modes.has(m));
}

export function draftOutsideIntent(input: { id: string; userId: string; branch: string; stockTag: string; commits: { oid: string; message: string }[]; changes: FileChange[] }): BuildTimeIntent {
	const subjects = input.commits.slice(0, MAX_COMMITS_LISTED).map((c) => cleanText(c.message.split("\n")[0] ?? "", 200)).filter(Boolean);
	const paths = [...new Set(input.changes.map((c) => c.path))].sort();
	return {
		id: input.id,
		author: "outside agent",
		agent: OUTSIDE_AGENT,
		source: OUTSIDE_SOURCE,
		pushed_by: `user:${input.userId}`,
		branch: input.branch,
		request: cleanText(subjects.join("; ") || "Pushed with no commit message", MAX_REQUEST_CHARS),
		purpose: `Pushed to ${input.branch} from outside the platform; this record was drafted by the gate from the commit messages and the files touched. Records are append-only: to say why, add your own .intent record in a later push.`,
		modes_affected: modesOf(paths),
		files: [...paths.slice(0, MAX_DRAFT_FILES), intentPath(input.id)].sort(),
		files_total: paths.length,
		tests_added: paths.filter((p) => p.startsWith("tests/user/")).slice(0, MAX_DRAFT_FILES),
		stock_tag: input.stockTag,
		commits: input.commits.slice(0, MAX_COMMITS_LISTED).map((c) => c.oid.slice(0, 7)),
		created_at: new Date().toISOString(),
	};
}

/** Commit message of the drafted record, with its Intent-Id trailer. */
export function draftMessage(intentId: string, branch: string, commitCount: number): string {
	return withIntentTrailer(`Draft the intent record for an outside push\n\n${branch} reached the gate with ${commitCount} commit${commitCount === 1 ? "" : "s"} and no build-time intent record. The gate drafted one from the commit messages and the files touched, so the change is traceable before it can reach main.`, intentId);
}

export type ChangeInspection =
	| { status: "gone"; head: string }
	| { status: "reuse"; head: string; intentId: string }
	| { status: "ok"; moved: boolean; head: string; base: string | null; changes: FileChange[]; addedIds: string[]; appendOnly: string[]; platformClaims: string[]; floor: string[] };

/**
 * Looks at a gated commit in a working copy that has main and
 * refs/remotes/origin/<branch>: what it changed since it left main, which
 * valid intent records it adds, which existing records it modifies or
 * deletes, and which floor files the real diff touches. `moved` says the
 * branch head is no longer the gated commit. When that head is this gate's
 * own drafted commit on top of the gated one, the result is "reuse" (a
 * retried step); when the gated commit is no longer in the branch, "gone".
 */
export async function inspectChange(ws: Workspace, input: { branch: string; commit: string }): Promise<ChangeInspection> {
	const head = await headCommit(ws, `refs/remotes/origin/${input.branch}`);
	if (head !== input.commit) {
		const message = await readCommitMessage(ws, head);
		const own = parseTrailers(message)["Intent-Id"];
		if (own && message.startsWith("Draft the intent record") && (await firstParent(ws, head)) === input.commit) return { status: "reuse", head, intentId: own };
		const contained = await git.isDescendent({ fs: ws.fs, dir: ws.dir, oid: head, ancestor: input.commit, depth: 1000 }).catch(() => false);
		if (!contained) return { status: "gone", head };
	}
	const base = await mergeBase(ws, await headCommit(ws, "main"), input.commit);
	const changes = await changedFiles(ws, base, input.commit);
	const contents: Record<string, string | null> = {};
	for (const c of changes) if (c.status === "added" && INTENT_FILE.test(c.path)) contents[c.path] = await blobText(ws, input.commit, c.path);
	return {
		status: "ok",
		moved: head !== input.commit,
		head,
		base,
		changes,
		addedIds: addedIntentIds(changes, contents),
		appendOnly: changes.filter((c) => c.path.startsWith(".intent/") && c.status !== "added").map((c) => `${c.path} (${c.status})`),
		platformClaims: Object.entries(contents).flatMap(([path, text]) => {
			const agent = parseIntentRecord(path, text ?? "")?.agent;
			return agent && PLATFORM_AGENTS.includes(agent) ? [`${path} (agent ${agent})`] : [];
		}),
		floor: changes.map((c) => c.path).filter((p) => FLOOR_FILES.test(p)),
	};
}

export type ChangeDecision =
	| { action: "gone"; detail: string }
	| { action: "reuse"; commit: string; intentId: string }
	| { action: "fail"; appendOnly: string[]; platformClaims: string[] }
	| { action: "ok" }
	| { action: "draft" };

/**
 * What the gate does with an inspected change. `draft` is set for changes
 * from outside the platform. A changed or deleted record fails for every
 * source; a record claiming a platform agent fails an outside change (and is
 * never drafted around); a record is drafted only when an outside change adds
 * no valid record at all.
 */
export function decideChange(seen: ChangeInspection, draft: boolean): ChangeDecision {
	if (seen.status === "reuse") return { action: "reuse", commit: seen.head, intentId: seen.intentId };
	if (seen.status === "gone" || (draft && seen.moved)) return { action: "gone", detail: `the branch moved on to ${seen.head.slice(0, 7)}; the gate for that push decides` };
	const claims = draft ? seen.platformClaims : [];
	if (seen.appendOnly.length || claims.length) return { action: "fail", appendOnly: seen.appendOnly, platformClaims: claims };
	if (!draft || seen.addedIds.length > 0 || seen.changes.length === 0) return { action: "ok" };
	return { action: "draft" };
}

/** Commits a drafted record onto the branch, on top of the gated commit. The caller pushes and gates it. */
export async function applyDraft(ws: Workspace, input: { branch: string; commit: string; base: string | null; changes: FileChange[]; intentId: string; userId: string }): Promise<{ commit: string; intent: BuildTimeIntent; commits: number }> {
	await checkoutBranch(ws, input.branch);
	const commits = await commitsBetween(ws, input.base, input.commit);
	const intent = draftOutsideIntent({ id: input.intentId, userId: input.userId, branch: input.branch, stockTag: pinnedTagOf(await readWorkspaceFile(ws, "fluid.toml")) ?? "unknown", commits, changes: input.changes });
	await writeFiles(ws, { [intentPath(input.intentId)]: intentJson(intent) });
	const commit = await commitChanges(ws, { message: draftMessage(input.intentId, input.branch, commits.length) });
	return { commit, intent, commits: commits.length };
}

async function blobText(ws: Workspace, commit: string, path: string): Promise<string | null> {
	try {
		return new TextDecoder().decode((await git.readBlob({ fs: ws.fs, dir: ws.dir, oid: commit, filepath: path })).blob);
	} catch {
		return null;
	}
}

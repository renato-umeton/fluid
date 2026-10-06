// Intent records for pushes made from outside the platform (an owner's own
// agent or editor, with a token from POST /api/forks/:repo/token). Every
// change that reaches main carries a build-time record, so when a pushed
// branch adds none, the gate drafts one from the commit messages and the
// files touched, commits it onto the branch, and gates that commit instead.
// Pushes that already add a valid .intent/<id>.json are gated as they are.
import type { BuildTimeIntent } from "../forks/provision.ts";
import { withIntentTrailer, type FileChange } from "../git/ops.ts";
import type { GateParams } from "../workflows/common.ts";
import { cleanText, intentPath, MAX_REQUEST_CHARS } from "./intent.ts";

export const OUTSIDE_AGENT = "outside-agent";
export const OUTSIDE_SOURCE = "outside-push";
const MAX_COMMITS_LISTED = 20;

const INTENT_FILE = /^\.intent\/([A-Za-z0-9._-]+)\.json$/;

/**
 * Sources whose push may lack an intent record: an import from the inbox, the queue event of a push
 * nobody on the platform made, and the owner's direct trigger. Re-gates of a
 * merge, check mode, and pushes made by platform workflows are skipped.
 */
export function needsIntentCheck(p: Pick<GateParams, "branch" | "mode" | "regateOf">, source: GateParams["source"]): boolean {
	if (p.mode !== "merge" || p.regateOf) return false;
	if (p.branch.startsWith("repair/") || p.branch.startsWith("upgrade/")) return false;
	return source === "event" || source === "direct" || source === "import";
}

/** Ids of intent records the branch adds that parse and name their own file. */
export function addedIntentIds(changes: FileChange[], contents: Record<string, string | null>): string[] {
	const ids: string[] = [];
	for (const change of changes) {
		const match = INTENT_FILE.exec(change.path);
		if (!match || change.status !== "added") continue;
		try {
			const record = JSON.parse(contents[change.path] ?? "") as { id?: unknown };
			if (record && typeof record === "object" && record.id === match[1]) ids.push(match[1]!);
		} catch {
			// Not a record: the gate drafts one.
		}
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
	const paths = input.changes.map((c) => c.path);
	return {
		id: input.id,
		author: "outside agent",
		agent: OUTSIDE_AGENT,
		source: OUTSIDE_SOURCE,
		pushed_by: `user:${input.userId}`,
		branch: input.branch,
		request: cleanText(subjects.join("; ") || "Pushed with no commit message", MAX_REQUEST_CHARS),
		purpose: `Pushed to ${input.branch} from outside the platform; this record was drafted by the gate from the commit messages and the files touched. Edit it to say why the change exists.`,
		modes_affected: modesOf(paths),
		files: [...new Set([...paths, intentPath(input.id)])].sort(),
		tests_added: paths.filter((p) => p.startsWith("tests/user/")).sort(),
		stock_tag: input.stockTag,
		commits: input.commits.slice(0, MAX_COMMITS_LISTED).map((c) => c.oid.slice(0, 7)),
		created_at: new Date().toISOString(),
	};
}

/** Commit message of the drafted record, with its Intent-Id trailer. */
export function draftMessage(intentId: string, branch: string, commitCount: number): string {
	return withIntentTrailer(`Draft the intent record for an outside push\n\n${branch} reached the gate with ${commitCount} commit${commitCount === 1 ? "" : "s"} and no build-time intent record. The gate drafted one from the commit messages and the files touched, so the change is traceable before it can reach main.`, intentId);
}

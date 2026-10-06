// Artifacts push events (account-level repo.pushed subscription delivered to
// the fluid-events queue) and which of them start a gate. The subscription is
// account-wide, so everything outside namespace "fluid" and outside user
// forks is dropped. Pushes to main come from the gate itself (merge on pass);
// tag pushes are releases; upgrade branches are gated by their own Upgrade
// workflow; repair branches are checked by the Repair workflow and merged
// only through the apply route; a deleted branch has nothing to gate.
// Pushes to an inbox repo (inbox-<fork>, written by the owner's own agent)
// are never gated there: only new heads of work/* branches are imported into
// the fork (forks/inbox.ts); main, tags, other refs, and deletions are ignored.
import { forkOfInbox, INBOX_PREFIX } from "../forks/outside.ts";

export const PUSH_EVENT_TYPE = "cf.artifacts.repo.pushed";
export const FLUID_NAMESPACE = "fluid";
export const FORK_PREFIX = "user-";
export const PRODUCTION_BRANCH = "main";
const ZERO_SHA = /^0{40}$/;

export interface GateTrigger {
	repo: string;
	branch: string;
	commit: string;
	/** "merge": merge to main on pass (work branches). "check": report only (repair branches). */
	mode: "merge" | "check";
}

/** A new head of a work branch in an inbox, to copy into the fork. */
export interface InboxImport {
	inbox: string;
	fork: string;
	branch: string;
	commit: string;
}

export type FilterResult = { gate: true; trigger: GateTrigger } | { gate: false; reason: string; import?: InboxImport };

const MAX_IMPORT_BRANCH = 100;
const BRANCH_PART = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** work/<name>, with plain path parts only (no "..", hidden parts, or ".lock"), at most 100 characters. */
export function isImportableBranch(branch: string): boolean {
	if (branch.length > MAX_IMPORT_BRANCH || !branch.startsWith("work/")) return false;
	const parts = branch.slice("work/".length).split("/");
	return parts.every((part) => BRANCH_PART.test(part) && !part.endsWith(".lock") && !part.includes(".."));
}

function filterInboxEvent(inbox: string, ref: unknown, after: unknown): FilterResult {
	const fork = forkOfInbox(inbox);
	if (!fork) return { gate: false, reason: `inbox ${inbox} does not belong to a user fork` };
	if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) return { gate: false, reason: `inbox ref ${String(ref)} is not a branch; only work/* branches are imported` };
	const branch = ref.slice("refs/heads/".length);
	if (!isImportableBranch(branch)) return { gate: false, reason: `inbox branch ${branch} is not imported; only work/* branches are` };
	if (typeof after !== "string" || !/^[0-9a-f]{40}$/.test(after)) return { gate: false, reason: "no commit" };
	if (ZERO_SHA.test(after)) return { gate: false, reason: "inbox branch deleted; nothing in the fork is deleted" };
	return { gate: false, reason: "inbox work branch: import into the fork", import: { inbox, fork, branch, commit: after } };
}

export function filterPushEvent(body: unknown): FilterResult {
	const event = body as {
		type?: unknown;
		source?: { namespace?: unknown; repoName?: unknown };
		payload?: { ref?: unknown; after?: unknown };
	} | null;
	if (!event || typeof event !== "object") return { gate: false, reason: "not an object" };
	if (event.type !== PUSH_EVENT_TYPE) return { gate: false, reason: `event type ${String(event.type)}` };
	if (event.source?.namespace !== FLUID_NAMESPACE) return { gate: false, reason: `namespace ${String(event.source?.namespace)}` };
	const repo = event.source?.repoName;
	if (typeof repo === "string" && repo.startsWith(INBOX_PREFIX)) return filterInboxEvent(repo, event.payload?.ref, event.payload?.after);
	if (typeof repo !== "string" || !repo.startsWith(FORK_PREFIX)) return { gate: false, reason: `repo ${String(repo)} is not a user fork` };
	const ref = event.payload?.ref;
	const after = event.payload?.after;
	if (typeof ref !== "string") return { gate: false, reason: "no ref" };
	if (ref.startsWith("refs/tags/")) return { gate: false, reason: "tag push" };
	if (!ref.startsWith("refs/heads/")) return { gate: false, reason: `unsupported ref ${ref}` };
	const branch = ref.slice("refs/heads/".length);
	if (branch === PRODUCTION_BRANCH) return { gate: false, reason: "push to the production branch (made by the gate)" };
	if (branch.startsWith("upgrade/")) return { gate: false, reason: "upgrade branches are gated by their Upgrade workflow" };
	if (branch.startsWith("repair/")) return { gate: false, reason: "repair branches are gated by the repair workflow; applying one is an explicit request" };
	if (typeof after !== "string" || !/^[0-9a-f]{40}$/.test(after)) return { gate: false, reason: "no commit" };
	if (ZERO_SHA.test(after)) return { gate: false, reason: "branch deleted" };
	return { gate: true, trigger: { repo, branch, commit: after, mode: gateModeFor(branch) } };
}

/** Repair branches are never merged automatically; everything else that reaches the gate merges on pass. */
export function gateModeFor(branch: string): "merge" | "check" {
	return branch.startsWith("repair/") || branch.startsWith("harvest/") ? "check" : "merge";
}

/**
 * Workflow instance id for a gate run: one per (repo, branch, commit), so the
 * queue consumer and a direct trigger for the same push start one gate.
 * Ids allow letters, digits, "-" and "_", at most 64 characters.
 */
export function gateInstanceId(repo: string, branch: string, commit: string): string {
	return `gate-${commit.slice(0, 16)}-${fnv1a(`${repo}\n${branch}`)}`;
}

export function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

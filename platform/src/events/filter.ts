// Artifacts push events (account-level repo.pushed subscription delivered to
// the fluid-events queue) and which of them start a gate. The subscription is
// account-wide, so everything outside namespace "fluid" and outside user
// forks is dropped. Pushes to main are never gated: the platform makes them
// after a gate, and the main guard (forks/main-guard.ts) undoes any it did
// not make. Tag pushes are releases; upgrade branches are gated by their own
// Upgrade workflow; repair branches are checked by the Repair workflow and
// merged only through the apply route; a deleted branch has nothing to gate.

export const PUSH_EVENT_TYPE = "cf.artifacts.repo.pushed";
export const FLUID_NAMESPACE = "fluid";
export const FORK_PREFIX = "user-";
export const PRODUCTION_BRANCH = "main";
const ZERO_SHA = /^0{40}$/;
const SHA = /^[0-9a-f]{40}$/;

export interface GateTrigger {
	repo: string;
	branch: string;
	commit: string;
	/** "merge": merge to main on pass (work branches). "check": report only (repair branches). */
	mode: "merge" | "check";
}

/** A push to main of a user fork, for the main guard to check. */
export interface MainPush {
	repo: string;
	before: string;
	after: string;
}

export type FilterResult = { gate: true; trigger: GateTrigger } | { gate: false; reason: string; guard?: MainPush };

export function filterPushEvent(body: unknown): FilterResult {
	const event = body as {
		type?: unknown;
		source?: { namespace?: unknown; repoName?: unknown };
		payload?: { ref?: unknown; before?: unknown; after?: unknown };
	} | null;
	if (!event || typeof event !== "object") return { gate: false, reason: "not an object" };
	if (event.type !== PUSH_EVENT_TYPE) return { gate: false, reason: `event type ${String(event.type)}` };
	if (event.source?.namespace !== FLUID_NAMESPACE) return { gate: false, reason: `namespace ${String(event.source?.namespace)}` };
	const repo = event.source?.repoName;
	if (typeof repo !== "string" || !repo.startsWith(FORK_PREFIX)) return { gate: false, reason: `repo ${String(repo)} is not a user fork` };
	const ref = event.payload?.ref;
	const after = event.payload?.after;
	if (typeof ref !== "string") return { gate: false, reason: "no ref" };
	if (ref.startsWith("refs/tags/")) return { gate: false, reason: "tag push" };
	if (!ref.startsWith("refs/heads/")) return { gate: false, reason: `unsupported ref ${ref}` };
	const branch = ref.slice("refs/heads/".length);
	if (branch === PRODUCTION_BRANCH) {
		const before = event.payload?.before;
		const reason = "push to the production branch (made by the gate, or undone by the main guard)";
		if (typeof before !== "string" || !SHA.test(before) || typeof after !== "string" || !SHA.test(after)) return { gate: false, reason };
		return { gate: false, reason, guard: { repo, before, after } };
	}
	if (branch.startsWith("upgrade/")) return { gate: false, reason: "upgrade branches are gated by their Upgrade workflow" };
	if (branch.startsWith("repair/")) return { gate: false, reason: "repair branches are gated by the repair workflow; applying one is an explicit request" };
	if (typeof after !== "string" || !SHA.test(after)) return { gate: false, reason: "no commit" };
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

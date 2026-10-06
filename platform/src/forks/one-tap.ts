// One-tap approval of a gated upgrade (auto_upgrade off). The upgrade
// recorded which branch it gated: upgrade/<tag> on the merge path or
// replay/<tag> after intent replay. Rows written before the branch was
// recorded mean upgrade/<tag>.
import { fastForward, headCommit, type Workspace } from "../git/ops.ts";

export function pendingBranch(pending: { tag: string; branch?: string | null }): string {
	return pending.branch || `upgrade/${pending.tag}`;
}

/**
 * Fetches the pending upgrade's branch into a clone of main and moves main
 * to the gated commit only by fast-forward. "diverged" means main moved
 * since the upgrade was gated; nothing changes then.
 */
export async function fastForwardToPending(
	ws: Workspace,
	pending: { tag: string; commit: string; branch?: string | null },
	fetch: (branch: string) => Promise<void>,
): Promise<{ branch: string; previous: string; outcome: "fast-forward" | "already" | "diverged"; oid: string }> {
	const branch = pendingBranch(pending);
	await fetch(branch);
	const previous = await headCommit(ws, "main");
	const ff = await fastForward(ws, "main", pending.commit);
	return { branch, previous, outcome: ff.outcome, oid: ff.oid };
}

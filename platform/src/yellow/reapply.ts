// Re-running a release for a fork whose upgrade to that tag was rolled back.
// The stock tag is already in main's history (the rollback reverted the
// upgrade's tree with a new commit and kept history), so merging the tag
// again changes nothing. Instead the upgrade's own changes, from the revert
// commit's tree to the rolled back upgrade commit's tree, are applied again
// on top of main. Files the fork changed after the rollback keep main's
// version, and no intent record is ever deleted. The gate then decides.
import git, { Errors } from "isomorphic-git";
import { readWorkspaceFile, removeFiles, writeFiles, type Workspace } from "../git/ops.ts";
import { pinnedTagOf } from "../stock/releases.ts";
import { ROLLBACK_AUTHOR } from "./rollback.ts";

/** How far back main's history is searched for the rollback. */
const SEARCH_DEPTH = 50;

/** The yellow soak's revert of an earlier upgrade to `tag` on `ref`, newest first, or null. */
export async function findRolledBackUpgrade(ws: Workspace, ref: string, tag: string): Promise<{ revert: string; yellow: string } | null> {
	const commits = await git.log({ fs: ws.fs, dir: ws.dir, ref, depth: SEARCH_DEPTH });
	for (const entry of commits) {
		if (entry.commit.author.email !== ROLLBACK_AUTHOR.email) continue;
		const yellow = entry.commit.parent[0];
		if (!yellow) continue;
		if (pinnedTagOf(await blobText(ws, yellow, "fluid.toml")) === tag) return { revert: entry.oid, yellow };
	}
	return null;
}

/**
 * Applies the change between two commits (`from` to `to`) to the working
 * tree of the checked out branch and stages it. A path is applied only when
 * the working tree still has `from`'s version; otherwise main's version is
 * kept and the path is listed in `kept`.
 */
export async function reapplyChange(ws: Workspace, input: { from: string; to: string }): Promise<{ applied: string[]; kept: string[] }> {
	const [fromFiles, toFiles] = await Promise.all([git.listFiles({ fs: ws.fs, dir: ws.dir, ref: input.from }), git.listFiles({ fs: ws.fs, dir: ws.dir, ref: input.to })]);
	const applied: string[] = [];
	const kept: string[] = [];
	for (const path of [...new Set([...fromFiles, ...toFiles])].sort()) {
		const [before, after] = await Promise.all([blobText(ws, input.from, path), blobText(ws, input.to, path)]);
		if (before === after) continue;
		if (after === null && path.startsWith(".intent/")) continue;
		if ((await readWorkspaceFile(ws, path)) !== before) {
			kept.push(path);
			continue;
		}
		if (after === null) await removeFiles(ws, [path]);
		else await writeFiles(ws, { [path]: after });
		applied.push(path);
	}
	return { applied, kept };
}

async function blobText(ws: Workspace, commit: string, path: string): Promise<string | null> {
	try {
		const { blob } = await git.readBlob({ fs: ws.fs, dir: ws.dir, oid: commit, filepath: path });
		return new TextDecoder().decode(blob);
	} catch (error) {
		if (error instanceof Errors.NotFoundError) return null;
		throw error;
	}
}

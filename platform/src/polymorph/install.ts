// The platform's side of installing a polymorphic copy of a fork. Upstream's
// list of names comes from the stock repo at the fork's pinned tag, the same
// way the gate reads the probes, so a fork cannot shrink it.
import { STOCK_REPO } from "../lib/names.ts";
import { openRepo, readTextFile } from "../runtime/repo-files.ts";
import { resolveStockTag } from "../stock/suite.ts";
import { POLYMORPH_LIST_PATH, parsePolymorphList } from "./list.ts";

/** Each stock commit's list, or null when it publishes none. A release tag never moves, so neither does its list. */
const lists = new Map<string, readonly string[] | null>();
const LIST_CACHE_LIMIT = 20;

/**
 * Upstream's polymorph list at a stock release tag: the names a copy of a
 * fork pinned to that tag may rename. Read from stock at the tag's commit,
 * cached by commit, and null when that release publishes no list. Throws
 * StockTagError for a tag that is not a published release, and an Error
 * naming the release for a list that does not parse.
 */
export async function loadPolymorphList(env: Env, tag: string): Promise<string[] | null> {
	const sha = await resolveStockTag(env, tag);
	let list = lists.get(sha);
	if (list === undefined) {
		list = await readList(env, sha, tag);
		if (lists.size >= LIST_CACHE_LIMIT) lists.delete(lists.keys().next().value!);
		lists.set(sha, list);
	}
	return list === null ? null : [...list];
}

async function readList(env: Env, sha: string, tag: string): Promise<readonly string[] | null> {
	using repo = await openRepo(env.ARTIFACTS, STOCK_REPO);
	const text = await readTextFile(repo, sha, POLYMORPH_LIST_PATH);
	if (text === null) return null;
	try {
		return parsePolymorphList(text);
	} catch (error) {
		throw new Error(`stock ${tag}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

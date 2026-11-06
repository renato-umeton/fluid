// The platform's side of installing a polymorphic copy of a fork. Upstream's
// list of names comes from the stock repo at the fork's pinned tag, the same
// way the gate reads the probes, so a fork cannot shrink it. The seed comes
// from the platform secret. Any reason a copy cannot be made is thrown, and
// the loader then runs the plain fork.
import { STOCK_REPO, USER_E2E_PATH, USER_MANIFEST_PATH } from "../lib/names.ts";
import type { ModuleMap } from "../runtime/modules.ts";
import { openRepo, readTextFile } from "../runtime/repo-files.ts";
import { pinnedTagOf } from "../stock/releases.ts";
import { resolveStockTag } from "../stock/suite.ts";
import { POLYMORPH_LIST_PATH, parsePolymorphList, type ContractTexts, type SkippedName } from "./list.ts";
import { morphFork, unmorphText } from "./morph.ts";
import { deriveSeed, fingerprint, namesHash, variantNames } from "./names.ts";
import { PolymorphUnavailableError } from "./tokens.ts";

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
		throw new Error(`stock ${tag}: ${messageOf(error)}`);
	}
}

/**
 * The platform secret that seeds every copy, or null when it is not set. It
 * is read by name rather than declared as a binding, because a declared
 * secret is required at deploy: a platform without one runs every fork plain,
 * exactly as before.
 */
export function polymorphSecret(env: Env): string | null {
	const secret = (env as unknown as { POLYMORPH_SECRET?: unknown }).POLYMORPH_SECRET;
	return typeof secret === "string" && secret !== "" ? secret : null;
}

/** What names one copy, worked out before the copy is built: enough for its isolate id and build cache key. */
export interface CopyPlan {
	epoch: number;
	seed: string;
	/** Eight hex characters naming the copy; safe to show. */
	fingerprint: string;
	/** Upstream's list at the fork's pinned tag. */
	list: string[];
}

/**
 * Plans the copy of one fork commit for one epoch. Throws, saying why, when
 * there is no secret, fluid.toml pins no stock tag, or the pinned release
 * publishes no list or a broken one.
 */
export async function planCopy(env: Env, input: { repo: string; sha: string; epoch: number; fluidToml: string | undefined }): Promise<CopyPlan> {
	const secret = polymorphSecret(env);
	if (secret === null) throw new PolymorphUnavailableError("POLYMORPH_SECRET is not set");
	const tag = pinnedTagOf(input.fluidToml);
	if (tag === null) throw new PolymorphUnavailableError("fluid.toml names no stock_tag");
	const list = await loadPolymorphList(env, tag);
	if (list === null) throw new PolymorphUnavailableError(`stock ${tag} publishes no ${POLYMORPH_LIST_PATH}`);
	const seed = await deriveSeed(secret, input.repo, input.sha, input.epoch);
	return { epoch: input.epoch, seed, fingerprint: await fingerprint(seed), list };
}

/** The fork's own tests: the requests it sends itself. Read with fluid.toml as its contract. */
const CONTRACT_FILES = [USER_MANIFEST_PATH, USER_E2E_PATH] as const;

/**
 * The fork's contract texts at a commit, by path: its tier 3 tests and its
 * end-to-end scenarios when it has them, and its fluid.toml. A copy skips the
 * listed names these use, since the fork's code reads them as data.
 */
export async function readContract(env: Env, repo: string, sha: string, fluidToml: string | undefined): Promise<ContractTexts> {
	using handle = await openRepo(env.ARTIFACTS, repo);
	const texts = await Promise.all(CONTRACT_FILES.map((path) => readTextFile(handle, sha, path)));
	const contract: Record<string, string> = {};
	CONTRACT_FILES.forEach((path, i) => {
		const text = texts[i];
		if (typeof text === "string") contract[path] = text;
	});
	if (fluidToml !== undefined) contract["fluid.toml"] = fluidToml;
	return contract;
}

/** A built copy: its module map and what it renamed. */
export interface BuiltCopy {
	map: ModuleMap;
	/** The names this copy renamed, original to renamed: its secret. */
	names: Map<string, string>;
	skipped: SkippedName[];
	namesHash: string;
}

/**
 * Renames what the plan's list allows in the plain module map, skipping the
 * names the fork's modules and contract use. Every error comes out as
 * PolymorphUnavailableError with this copy's names mapped back to the
 * originals, so a log line never shows one.
 */
export async function buildCopy(plan: CopyPlan, map: ModuleMap, contract: ContractTexts): Promise<BuiltCopy> {
	const variants = await variantNames(plan.seed, plan.list);
	try {
		const { map: renamed, usable, skipped } = morphFork(map, variants, contract);
		return { map: renamed, names: usable, skipped, namesHash: await namesHash(usable.keys()) };
	} catch (error) {
		throw new PolymorphUnavailableError(unmorphText(messageOf(error), variants));
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

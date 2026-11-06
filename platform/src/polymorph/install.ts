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

/** Shorter secrets are too easy to guess; deriveSeed refuses them too. */
const MIN_SECRET_CHARS = 16;
let reportedShortSecret = false;

/**
 * The platform secret that seeds every copy, or null when it is not set. It
 * is read by name rather than declared as a binding, because a declared
 * secret is required at deploy: a platform without one runs every fork plain,
 * exactly as before. A secret shorter than 16 characters counts as not set,
 * and the first read says so once per isolate (never the secret itself).
 */
export function polymorphSecret(env: Env): string | null {
	const secret = (env as unknown as { POLYMORPH_SECRET?: unknown }).POLYMORPH_SECRET;
	if (typeof secret !== "string" || secret === "") return null;
	if (secret.length >= MIN_SECRET_CHARS) return secret;
	if (!reportedShortSecret) {
		reportedShortSecret = true;
		console.warn(`polymorph: POLYMORPH_SECRET is shorter than ${MIN_SECRET_CHARS} characters, so it counts as not set and every fork runs plain`);
	}
	return null;
}

/** What names one copy, worked out before the copy is built: enough for its isolate id and build cache key. */
export interface CopyPlan {
	readonly epoch: number;
	readonly seed: string;
	/** Eight hex characters naming the copy; safe to show. */
	readonly fingerprint: string;
	/** Upstream's list at the fork's pinned tag. */
	readonly list: readonly string[];
}

/**
 * Plans by repo:sha:epoch, with the secret each was made with. A plan never
 * changes under one secret: the list is upstream's at the tag that fluid.toml
 * pins at that commit. Loading a copy already planned then signs nothing.
 */
const plans = new Map<string, { secret: string; plan: CopyPlan }>();
const PLAN_CACHE_LIMIT = 500;

/**
 * Plans the copy of one fork commit for one epoch, once per secret. Throws,
 * saying why, when there is no secret, fluid.toml pins no stock tag, or the
 * pinned release publishes no list or a broken one.
 */
export async function planCopy(env: Env, input: { repo: string; sha: string; epoch: number; fluidToml: string | undefined }): Promise<CopyPlan> {
	const secret = polymorphSecret(env);
	if (secret === null) throw new PolymorphUnavailableError("POLYMORPH_SECRET is not set");
	const key = `${input.repo}:${input.sha}:${input.epoch}`;
	const cached = plans.get(key);
	// Another secret seeds another copy: a plan made with the old one must never stand in for it.
	if (cached !== undefined && cached.secret === secret) return cached.plan;
	const tag = pinnedTagOf(input.fluidToml);
	if (tag === null) throw new PolymorphUnavailableError("fluid.toml names no stock_tag");
	const list = await loadPolymorphList(env, tag);
	if (list === null) throw new PolymorphUnavailableError(`stock ${tag} publishes no ${POLYMORPH_LIST_PATH}`);
	const seed = await deriveSeed(secret, input.repo, input.sha, input.epoch);
	const plan: CopyPlan = { epoch: input.epoch, seed, fingerprint: await fingerprint(seed), list };
	if (plans.size >= PLAN_CACHE_LIMIT) plans.delete(plans.keys().next().value!);
	plans.set(key, { secret, plan });
	return plan;
}

/** Drops the plans and upstream lists this isolate keeps, as a new isolate starts (clearRuntimeCache). */
export function clearCopyCaches(): void {
	plans.clear();
	lists.clear();
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

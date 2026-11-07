// The platform's side of installing a polymorphic copy of a fork. Upstream's
// list of names comes from the stock repo at the fork's pinned tag, the same
// way the gate reads the probes, so a fork cannot shrink it. The seed comes
// from the platform secret. Any reason a copy cannot be made is thrown, and
// the loader then runs the plain fork. The error says which kind of reason it
// is: PolymorphOffError (no copy is made for this fork at all),
// PolymorphTransientError (a read failed and may work next time), or
// anything else (no copy can be made of this code or this list).
import { StockTagError } from "../gate/pins.ts";
import { STOCK_REPO, USER_E2E_PATH, USER_MANIFEST_PATH } from "../lib/names.ts";
import type { ModuleMap } from "../runtime/modules.ts";
import { openRepo, readTextFile } from "../runtime/repo-files.ts";
import { pinnedTagOf } from "../stock/releases.ts";
import { resolveStockTag } from "../stock/suite.ts";
import { POLYMORPH_LIST_PATH, parsePolymorphList, type ContractTexts, type SkippedName } from "./list.ts";
import { morphFork, unmorphText } from "./morph.ts";
import { deriveSeed, fingerprint, namesHash, variantNames } from "./names.ts";
import { PolymorphUnavailableError } from "./tokens.ts";

/**
 * The platform makes no copy of this fork: it has no secret, or the release
 * the fork pins names no list (fluid.toml names no tag, or that release
 * publishes none). The fork runs plain, as every fork did before copies.
 */
export class PolymorphOffError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PolymorphOffError";
	}
}

/**
 * A read that a copy needs failed: Artifacts erred while the platform read
 * upstream's list or the fork's contract. Nothing is known to be wrong with
 * the fork or the list, and the same load may make the copy a moment later.
 * The message is the failed read's own.
 */
export class PolymorphTransientError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "PolymorphTransientError";
	}
}

/** Each stock commit's list, or null when it publishes none. A release tag never moves, so neither does its list. */
const lists = new Map<string, readonly string[] | null>();
const LIST_CACHE_LIMIT = 20;

/**
 * Upstream's polymorph list at a stock release tag: the names a copy of a
 * fork pinned to that tag may rename. Read from stock at the tag's commit,
 * cached by commit, and null when that release publishes no list. Throws
 * StockTagError for a tag that is not a published release,
 * PolymorphUnavailableError naming the release for a list that does not
 * parse, and PolymorphTransientError when reading stock failed.
 */
export async function loadPolymorphList(env: Env, tag: string): Promise<string[] | null> {
	const sha = await transient(() => resolveStockTag(env, tag), (error) => error instanceof StockTagError);
	let list = lists.get(sha);
	if (list === undefined) {
		list = await readList(env, sha, tag);
		if (lists.size >= LIST_CACHE_LIMIT) lists.delete(lists.keys().next().value!);
		lists.set(sha, list);
	}
	return list === null ? null : [...list];
}

async function readList(env: Env, sha: string, tag: string): Promise<readonly string[] | null> {
	const text = await transient(async () => {
		using repo = await openRepo(env.ARTIFACTS, STOCK_REPO);
		return readTextFile(repo, sha, POLYMORPH_LIST_PATH);
	});
	if (text === null) return null;
	try {
		return parsePolymorphList(text);
	} catch (error) {
		throw new PolymorphUnavailableError(`stock ${tag}: ${messageOf(error)}`);
	}
}

/**
 * Runs a read, turning its failure into PolymorphTransientError, except a
 * failure `keep` says is the answer itself (a tag that is not a release).
 */
async function transient<T>(read: () => Promise<T>, keep: (error: unknown) => boolean = () => false): Promise<T> {
	try {
		return await read();
	} catch (error) {
		if (keep(error)) throw error;
		throw new PolymorphTransientError(messageOf(error), { cause: error });
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
 * saying why: PolymorphOffError when there is no secret, fluid.toml pins no
 * stock tag, or the pinned release publishes no list; what loadPolymorphList
 * throws for a pin or list that is broken or could not be read.
 */
export async function planCopy(env: Env, input: { repo: string; sha: string; epoch: number; fluidToml: string | undefined }): Promise<CopyPlan> {
	const secret = polymorphSecret(env);
	if (secret === null) throw new PolymorphOffError("POLYMORPH_SECRET is not set");
	const key = `${input.repo}:${input.sha}:${input.epoch}`;
	const cached = plans.get(key);
	// Another secret seeds another copy: a plan made with the old one must never stand in for it.
	if (cached !== undefined && cached.secret === secret) return cached.plan;
	const tag = pinnedTagOf(input.fluidToml);
	if (tag === null) throw new PolymorphOffError("fluid.toml names no stock_tag");
	const list = await loadPolymorphList(env, tag);
	if (list === null) throw new PolymorphOffError(`stock ${tag} publishes no ${POLYMORPH_LIST_PATH}`);
	const seed = await deriveSeed(secret, input.repo, input.sha, input.epoch);
	const plan: CopyPlan = { epoch: input.epoch, seed, fingerprint: await fingerprint(seed), list };
	if (plans.size >= PLAN_CACHE_LIMIT) plans.delete(plans.keys().next().value!);
	plans.set(key, { secret, plan });
	return plan;
}

/** Drops the plans and upstream lists this isolate keeps, and forgets that it reported a short secret, as a new isolate starts (clearRuntimeCache). */
export function clearCopyCaches(): void {
	plans.clear();
	lists.clear();
	reportedShortSecret = false;
}

/** The fork's own tests: the requests it sends itself. Read with fluid.toml as its contract. */
const CONTRACT_FILES = [USER_MANIFEST_PATH, USER_E2E_PATH] as const;

/**
 * The fork's contract texts at a commit, by path: its tier 3 tests and its
 * end-to-end scenarios when it has them, and its fluid.toml. A copy skips the
 * listed names these use, since the fork's code reads them as data. Throws
 * PolymorphTransientError when a read fails.
 */
export async function readContract(env: Env, repo: string, sha: string, fluidToml: string | undefined): Promise<ContractTexts> {
	const texts = await transient(async () => {
		using handle = await openRepo(env.ARTIFACTS, repo);
		return Promise.all(CONTRACT_FILES.map((path) => readTextFile(handle, sha, path)));
	});
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

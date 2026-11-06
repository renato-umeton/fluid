// Fork runtime: loads a fork's code at a ref or SHA into a Worker Loader
// isolate and calls it over RPC. The isolate has no network (globalOutbound
// null). Only the model variant of an isolate (id suffix ":llm") gets the LLM
// capability in its env; every other isolate has no route to the platform.
// Isolates are keyed by repo:sha (plus a variant), and the transformed module
// map is cached per key in this isolate. A renamed copy of a fork (see
// polymorph/) adds ":m<epoch>.<fingerprint>.<names hash>" to both, which
// names exactly the code it runs.
import synthetic from "../generated/synthetic.json";
import { buildCopy, planCopy, readContract } from "../polymorph/install.ts";
import type { SkippedName } from "../polymorph/list.ts";
import { unmorphText } from "../polymorph/morph.ts";
import { PolymorphUnavailableError } from "../polymorph/tokens.ts";
import { buildE2ERunnerModuleMap, buildModuleMap, buildRunnerModuleMap, isRuntimePath, RUNTIME_DIRS, type ModuleMap } from "./modules.ts";
import { resolveCommit, shortRef } from "./refs.ts";
import { openRepo, readCommitFiles } from "./repo-files.ts";

export const RUNTIME_COMPATIBILITY_DATE = "2026-10-01";
const MODULE_CACHE_LIMIT = 200;
/** Upper bound for one call into fork code (ask) from the platform. */
export const FORK_CALL_TIMEOUT_MS = 10_000;

/** Loopback exports of the platform Worker (ctx.exports). */
export interface PlatformExports {
	LlmHost(options: { props: { repo: string } }): unknown;
}

export interface RuntimeDeps {
	env: Env;
	exports: PlatformExports;
}

export interface AskOptions {
	/** Let the fork reword card bodies through the model (it never decides anything). */
	useModel?: boolean;
}

/** RPC surface of the generated entry module (see modules.ts entrySource). The card crosses RPC as a JSON string. */
export interface ForkEntrypoint {
	ask(request: unknown, options?: AskOptions): Promise<string>;
}

/** Largest card text accepted from a fork. */
export const MAX_CARD_CHARS = 256 * 1024;

/** The fork's own code threw while answering, or answered with something that is not a card. */
export class ForkRuntimeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ForkRuntimeError";
	}
}

/**
 * Asks a loaded fork and parses its card. The fork serializes the card
 * itself, so the platform and the gate only ever see plain JSON data: no RPC
 * stubs, getters, or toJSON methods that could answer differently on each
 * read. A renamed copy's card text and error messages have the copy's names
 * mapped back to the originals before anything else sees them, so the caller
 * gets what the plain fork would have sent and never a renamed name. It is
 * the only way the platform asks a fork, so no caller can skip the mapping.
 */
export function askLoaded(loaded: LoadedFork, request: unknown, options?: AskOptions): Promise<AnswerCardLike> {
	return askMapped(loaded.fork, request, options, loaded.morph?.names ?? null);
}

async function askMapped(fork: ForkEntrypoint, request: unknown, options: AskOptions | undefined, names: ReadonlyMap<string, string> | null): Promise<AnswerCardLike> {
	const outgoing = (text: string) => (names === null ? text : unmorphText(text, names));
	let answer: unknown;
	try {
		answer = await fork.ask(request, options);
	} catch (error) {
		throw new ForkRuntimeError(outgoing(error instanceof Error ? error.message : String(error)));
	}
	if (typeof answer !== "string") throw new ForkRuntimeError("the fork answered with something other than a JSON card");
	if (answer.length > MAX_CARD_CHARS) throw new ForkRuntimeError(`the fork's card is larger than ${MAX_CARD_CHARS} characters`);
	// Mapped before parsing, so even a parse error's quote of the text shows original names.
	const text = outgoing(answer);
	let card: unknown;
	try {
		card = JSON.parse(text);
	} catch (error) {
		throw new ForkRuntimeError(`the fork's card is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof card !== "object" || card === null || Array.isArray(card)) throw new ForkRuntimeError("the fork's card is not a JSON object");
	return card as AnswerCardLike;
}

export interface RunnerOptions {
	forkFiles?: Record<string, string>;
	samples?: number;
	tier?: string;
	timeoutMs?: number;
}

/** RPC surface of the gate runner isolate (see modules.ts runnerEntrySource). */
export interface RunnerEntrypoint {
	run(manifest: unknown, options: RunnerOptions, ask: (request: unknown) => Promise<unknown>): Promise<unknown>;
}

export interface AnswerCardLike {
	answer_id: string;
	mode: string;
	computed_dose: unknown;
	sources: { id: string; kind: string }[];
	ledger: Record<string, unknown> & { answer_id: string };
	[key: string]: unknown;
}

export interface LoadOptions {
	/** Files that replace or add to the fork's files before building (e.g. a candidate change under validation). */
	extraFiles?: Record<string, string>;
	/**
	 * Required with extraFiles: distinguishes the isolate id so cached code is
	 * never reused for different inputs. Also used alone to get a fresh isolate
	 * (the gate runs in its own variant, never in the production isolate).
	 */
	variant?: string;
	/** Give the isolate the LLM capability (a separate ":llm" isolate). */
	useModel?: boolean;
	/**
	 * Load a renamed copy for this epoch instead of the plain fork, when the
	 * platform can make one: POLYMORPH_SECRET is set, the fork's pinned stock
	 * release publishes a list, and there are no extraFiles. With onlyAt, only
	 * when the ref resolves to that commit; with namesHash, only when the copy
	 * renames exactly the names the gate verified. Otherwise the plain fork
	 * loads (morph: null) and one log line says why: this never fails a load.
	 */
	morph?: { epoch: number; onlyAt?: string; namesHash?: string };
}

/** The renamed copy a fork loaded as. */
export interface LoadedCopy {
	epoch: number;
	/** Eight hex characters naming the copy; safe to show. */
	fingerprint: string;
	/** namesHash of the names it renamed: with the fingerprint, what identifies a verified copy. */
	namesHash: string;
	/** The names it renamed, original to renamed: the copy's secret, for its tripwires and for mapping its text back. */
	names: ReadonlyMap<string, string>;
	/** Listed names it left as they are, and why. */
	skipped: readonly SkippedName[];
}

export interface LoadedFork {
	repo: string;
	ref: string;
	sha: string;
	isolateId: string;
	fluidToml: string | undefined;
	fork: ForkEntrypoint;
	/** The renamed copy that loaded, or null for the plain fork. */
	morph: LoadedCopy | null;
}

interface CachedBuild {
	map: ModuleMap;
	fluidToml: string | undefined;
	/** Set on a renamed copy's build. */
	copy?: LoadedCopy;
}

const builds = new Map<string, CachedBuild>();

/** Directories that can contain runtime files. */
function runtimeDir(path: string): boolean {
	return RUNTIME_DIRS.some((dir) => `${path}/`.startsWith(dir) || dir.startsWith(`${path}/`));
}

export interface IsolateIdOptions {
	/** A separate isolate for the same code (a gate run, a candidate check). */
	variant?: string;
	/** The isolate that has the LLM capability. */
	useModel?: boolean;
	/** A renamed copy: its epoch, fingerprint, and names hash name its code exactly. */
	copy?: { epoch: number; fingerprint: string; namesHash: string };
}

/** repo:sha, then the variant, then "m<epoch>.<fingerprint>.<names hash>" for a renamed copy, then "llm" for the model isolate. */
export function isolateId(repo: string, sha: string, options: IsolateIdOptions = {}): string {
	let id = `${repo}:${sha}`;
	if (options.variant) id += `:${options.variant}`;
	if (options.copy) id += `:m${options.copy.epoch}.${options.copy.fingerprint}.${options.copy.namesHash}`;
	return options.useModel ? `${id}:llm` : id;
}

function cacheBuild(key: string, build: CachedBuild): void {
	if (builds.size >= MODULE_CACHE_LIMIT) builds.delete(builds.keys().next().value!);
	builds.set(key, build);
}

async function buildFor(env: Env, repoName: string, sha: string, options: LoadOptions): Promise<CachedBuild> {
	// The module map depends only on the files: a variant without extra files reuses the commit's build.
	const key = options.extraFiles ? isolateId(repoName, sha, { variant: options.variant }) : isolateId(repoName, sha);
	const cached = builds.get(key);
	if (cached) return cached;
	using repo = await openRepo(env.ARTIFACTS, repoName);
	const files = await readCommitFiles(repo, sha, {
		file: (path) => isRuntimePath(path) || path === "fluid.toml",
		dir: runtimeDir,
	});
	const merged = { ...files, ...(options.extraFiles ?? {}) };
	const build = { map: buildModuleMap(merged), fluidToml: merged["fluid.toml"] };
	cacheBuild(key, build);
	return build;
}

/**
 * The names hash of each copy built in this isolate, by repo:sha:m<epoch>.<fingerprint>:
 * the hash only building tells, and the last part of the copy's build key.
 */
const copyHashes = new Map<string, string>();

/**
 * The renamed copy of a plain build for one epoch, built once (a variant
 * shares it, so the gate checks the code production runs). Throws, saying
 * why, when no copy may load.
 */
async function copyFor(env: Env, repoName: string, sha: string, plain: CachedBuild, morph: NonNullable<LoadOptions["morph"]>, options: LoadOptions): Promise<CachedBuild & { copy: LoadedCopy }> {
	// A candidate's extra files are not the commit the seed names, and its check never needs a copy.
	if (options.extraFiles) throw new PolymorphUnavailableError("a build with extra files (a candidate under validation) is never renamed");
	if (morph.onlyAt !== undefined && morph.onlyAt !== sha) throw new PolymorphUnavailableError(`the copy is only for commit ${morph.onlyAt.slice(0, 7)}`);
	const plan = await planCopy(env, { repo: repoName, sha, epoch: morph.epoch, fluidToml: plain.fluidToml });
	const seeded = `${repoName}:${sha}:m${plan.epoch}.${plan.fingerprint}`;
	// A hash this isolate learned by building comes first; the caller's expected hash may name a copy built from it.
	const hash = copyHashes.get(seeded) ?? morph.namesHash;
	const cached = hash === undefined ? undefined : builds.get(isolateId(repoName, sha, { copy: { epoch: plan.epoch, fingerprint: plan.fingerprint, namesHash: hash } }));
	let build = cached?.copy ? { ...cached, copy: cached.copy } : null;
	if (build === null) {
		const built = await buildCopy(plan, plain.map, await readContract(env, repoName, sha, plain.fluidToml));
		const copy: LoadedCopy = { epoch: plan.epoch, fingerprint: plan.fingerprint, namesHash: built.namesHash, names: built.names, skipped: built.skipped };
		build = { map: built.map, fluidToml: plain.fluidToml, copy };
		cacheBuild(isolateId(repoName, sha, { copy }), build);
		if (copyHashes.size >= MODULE_CACHE_LIMIT) copyHashes.delete(copyHashes.keys().next().value!);
		copyHashes.set(seeded, built.namesHash);
	}
	if (morph.namesHash !== undefined && morph.namesHash !== build.copy.namesHash) {
		throw new PolymorphUnavailableError(`this copy renames other names (${build.copy.namesHash}) than the verified copy (${morph.namesHash})`);
	}
	return build;
}

/** Resolves `ref` (branch, tag, or SHA) in `repoName` and returns an RPC handle to its runtime. */
export async function loadForkRuntime(deps: RuntimeDeps, repoName: string, ref = "main", options: LoadOptions = {}): Promise<LoadedFork> {
	if (options.extraFiles && !options.variant) throw new Error("loadForkRuntime: extraFiles requires a variant");
	const short = shortRef(ref);
	let sha: string;
	{
		using repo = await openRepo(deps.env.ARTIFACTS, repoName);
		sha = await resolveCommit(repo, short);
	}
	let build = await buildFor(deps.env, repoName, sha, options);
	let copy: LoadedCopy | null = null;
	if (options.morph) {
		try {
			const copied = await copyFor(deps.env, repoName, sha, build, options.morph, options);
			build = copied;
			copy = copied.copy;
		} catch (error) {
			// Whatever stops a copy (no secret, no list, code the renamer cannot read, Artifacts failing), the plain fork still serves.
			console.warn(`polymorph: ${repoName}@${sha.slice(0, 7)} runs plain: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const id = isolateId(repoName, sha, { variant: options.variant, useModel: options.useModel === true, ...(copy ? { copy } : {}) });
	const env: Record<string, unknown> = { fluidToml: build.fluidToml, forkCommit: sha, data: synthetic };
	if (options.useModel) env.LLM = deps.exports.LlmHost({ props: { repo: repoName } });
	const worker = deps.env.LOADER.get(id, async () => ({
		compatibilityDate: RUNTIME_COMPATIBILITY_DATE,
		mainModule: build.map.mainModule,
		modules: build.map.modules as Record<string, never>,
		env,
		globalOutbound: null,
	}));
	const fork = worker.getEntrypoint("Fork") as unknown as ForkEntrypoint;
	return { repo: repoName, ref: short, sha, isolateId: id, fluidToml: build.fluidToml, fork, morph: copy };
}

export interface AskForkInput {
	repo: string;
	ref?: string;
	request: unknown;
	useModel?: boolean;
}

export async function askFork(deps: RuntimeDeps, input: AskForkInput): Promise<{ card: AnswerCardLike; sha: string; ref: string }> {
	const useModel = input.useModel ?? false;
	const loaded = await loadForkRuntime(deps, input.repo, input.ref ?? "main", { useModel });
	const card = await withTimeout(askLoaded(loaded, input.request, { useModel }), FORK_CALL_TIMEOUT_MS, `fork ${input.repo} did not answer`);
	return { card, sha: loaded.sha, ref: loaded.ref };
}

export class ForkTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ForkTimeoutError";
	}
}

/** Rejects with ForkTimeoutError when `promise` takes longer than `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new ForkTimeoutError(`${what} within ${ms} ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Loads the gate runner isolate for a stock commit. It is built only from
 * stock files (runner, toml, types) and has no env and no network.
 */
export function loadRunner(env: Env, stockSha: string, stockFiles: Record<string, string>): RunnerEntrypoint {
	const worker = env.LOADER.get(`stock-runner:${stockSha}`, async () => {
		const map = buildRunnerModuleMap(stockFiles);
		return {
			compatibilityDate: RUNTIME_COMPATIBILITY_DATE,
			mainModule: map.mainModule,
			modules: map.modules as Record<string, never>,
			env: {},
			globalOutbound: null,
		};
	});
	return worker.getEntrypoint("Runner") as unknown as RunnerEntrypoint;
}

/** RPC surface of the yellow soak's runner isolate (see modules.ts e2eRunnerEntrySource). */
export interface E2ERunnerEntrypoint {
	validate(manifest: unknown): Promise<string | null>;
	run(manifest: unknown, options: { live: { commit: string; stockTag: string }; tier: string; stepTimeoutMs?: number }, call: (op: string, args: Record<string, unknown>) => Promise<unknown>): Promise<unknown>;
}

/**
 * Loads the end-to-end runner isolate for one stock source (`key` names it:
 * the stock commit, or the bundled source for tags without a suite). It is
 * built only from stock files and has no env and no network.
 */
export function loadE2ERunner(env: Env, key: string, stockFiles: Record<string, string>): E2ERunnerEntrypoint {
	const worker = env.LOADER.get(`stock-e2e-runner:${key}`, async () => {
		const map = buildE2ERunnerModuleMap(stockFiles);
		return {
			compatibilityDate: RUNTIME_COMPATIBILITY_DATE,
			mainModule: map.mainModule,
			modules: map.modules as Record<string, never>,
			env: {},
			globalOutbound: null,
		};
	});
	return worker.getEntrypoint("E2ERunner") as unknown as E2ERunnerEntrypoint;
}

/** Drops cached module maps (tests and admin use). */
export function clearRuntimeCache(): void {
	builds.clear();
}

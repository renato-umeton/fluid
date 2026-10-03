// Fork runtime: loads a fork's code at a ref or SHA into a Worker Loader
// isolate and calls it over RPC. The isolate has no network (globalOutbound
// null). Only the model variant of an isolate (id suffix ":llm") gets the LLM
// capability in its env; every other isolate has no route to the platform.
// Isolates are keyed by repo:sha (plus a variant), and the transformed module
// map is cached per key in this isolate.
import synthetic from "../generated/synthetic.json";
import { buildModuleMap, buildRunnerModuleMap, isRuntimePath, RUNTIME_DIRS, type ModuleMap } from "./modules.ts";
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

/** RPC surface of the generated entry module (see modules.ts entrySource). */
export interface ForkEntrypoint {
	ask(request: unknown, options?: AskOptions): Promise<AnswerCardLike>;
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
	/** Required with extraFiles: distinguishes the isolate id so cached code is never reused for different inputs. */
	variant?: string;
	/** Give the isolate the LLM capability (a separate ":llm" isolate). */
	useModel?: boolean;
}

export interface LoadedFork {
	repo: string;
	ref: string;
	sha: string;
	isolateId: string;
	fluidToml: string | undefined;
	fork: ForkEntrypoint;
}

interface CachedBuild {
	map: ModuleMap;
	fluidToml: string | undefined;
}

const builds = new Map<string, CachedBuild>();

/** Directories that can contain runtime files. */
function runtimeDir(path: string): boolean {
	return RUNTIME_DIRS.some((dir) => `${path}/`.startsWith(dir) || dir.startsWith(`${path}/`));
}

export function isolateId(repo: string, sha: string, variant?: string, useModel = false): string {
	const base = variant ? `${repo}:${sha}:${variant}` : `${repo}:${sha}`;
	return useModel ? `${base}:llm` : base;
}

async function buildFor(env: Env, repoName: string, sha: string, options: LoadOptions): Promise<CachedBuild> {
	const key = isolateId(repoName, sha, options.variant);
	const cached = builds.get(key);
	if (cached) return cached;
	using repo = await openRepo(env.ARTIFACTS, repoName);
	const files = await readCommitFiles(repo, sha, {
		file: (path) => isRuntimePath(path) || path === "fluid.toml",
		dir: runtimeDir,
	});
	const merged = { ...files, ...(options.extraFiles ?? {}) };
	const build = { map: buildModuleMap(merged), fluidToml: merged["fluid.toml"] };
	if (builds.size >= MODULE_CACHE_LIMIT) builds.delete(builds.keys().next().value!);
	builds.set(key, build);
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
	const id = isolateId(repoName, sha, options.variant, options.useModel === true);
	const build = await buildFor(deps.env, repoName, sha, options);
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
	return { repo: repoName, ref: short, sha, isolateId: id, fluidToml: build.fluidToml, fork };
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
	const card = await withTimeout(loaded.fork.ask(input.request, { useModel }), FORK_CALL_TIMEOUT_MS, `fork ${input.repo} did not answer`);
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

/** Drops cached module maps (tests and admin use). */
export function clearRuntimeCache(): void {
	builds.clear();
}

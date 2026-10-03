// Fork runtime: loads a fork's code at a ref or SHA into a Worker Loader
// isolate and calls it over RPC. The isolate has no network (globalOutbound
// null); it reaches the platform only through the LLM capability in its env.
// Isolates are keyed by repo:sha (plus a variant for gate overrides), and the
// transformed module map is cached per key in this isolate.
import synthetic from "../generated/synthetic.json";
import { buildModuleMap, isRuntimePath, RUNTIME_DIRS, type ModuleMap } from "./modules.ts";
import { resolveCommit, shortRef } from "./refs.ts";
import { openRepo, readCommitFiles } from "./repo-files.ts";

export const RUNTIME_COMPATIBILITY_DATE = "2026-10-01";
const MODULE_CACHE_LIMIT = 200;

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

export interface RunManifestOptions extends AskOptions {
	forkFiles?: Record<string, string>;
	samples?: number;
}

/** RPC surface of the generated entry module (see modules.ts entrySource). */
export interface ForkEntrypoint {
	ask(request: unknown, options?: AskOptions): Promise<AnswerCardLike>;
	runManifest(manifest: unknown, options?: RunManifestOptions): Promise<unknown>;
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
	/** Files that replace or add to the fork's files before building (e.g. the stock runner for the gate). */
	extraFiles?: Record<string, string>;
	/** Required with extraFiles: distinguishes the isolate id so cached code is never reused for different inputs. */
	variant?: string;
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

/** Directories that can contain runtime files (or the runner). */
function runtimeDir(path: string): boolean {
	return path === "tests" || RUNTIME_DIRS.some((dir) => `${path}/`.startsWith(dir));
}

export function isolateId(repo: string, sha: string, variant?: string): string {
	return variant ? `${repo}:${sha}:${variant}` : `${repo}:${sha}`;
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
	const id = isolateId(repoName, sha, options.variant);
	const build = await buildFor(deps.env, repoName, sha, options);
	const worker = deps.env.LOADER.get(id, async () => ({
		compatibilityDate: RUNTIME_COMPATIBILITY_DATE,
		mainModule: build.map.mainModule,
		modules: build.map.modules as Record<string, never>,
		env: {
			fluidToml: build.fluidToml,
			forkCommit: sha,
			data: synthetic,
			LLM: deps.exports.LlmHost({ props: { repo: repoName } }),
		},
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
	const loaded = await loadForkRuntime(deps, input.repo, input.ref ?? "main");
	const card = await loaded.fork.ask(input.request, { useModel: input.useModel ?? false });
	return { card, sha: loaded.sha, ref: loaded.ref };
}

/** Drops cached module maps (tests and admin use). */
export function clearRuntimeCache(): void {
	builds.clear();
}

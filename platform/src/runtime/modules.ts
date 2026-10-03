// Turns a fork's repository files into a Worker Loader module map. Fork code
// stays TypeScript in the repo (relative imports use the ".js" extension);
// each .ts file is stripped of types with sucrase (imports untouched) and
// registered under its .js name, so the isolate's module resolver finds it.
// JSON files become json modules. A generated entry module wraps the fork's
// default export in a named RPC entrypoint.
import { transform } from "sucrase";

/** Directories whose files are runtime code. Everything else in the repo is ignored by the loader. */
export const RUNTIME_DIRS = ["app/", "intent/", "policies/", "connectors/"] as const;
/** The stock probe runner. It runs in its own isolate built only from stock files (see buildRunnerModuleMap). */
export const RUNNER_PATH = "tests/runner.ts";
/** Stock modules the runner imports. The gate always takes these from stock, never from the fork. */
export const RUNNER_STOCK_DEPS = ["app/toml.ts", "app/types.ts"] as const;
export const ENTRY_MODULE = "fluid-entry.js";
export const RUNNER_ENTRY_MODULE = "fluid-runner.js";
export const APP_MODULE = "app/index.js";

export type LoaderModule = { js: string } | { json: unknown };

export interface ModuleMap {
	mainModule: string;
	modules: Record<string, LoaderModule>;
}

/** True for files a fork runtime needs: sources and JSON under RUNTIME_DIRS. Tests are never part of a fork runtime. */
export function isRuntimePath(path: string): boolean {
	if (!RUNTIME_DIRS.some((dir) => path.startsWith(dir))) return false;
	if (path.endsWith(".d.ts")) return false;
	if (/\.test\.[cm]?[jt]s$/.test(path)) return false;
	return /\.(ts|js|mjs|json)$/.test(path);
}

/** The fork's code cannot be built into a runtime (transform error, bad JSON, no app/index.ts): the fork's fault, not the platform's. */
export class ForkCodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ForkCodeError";
	}
}

/** Strips TypeScript syntax and leaves ES module syntax as written. */
export function transformTs(source: string, path: string): string {
	try {
		return transform(source, { transforms: ["typescript"], disableESTransforms: true, filePath: path }).code;
	} catch (error) {
		throw new ForkCodeError(`TypeScript transform failed for ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Module name a repo file is registered under: foo.ts -> foo.js, everything else unchanged. */
export function moduleName(path: string): string {
	return path.endsWith(".ts") ? `${path.slice(0, -3)}.js` : path;
}

export function buildModuleMap(files: Record<string, string>): ModuleMap {
	const modules: Record<string, LoaderModule> = {};
	const origin: Record<string, string> = {};
	for (const [path, text] of Object.entries(files)) {
		if (!isRuntimePath(path)) continue;
		const name = moduleName(path);
		if (origin[name]) throw new ForkCodeError(`module ${name} is defined by both ${origin[name]} and ${path}`);
		origin[name] = path;
		modules[name] = path.endsWith(".json") ? { json: parseJson(text, path) } : { js: path.endsWith(".ts") ? transformTs(text, path) : text };
	}
	if (!modules[APP_MODULE]) throw new ForkCodeError(`fork has no app/index.ts (or app/index.js); cannot build a runtime`);
	modules[ENTRY_MODULE] = { js: entrySource() };
	return { mainModule: ENTRY_MODULE, modules };
}

/**
 * Module map for the gate's runner isolate: stock's tests/runner.ts plus the
 * stock modules it imports, all read from stock at the pinned tag. No fork
 * file is ever part of it, so fork code cannot patch the runner's globals or
 * its config parser. The runner reaches the fork only through an ask callback.
 */
export function buildRunnerModuleMap(stockFiles: Record<string, string>): ModuleMap {
	const modules: Record<string, LoaderModule> = {};
	for (const path of [RUNNER_PATH, ...RUNNER_STOCK_DEPS]) {
		const text = stockFiles[path];
		if (text === undefined) throw new Error(`stock is missing ${path}; cannot build the gate runner`);
		try {
			modules[moduleName(path)] = { js: transformTs(text, path) };
		} catch (error) {
			// Stock's own runner failing to build is a platform problem, never the fork's.
			throw new Error(`stock ${path} does not build: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	modules[RUNNER_ENTRY_MODULE] = { js: runnerEntrySource() };
	return { mainModule: RUNNER_ENTRY_MODULE, modules };
}

export function runnerEntrySource(): string {
	return `import { WorkerEntrypoint } from "cloudflare:workers";
import { runManifest } from "./${moduleName(RUNNER_PATH)}";

export class Runner extends WorkerEntrypoint {
  async run(manifest, options, ask) {
    const opts = options || {};
    const app = { ask: (request) => ask(request) };
    return runManifest({ app, manifest, forkFiles: opts.forkFiles || {}, env: {}, samples: opts.samples, tier: opts.tier, timeoutMs: opts.timeoutMs });
  }
}

export default {
  async fetch() {
    return new Response("Fluid gate runner. Use the Runner entrypoint.", { status: 404 });
  },
};
`;
}

function parseJson(text: string, path: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new ForkCodeError(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Entry module run inside the fork isolate. env carries fluidToml, forkCommit,
 * data (synthetic), and, only in the model variant of the isolate, LLM (an
 * RPC capability back to the platform). The fork sees env.llm as the plain
 * function hook its contract expects. The card is returned as a JSON string,
 * so the platform receives plain data.
 */
export function entrySource(): string {
	return `import { WorkerEntrypoint } from "cloudflare:workers";
import app from "./${APP_MODULE}";

function forkEnv(env, options) {
  const out = { fluidToml: env.fluidToml, forkCommit: env.forkCommit, data: env.data };
  if (options && options.useModel && env.LLM) out.llm = (prompt, schema) => env.LLM.complete(prompt, schema);
  return out;
}

export class Fork extends WorkerEntrypoint {
  async ask(request, options) {
    const card = await app.ask(request, forkEnv(this.env, options));
    return JSON.stringify(card);
  }
}

export default {
  async fetch() {
    return new Response("Fluid fork runtime. Use the Fork entrypoint.", { status: 404 });
  },
};
`;
}

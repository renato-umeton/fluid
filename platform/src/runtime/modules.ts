// Turns a fork's repository files into a Worker Loader module map. Fork code
// stays TypeScript in the repo (relative imports use the ".js" extension);
// each .ts file is stripped of types with sucrase (imports untouched) and
// registered under its .js name, so the isolate's module resolver finds it.
// JSON files become json modules. A generated entry module wraps the fork's
// default export in a named RPC entrypoint.
import { transform } from "sucrase";

/** Directories whose files are runtime code. Everything else in the repo is ignored by the loader. */
export const RUNTIME_DIRS = ["app/", "intent/", "policies/", "connectors/"] as const;
/** The stock probe runner. When present it is loaded too, so the gate can run probes inside the isolate. */
export const RUNNER_PATH = "tests/runner.ts";
export const ENTRY_MODULE = "fluid-entry.js";
export const APP_MODULE = "app/index.js";

export type LoaderModule = { js: string } | { json: unknown };

export interface ModuleMap {
	mainModule: string;
	modules: Record<string, LoaderModule>;
	hasRunner: boolean;
}

/** True for files the loader needs: runtime sources and JSON under RUNTIME_DIRS, plus the runner. */
export function isRuntimePath(path: string): boolean {
	if (path === RUNNER_PATH) return true;
	if (!RUNTIME_DIRS.some((dir) => path.startsWith(dir))) return false;
	if (path.endsWith(".d.ts")) return false;
	if (/\.test\.[cm]?[jt]s$/.test(path)) return false;
	return /\.(ts|js|mjs|json)$/.test(path);
}

/** Strips TypeScript syntax and leaves ES module syntax as written. */
export function transformTs(source: string, path: string): string {
	try {
		return transform(source, { transforms: ["typescript"], disableESTransforms: true, filePath: path }).code;
	} catch (error) {
		throw new Error(`TypeScript transform failed for ${path}: ${error instanceof Error ? error.message : String(error)}`);
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
		if (origin[name]) throw new Error(`module ${name} is defined by both ${origin[name]} and ${path}`);
		origin[name] = path;
		modules[name] = path.endsWith(".json") ? { json: parseJson(text, path) } : { js: path.endsWith(".ts") ? transformTs(text, path) : text };
	}
	if (!modules[APP_MODULE]) throw new Error(`fork has no app/index.ts (or app/index.js); cannot build a runtime`);
	const hasRunner = moduleName(RUNNER_PATH) in modules;
	modules[ENTRY_MODULE] = { js: entrySource(hasRunner) };
	return { mainModule: ENTRY_MODULE, modules, hasRunner };
}

function parseJson(text: string, path: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Entry module run inside the isolate. env carries fluidToml, forkCommit, data
 * (synthetic), and LLM (an RPC capability back to the platform). The fork
 * sees env.llm as the plain function hook its contract expects.
 */
export function entrySource(hasRunner: boolean): string {
	return `import { WorkerEntrypoint } from "cloudflare:workers";
import app from "./${APP_MODULE}";
${hasRunner ? `import { runManifest } from "./${moduleName(RUNNER_PATH)}";\n` : ""}
function forkEnv(env, options) {
  const out = { fluidToml: env.fluidToml, forkCommit: env.forkCommit, data: env.data };
  if (options && options.useModel && env.LLM) out.llm = (prompt, schema) => env.LLM.complete(prompt, schema);
  return out;
}

export class Fork extends WorkerEntrypoint {
  async ask(request, options) {
    return app.ask(request, forkEnv(this.env, options));
  }
  async runManifest(manifest, options) {
    ${hasRunner ? "" : 'throw new Error("this fork has no tests/runner.ts");'}
    const opts = options || {};
    const forkFiles = { ...(opts.forkFiles || {}) };
    if (forkFiles["fluid.toml"] === undefined && this.env.fluidToml !== undefined) forkFiles["fluid.toml"] = this.env.fluidToml;
    const env = forkEnv(this.env, opts);
    delete env.fluidToml;
    return ${hasRunner ? "runManifest({ app, manifest, forkFiles, env, samples: opts.samples })" : "null"};
  }
}

export default {
  async fetch() {
    return new Response("Fluid fork runtime. Use the Fork entrypoint.", { status: 404 });
  },
};
`;
}

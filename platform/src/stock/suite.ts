// The floor a gate enforces always comes from the `stock` repo at the fork's
// pinned tag: the probe runner (with stock's own toml and types modules) and
// the invariant and functional manifests. Copies of tests/ inside a fork are
// ignored, and no fork file is ever loaded next to the runner.
import { STOCK_REPO } from "../lib/names.ts";
import { RUNNER_PATH, RUNNER_STOCK_DEPS } from "../runtime/modules.ts";
import { resolveCommit } from "../runtime/refs.ts";
import { openRepo, readTextFile } from "../runtime/repo-files.ts";

export interface StockSuite {
	tag: string;
	sha: string;
	/** tests/runner.ts, app/toml.ts, app/types.ts at the tag. */
	runnerFiles: Record<string, string>;
	manifests: { invariant: unknown; functional: unknown };
	/** Stock fluid.toml at the tag (the stock minimum tau lives here and in the invariants). */
	fluidToml: string | null;
}

const suites = new Map<string, StockSuite>();

export async function loadStockSuite(env: Env, tag: string): Promise<StockSuite> {
	using repo = await openRepo(env.ARTIFACTS, STOCK_REPO);
	const sha = await resolveCommit(repo, tag);
	const cached = suites.get(sha);
	if (cached) return { ...cached, tag };
	const paths = [RUNNER_PATH, ...RUNNER_STOCK_DEPS, "tests/invariants/manifest.json", "tests/functional/manifest.json", "fluid.toml"];
	const texts = await Promise.all(paths.map((path) => readTextFile(repo, sha, path)));
	const byPath = Object.fromEntries(paths.map((path, i) => [path, texts[i]]));
	const runnerFiles: Record<string, string> = {};
	for (const path of [RUNNER_PATH, ...RUNNER_STOCK_DEPS]) {
		const text = byPath[path];
		if (text === null || text === undefined) throw new Error(`stock ${tag} has no ${path}`);
		runnerFiles[path] = text;
	}
	const invariant = byPath["tests/invariants/manifest.json"];
	const functional = byPath["tests/functional/manifest.json"];
	if (!invariant || !functional) throw new Error(`stock ${tag} is missing a test manifest`);
	const suite: StockSuite = {
		tag,
		sha,
		runnerFiles,
		manifests: { invariant: JSON.parse(invariant), functional: JSON.parse(functional) },
		fluidToml: byPath["fluid.toml"] ?? null,
	};
	if (suites.size > 20) suites.delete(suites.keys().next().value!);
	suites.set(sha, suite);
	return suite;
}

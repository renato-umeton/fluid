// The floor a gate enforces always comes from the `stock` repo at the fork's
// pinned tag: the probe runner and the invariant and functional manifests.
// Copies of tests/ inside a fork are ignored.
import { STOCK_REPO } from "../lib/names.ts";
import { parseToml } from "../lib/toml.ts";
import { loadForkRuntime, type RuntimeDeps } from "../runtime/loader.ts";
import { resolveCommit } from "../runtime/refs.ts";
import { openRepo, readTextFile } from "../runtime/repo-files.ts";

export interface StockSuite {
	tag: string;
	sha: string;
	runnerSource: string;
	manifests: { invariant: unknown; functional: unknown };
	/** Pass to loadForkRuntime so the fork runs with the stock runner. */
	loadOptions: { extraFiles: Record<string, string>; variant: string };
}

export async function loadStockSuite(env: Env, tag: string): Promise<StockSuite> {
	using repo = await openRepo(env.ARTIFACTS, STOCK_REPO);
	const sha = await resolveCommit(repo, tag);
	const [runnerSource, invariant, functional] = await Promise.all([
		readTextFile(repo, sha, "tests/runner.ts"),
		readTextFile(repo, sha, "tests/invariants/manifest.json"),
		readTextFile(repo, sha, "tests/functional/manifest.json"),
	]);
	if (runnerSource === null) throw new Error(`stock ${tag} has no tests/runner.ts`);
	if (invariant === null || functional === null) throw new Error(`stock ${tag} is missing a test manifest`);
	return {
		tag,
		sha,
		runnerSource,
		manifests: { invariant: JSON.parse(invariant), functional: JSON.parse(functional) },
		loadOptions: { extraFiles: { "tests/runner.ts": runnerSource }, variant: `stock-runner-${sha.slice(0, 12)}` },
	};
}

export interface SuiteRunResult {
	repo: string;
	ref: string;
	commit: string;
	stockTag: string;
	tiers: { invariant: unknown; functional: unknown };
}

/**
 * Runs the stock invariant and functional manifests (at the fork's pinned tag)
 * against a fork ref, inside the fork's isolate with the stock runner swapped in.
 */
export async function runStockSuite(deps: RuntimeDeps, repo: string, ref: string, options: { samples?: number; useModel?: boolean } = {}): Promise<SuiteRunResult> {
	const probe = await loadForkRuntime(deps, repo, ref);
	const pinned = probe.fluidToml ? parseToml(probe.fluidToml).stock_tag : undefined;
	if (typeof pinned !== "string") throw new Error(`${repo}@${ref}: fluid.toml has no stock_tag`);
	const suite = await loadStockSuite(deps.env, pinned);
	const loaded = await loadForkRuntime(deps, repo, probe.sha, suite.loadOptions);
	const forkFiles: Record<string, string> = probe.fluidToml === undefined ? {} : { "fluid.toml": probe.fluidToml };
	const run = (manifest: unknown) => loaded.fork.runManifest(manifest, { forkFiles, samples: options.samples, useModel: options.useModel ?? false });
	const [invariant, functional] = await Promise.all([run(suite.manifests.invariant), run(suite.manifests.functional)]);
	return { repo, ref: probe.ref, commit: probe.sha, stockTag: pinned, tiers: { invariant, functional } };
}

// Gate core: runs the three tiers against a fork commit. The fork runs in its
// own isolate; stock's runner runs in a separate isolate built only from
// stock files at the pinned tag and reaches the fork through an ask callback
// that the platform time-boxes. Used by the Gate, Upgrade, and Repair
// workflows and by the admin suite route.
import { parseToml } from "../lib/toml.ts";
import { FORK_CALL_TIMEOUT_MS, loadForkRuntime, loadRunner, withTimeout, type RuntimeDeps } from "../runtime/loader.ts";
import { resolveCommit, shortRef } from "../runtime/refs.ts";
import { openRepo, readTextFile } from "../runtime/repo-files.ts";
import { loadStockSuite } from "../stock/suite.ts";
import {
	capFailures,
	emptyUserTier,
	erroredTier,
	prepareUserManifest,
	summarizeTier,
	USER_MANIFEST_PATH,
	verdict,
	type GateFailure,
	type GateResult,
	type RunnerManifestResult,
	type TierName,
	type TierSummary,
} from "./tiers.ts";

export interface GateInput {
	repo: string;
	/** Branch, tag, or SHA that was pushed. */
	ref: string;
	/** Exact commit to gate; defaults to the head of ref. */
	commit?: string;
	/** Override sample counts (tests and quick checks); the manifests' counts are the default. */
	samples?: number;
}

export async function runGate(deps: RuntimeDeps, input: GateInput): Promise<GateResult> {
	const started = Date.now();
	const ref = shortRef(input.ref);
	let commit: string;
	let fluidToml: string | null;
	let userText: string | null;
	{
		using repo = await openRepo(deps.env.ARTIFACTS, input.repo);
		commit = await resolveCommit(repo, input.commit ?? ref);
		[fluidToml, userText] = await Promise.all([readTextFile(repo, commit, "fluid.toml"), readTextFile(repo, commit, USER_MANIFEST_PATH)]);
	}
	const tiers: Record<TierName, TierSummary | null> = { invariant: null, functional: null, user: null };
	const failures: GateFailure[] = [];
	const finish = (stockTag: string | null, stockCommit: string | null, error?: string): GateResult => {
		const result: GateResult = {
			repo: input.repo,
			ref,
			commit,
			stockTag,
			stockCommit,
			at: new Date().toISOString(),
			passed: !error && verdict(tiers, failures),
			tiers,
			failures: capFailures(failures),
			durationMs: Date.now() - started,
		};
		if (error) result.error = error;
		return result;
	};
	const record = (tier: TierName, part: { summary: TierSummary; failures: GateFailure[] }) => {
		tiers[tier] = part.summary;
		failures.push(...part.failures);
	};

	let pinned: unknown;
	try {
		pinned = fluidToml === null ? undefined : parseToml(fluidToml).stock_tag;
	} catch (error) {
		record("invariant", erroredTier("invariant", "fluid-toml-parses", "read", "a valid fluid.toml", message(error), "fluid.toml"));
		return finish(null, null, "fluid.toml does not parse");
	}
	if (typeof pinned !== "string") {
		record("invariant", erroredTier("invariant", "fluid-toml-stock-tag", "read", "fluid.toml names stock_tag", fluidToml === null ? "fluid.toml is missing" : "no stock_tag", "fluid.toml"));
		return finish(null, null, "fluid.toml has no stock_tag");
	}
	let suite;
	try {
		suite = await loadStockSuite(deps.env, pinned);
	} catch (error) {
		record("invariant", erroredTier("invariant", "stock-tag-exists", "read", `stock ${pinned} exists`, message(error), "fluid.toml"));
		return finish(pinned, null, `stock ${pinned} could not be loaded`);
	}

	let ask: (request: unknown) => Promise<unknown>;
	try {
		const loaded = await loadForkRuntime(deps, input.repo, commit);
		ask = (request) => withTimeout(loaded.fork.ask(request, { useModel: false }), FORK_CALL_TIMEOUT_MS, "fork did not answer");
	} catch (error) {
		record("invariant", erroredTier("invariant", "fork-runtime-loads", "load", "the fork runtime builds and loads", message(error)));
		return finish(pinned, suite.sha);
	}
	const runner = loadRunner(deps.env, suite.sha, suite.runnerFiles);
	const forkFiles: Record<string, string> = fluidToml === null ? {} : { "fluid.toml": fluidToml };
	const run = (manifest: unknown, tier?: string) =>
		runner.run(manifest, { forkFiles, ...(input.samples ? { samples: input.samples } : {}), ...(tier ? { tier } : {}) }, ask) as Promise<RunnerManifestResult>;

	const user = prepareUserManifest(userText);
	const [invariant, functional, userResult] = await Promise.allSettled([
		run(suite.manifests.invariant),
		run(suite.manifests.functional),
		user.manifest ? run(user.manifest, "user") : Promise.resolve(null),
	]);
	record("invariant", settledTier("invariant", invariant));
	record("functional", settledTier("functional", functional));
	if (user.error) {
		record("user", erroredTier("user", "user-manifest-valid", "read", "a valid tests/user/manifest.json", user.error, USER_MANIFEST_PATH));
	} else if (userResult.status === "rejected") {
		record("user", erroredTier("user", "user-manifest-runs", "run", "the user manifest runs", message(userResult.reason), USER_MANIFEST_PATH));
	} else if (userResult.value === null) {
		tiers.user = emptyUserTier(user.disabled);
	} else {
		record("user", summarizeTier("user", userResult.value, { file: USER_MANIFEST_PATH, disabled: user.disabled }));
	}
	return finish(pinned, suite.sha);
}

function settledTier(tier: TierName, settled: PromiseSettledResult<RunnerManifestResult>) {
	if (settled.status === "fulfilled") return summarizeTier(tier, settled.value);
	return erroredTier(tier, `${tier}-suite-runs`, "run", `the stock ${tier} suite runs`, message(settled.reason));
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}


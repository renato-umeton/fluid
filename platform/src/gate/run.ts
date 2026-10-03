// Gate core: runs the three tiers against a fork commit. The fork runs in its
// own isolate; stock's runner runs in a separate isolate built only from
// stock files at the pinned tag and reaches the fork through an ask callback
// that the platform time-boxes. Used by the Gate, Upgrade, and Repair
// workflows and by the admin suite route.
import { parseToml } from "../lib/toml.ts";
import { askCard, FORK_CALL_TIMEOUT_MS, loadForkRuntime, loadRunner, withTimeout, type RuntimeDeps } from "../runtime/loader.ts";
import { resolveCommit, shortRef } from "../runtime/refs.ts";
import { headOf, openRepo, readTextFile } from "../runtime/repo-files.ts";
import { pinnedTagOf } from "../stock/releases.ts";
import { loadStockSuite } from "../stock/suite.ts";
import { fleetStub } from "../stubs.ts";
import { checkPin, isForkCaused } from "./pins.ts";
import {
	capFailures,
	emptyUserTier,
	erroredTier,
	prepareUserManifest,
	summarizeTier,
	USER_LIMITS,
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
	/**
	 * "merge": the result may reach main, so the pin must not move backward
	 * (at least main's pin and the latest safety release). "check": report only.
	 */
	mode?: "merge" | "check";
}

/** Isolate variant for one gate run: the gate never shares an isolate (or its module state) with production or another gate. */
export function gateVariant(): string {
	return `gate-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Runs tiers 1 to 3 against one fork commit. Problems the fork caused (a
 * missing ref, a pin that is not a published release or moves backward,
 * code that does not build, an invalid tier 3 manifest) become failures in
 * the result. Anything else (Artifacts or the loader unavailable, the stock
 * suite failing to run) is thrown, so the workflow step retries it and no
 * repair opens for an infrastructure problem.
 */
export async function runGate(deps: RuntimeDeps, input: GateInput): Promise<GateResult> {
	const started = Date.now();
	const ref = shortRef(input.ref);
	let commit = input.commit ?? ref;
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

	let fluidToml: string | null;
	let userText: string | null;
	let mainToml: string | null = null;
	try {
		using repo = await openRepo(deps.env.ARTIFACTS, input.repo);
		commit = await resolveCommit(repo, input.commit ?? ref);
		[fluidToml, userText, mainToml] = await Promise.all([
			readTextFile(repo, commit, "fluid.toml"),
			readTextFile(repo, commit, USER_MANIFEST_PATH),
			input.mode === "merge" ? readMainToml(repo) : Promise.resolve(null),
		]);
	} catch (error) {
		if (!isForkCaused(error)) throw error;
		record("invariant", erroredTier("invariant", "fork-commit-exists", "read", `${ref} exists in ${input.repo}`, message(error)));
		return finish(null, null, message(error));
	}

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
		if (!isForkCaused(error)) throw error;
		record("invariant", erroredTier("invariant", "stock-tag-published", "read", "stock_tag names a published stock release tag", message(error), "fluid.toml"));
		return finish(pinned, null, `stock ${pinned} cannot be the floor: ${message(error)}`);
	}
	const pin = input.mode === "merge" ? checkPin({ pinned, mainPin: pinnedTagOf(mainToml), releases: await fleetStub(deps.env).releases() }) : null;

	let ask: (request: unknown) => Promise<unknown>;
	try {
		const loaded = await loadForkRuntime(deps, input.repo, commit, { variant: gateVariant() });
		ask = (request) => withTimeout(askCard(loaded.fork, request, { useModel: false }), FORK_CALL_TIMEOUT_MS, "fork did not answer");
	} catch (error) {
		if (!isForkCaused(error)) throw error;
		record("invariant", erroredTier("invariant", "fork-runtime-loads", "load", "the fork runtime builds and loads", message(error)));
		return finish(pinned, suite.sha);
	}
	const runner = loadRunner(deps.env, suite.sha, suite.runnerFiles);
	const forkFiles: Record<string, string> = fluidToml === null ? {} : { "fluid.toml": fluidToml };
	const run = (manifest: unknown, tier?: string) =>
		runner.run(manifest, { forkFiles, ...(input.samples ? { samples: input.samples } : {}), ...(tier ? { tier } : {}) }, ask) as Promise<RunnerManifestResult>;

	const user = prepareUserManifest(userText);
	// The stock suites and a validated tier 3 manifest only reject for infrastructure reasons: allSettled lets
	// every tier finish, then a rejection is thrown for the step to retry.
	const [invariant, functional, userResult] = await Promise.allSettled([
		run(suite.manifests.invariant),
		run(suite.manifests.functional),
		user.manifest ? run(user.manifest, "user") : Promise.resolve(null),
	]);
	for (const settled of [invariant, functional, userResult]) if (settled.status === "rejected") throw settled.reason;
	record("invariant", summarizeTier("invariant", (invariant as PromiseFulfilledResult<RunnerManifestResult>).value));
	record("functional", summarizeTier("functional", (functional as PromiseFulfilledResult<RunnerManifestResult>).value));
	const userValue = (userResult as PromiseFulfilledResult<RunnerManifestResult | null>).value;
	if (user.error) {
		record("user", erroredTier("user", "user-manifest-valid", "read", "a valid tests/user/manifest.json", user.error, USER_MANIFEST_PATH));
	} else if (userValue === null) {
		tiers.user = emptyUserTier(user.disabled);
	} else {
		record("user", summarizeTier("user", userValue, { file: USER_MANIFEST_PATH, disabled: user.disabled }));
		if (user.dropped) tiers.user!.note = `${user.dropped} probe(s) past the limit of ${USER_LIMITS.maxProbes} were not run`;
	}
	if (pin && !pin.ok) addPinFailure(tiers, failures, pin.reason, pinned, pin.floor);
	return finish(pinned, suite.sha);
}

/** A pin that moves backward fails tier 1 as probe "pin-monotonic", next to whatever the suite found. */
function addPinFailure(tiers: Record<TierName, TierSummary | null>, failures: GateFailure[], reason: string, pinned: string, floor: string): void {
	const failure: GateFailure = { tier: "invariant", probe: "pin-monotonic", description: reason, sample: 1, samples: 1, file: "fluid.toml", path: "stock_tag", op: "gte", expected: floor, actual: pinned };
	failures.unshift(failure);
	const t = tiers.invariant;
	const probe = { id: "pin-monotonic", passed: false, samples: 1, passedSamples: 0 };
	tiers.invariant = t ? { ...t, passed: false, total: t.total + 1, failed: t.failed + 1, probes: [probe, ...t.probes] } : { tier: "invariant", passed: false, total: 1, failed: 1, probes: [probe] };
}

async function readMainToml(repo: ArtifactsRepo): Promise<string | null> {
	const head = await headOf(repo, "main");
	return head ? readTextFile(repo, head, "fluid.toml") : null;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

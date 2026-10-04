// One run of the end-to-end tiers against a fork's live main at one commit.
// The stock runner runs in its own isolate built only from stock files at the
// pinned tag (or, for a tag published before stock shipped an end-to-end
// suite, from the stock source bundled into the platform) and reaches the
// fork and the platform through a single host callback over RPC. Steps that
// touch platform state (the ledger, overrides) act for a synthetic test user
// scoped to the run, so they never write to the real user's ledger.
import stockSource from "../generated/stock-source.json";
import { serveAsk } from "../api/ask.ts";
import { readIntents } from "../forks/provision.ts";
import { fnv1a } from "../events/filter.ts";
import { testUserId } from "../lib/session.ts";
import { parseToml } from "../lib/toml.ts";
import { loadE2ERunner, type RuntimeDeps } from "../runtime/loader.ts";
import { RUNNER_PATH, RUNNER_STOCK_DEPS, E2E_RUNNER_PATH } from "../runtime/modules.ts";
import { listCommitFiles, openRepo, readTextFile } from "../runtime/repo-files.ts";
import { pinnedTagOf } from "../stock/releases.ts";
import { resolveStockTag } from "../stock/suite.ts";
import { STOCK_REPO } from "../lib/names.ts";
import { ledgerStub } from "../stubs.ts";
import { parseUiPreferences, UI_PREFERENCES_PATH } from "../ui/preferences.ts";
import { e2eFailures, FORK_ERROR_PREFIX, prepareE2ETiers, runRetryable, STOCK_E2E_PATH, stockManifestOf, USER_E2E_PATH, type E2EFailure, type E2ETierName, type E2ETierResult } from "./tiers.ts";

export interface E2ERunInput {
	repo: string;
	commit: string;
	runId: string;
	stepTimeoutMs?: number;
	/** Set to run in a fresh runner isolate (the retry of a pass that failed for retryable reasons). */
	fresh?: string;
}

export interface E2ERunResult {
	repo: string;
	commit: string;
	stockTag: string | null;
	/** Which runner ran: stock's at the pinned tag, or the platform's bundled copy for tags without a suite. */
	runner: "stock" | "bundled";
	at: string;
	passed: boolean;
	tiers: E2ETierResult[];
	failures: E2EFailure[];
	/** The run failed only for reasons that may come from the platform (see runRetryable); the soak runs it again before deciding. */
	retryable: boolean;
	durationMs: number;
	testUser: string;
	error?: string;
}

const MODES = ["clinical", "research", "administrative"];
const RUNNER_FILES = [E2E_RUNNER_PATH, RUNNER_PATH, ...RUNNER_STOCK_DEPS];

interface StockE2E {
	key: string;
	runner: "stock" | "bundled";
	files: Record<string, string>;
	manifestText: string | null;
}

const stockE2ECache = new Map<string, StockE2E>();

/** The stock end-to-end suite and runner at a published tag; a tag without them gets the bundled runner and an empty suite. */
export async function loadStockE2E(env: Env, tag: string): Promise<StockE2E> {
	const sha = await resolveStockTag(env, tag);
	const cached = stockE2ECache.get(sha);
	if (cached) return cached;
	using repo = await openRepo(env.ARTIFACTS, STOCK_REPO);
	const texts = await Promise.all([STOCK_E2E_PATH, ...RUNNER_FILES].map((path) => readTextFile(repo, sha, path)));
	const [manifestText, ...runnerTexts] = texts;
	let loaded: StockE2E;
	if (runnerTexts.every((t) => t !== null)) {
		loaded = { key: sha, runner: "stock", files: Object.fromEntries(RUNNER_FILES.map((path, i) => [path, runnerTexts[i]!])), manifestText: manifestText ?? null };
	} else {
		loaded = { ...bundledRunner(), manifestText: null };
	}
	if (stockE2ECache.size > 20) stockE2ECache.delete(stockE2ECache.keys().next().value!);
	stockE2ECache.set(sha, loaded);
	return loaded;
}

function bundledRunner(): Omit<StockE2E, "manifestText"> {
	const source = stockSource.files as Record<string, string>;
	const files = Object.fromEntries(RUNNER_FILES.map((path) => [path, source[path] ?? ""]));
	if (RUNNER_FILES.some((path) => !source[path])) throw new Error("the bundled stock source has no end-to-end runner; run npm run content");
	return { key: `bundled-${fnv1a(RUNNER_FILES.map((p) => files[p]).join("\n"))}`, runner: "bundled", files };
}

/**
 * Runs every end-to-end tier once. Problems with the fork's own scenarios (an
 * invalid tests/user/e2e.json) fail the user tier. Infrastructure errors
 * (Artifacts, the loader) are thrown, so the workflow step retries.
 */
export async function runE2E(deps: RuntimeDeps, input: E2ERunInput): Promise<E2ERunResult> {
	const started = Date.now();
	const testUser = testUserId(input.runId);
	let fluidToml: string | null;
	let userText: string | null;
	{
		using repo = await openRepo(deps.env.ARTIFACTS, input.repo);
		[fluidToml, userText] = await Promise.all([readTextFile(repo, input.commit, "fluid.toml"), readTextFile(repo, input.commit, USER_E2E_PATH)]);
	}
	const stockTag = pinnedTagOf(fluidToml);
	const finish = (partial: Pick<E2ERunResult, "tiers" | "runner"> & { error?: string }): E2ERunResult => {
		const failures = e2eFailures(partial.tiers);
		const passed = !partial.error && partial.tiers.length > 0 && partial.tiers.every((t) => t.passed);
		if (partial.error) failures.unshift({ tier: "stock", scenario: "e2e-setup", step: null, path: "", op: "read", expected: "the fork pins a published stock tag", actual: partial.error });
		const retryable = !passed && !partial.error && runRetryable(partial.tiers);
		return { repo: input.repo, commit: input.commit, stockTag, at: new Date().toISOString(), passed, retryable, durationMs: Date.now() - started, testUser, ...partial, failures };
	};
	if (!stockTag) return finish({ tiers: [], runner: "bundled", error: "fluid.toml names no stock_tag" });
	const stock = await loadStockE2E(deps.env, stockTag);
	const prepared = prepareE2ETiers({ stock: stockManifestOf(stock.manifestText), userText });
	const runner = loadE2ERunner(deps.env, input.fresh ? `${stock.key}:${input.fresh}` : stock.key, stock.files);
	const call = hostCallback(deps, { repo: input.repo, commit: input.commit, testUser });
	const live = { commit: input.commit, stockTag };
	const tiers: E2ETierResult[] = [];
	for (const { tier, manifest } of prepared.tiers) {
		const problem = await runner.validate(manifest);
		if (problem) {
			if (tier !== "user") throw new Error(`the ${tier} end-to-end suite is invalid: ${problem}`);
			tiers.push({ tier, passed: false, total: 0, failed: 1, skipped: 0, scenarios: [], error: problem });
			continue;
		}
		tiers.push(await runTierSafely(tier, async () => (await runner.run(manifest, { live, tier, ...(input.stepTimeoutMs ? { stepTimeoutMs: input.stepTimeoutMs } : {}) }, call)) as E2ETierResult));
	}
	const user = prepared.user;
	if (user.error) tiers.push({ tier: "user", passed: false, total: 0, failed: 1, skipped: 0, scenarios: [], error: user.error });
	const userTier = tiers.find((t) => t.tier === "user");
	if (userTier) {
		if (user.disabled.length) userTier.disabled = user.disabled;
		if (user.rejected.length) userTier.rejected = user.rejected;
		if (user.dropped) userTier.note = `${user.dropped} scenario(s) past the limit were not run`;
	} else if (user.disabled.length || user.rejected.length) {
		tiers.push({ tier: "user", passed: true, total: 0, failed: 0, skipped: 0, scenarios: [], disabled: user.disabled, rejected: user.rejected, note: "no enabled user scenarios" });
	}
	return finish({ tiers, runner: stock.runner });
}

/**
 * Runs one tier. The user tier's scenarios come from the fork, so an
 * exception while running them (a pattern that stalls the isolate, for
 * example) fails the user tier. Stock and platform tier exceptions are
 * infrastructure problems and are thrown for the step to retry.
 */
export async function runTierSafely(tier: E2ETierName, run: () => Promise<E2ETierResult>): Promise<E2ETierResult> {
	if (tier !== "user") return run();
	try {
		return await run();
	} catch (error) {
		return { tier, passed: false, total: 0, failed: 1, skipped: 0, scenarios: [], error: `the user scenarios could not run: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400) };
	}
}

/** Errors the fork caused carry the runner's fork error prefix, so the runner does not mark them retryable. */
export function hostError(error: unknown): unknown {
	const name = (error as { name?: unknown } | null)?.name;
	if (name === "ForkCodeError" || name === "ForkRuntimeError") return new Error(`${FORK_ERROR_PREFIX}${(error as Error).message}`);
	return error;
}

/**
 * The host the runner isolate calls back into. Every operation acts on the
 * fork at the yellow commit and on the run's synthetic test user.
 */
export function hostCallback(deps: RuntimeDeps, scope: { repo: string; commit: string; testUser: string }): (op: string, args: Record<string, unknown>) => Promise<unknown> {
	return async (op, args) => {
		try {
			return await hostOperation(deps, scope, op, args);
		} catch (error) {
			throw hostError(error);
		}
	};
}

async function hostOperation(deps: RuntimeDeps, scope: { repo: string; commit: string; testUser: string }, op: string, args: Record<string, unknown>): Promise<unknown> {
	switch (op) {
		case "ask": {
			const request = args.request as Record<string, unknown>;
			const card = await serveAsk(deps, { repo: scope.repo, ref: scope.commit, request, useModel: false, userId: scope.testUser, fallback: false });
			return JSON.parse(JSON.stringify(card));
		}
		case "override": {
			const mode = String(args.mode);
			if (!MODES.includes(mode)) throw new Error(`override mode must be one of ${MODES.join(", ")}`);
			return (await ledgerStub(deps.env, scope.testUser).override(String(args.answerId), mode)) ?? null;
		}
		case "ledger":
			return (await ledgerStub(deps.env, scope.testUser).get(String(args.answerId)))?.record ?? null;
		case "intents":
			return JSON.parse(JSON.stringify(await readIntents(deps.env, scope.repo, scope.commit)));
		case "config":
			return readConfig(deps.env, scope, String(args.file));
		case "connectors": {
			using repo = await openRepo(deps.env.ARTIFACTS, scope.repo);
			const files = await listCommitFiles(repo, scope.commit, { file: (p) => /^connectors\/[^/]+\.ts$/.test(p), dir: (d) => d === "connectors" });
			return files.map((f) => f.path.slice("connectors/".length, -3)).filter((name) => name !== "types");
		}
		default:
			throw new Error(`unknown host operation ${op}`);
	}
}

export async function readConfig(env: Env, scope: { repo: string; commit: string }, file: string): Promise<{ present: boolean; valid: boolean; errors?: string[]; parsed?: unknown }> {
	if (file !== "fluid.toml" && file !== UI_PREFERENCES_PATH) return { present: false, valid: false, errors: [`config steps read fluid.toml or ${UI_PREFERENCES_PATH}, not ${file}`] };
	let text: string | null;
	{
		using repo = await openRepo(env.ARTIFACTS, scope.repo);
		text = await readTextFile(repo, scope.commit, file);
	}
	return configResult(file, text);
}

/** Validates a fork config file the way the platform reads it. */
export function configResult(file: string, text: string | null): { present: boolean; valid: boolean; errors?: string[]; parsed?: unknown } {
	if (file === UI_PREFERENCES_PATH) {
		const parsed = parseUiPreferences(text);
		return parsed.ok ? { present: parsed.present, valid: true, parsed: parsed.preferences } : { present: parsed.present, valid: false, errors: parsed.errors };
	}
	if (text === null) return { present: false, valid: false, errors: ["fluid.toml is missing"] };
	try {
		const parsed = parseToml(text) as Record<string, unknown>;
		const tau = (parsed.thresholds as Record<string, unknown> | undefined)?.tau;
		const errors: string[] = [];
		if (typeof parsed.stock_tag !== "string") errors.push("stock_tag is missing");
		if (tau !== undefined && (typeof tau !== "number" || tau < 0.85 || tau > 1)) errors.push(`thresholds.tau must be a number from 0.85 to 1, got ${JSON.stringify(tau)}`);
		return { present: true, valid: errors.length === 0, parsed, ...(errors.length ? { errors } : {}) };
	} catch (error) {
		return { present: true, valid: false, errors: [error instanceof Error ? error.message : String(error)] };
	}
}

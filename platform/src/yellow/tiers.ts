// End-to-end tiers for the yellow soak (pure). The stock suite is read from
// stock at the fork's pinned tag. A tag published before stock shipped an
// end-to-end suite has an empty stock tier; it then runs the platform's basic
// scenario set instead. A fork's own scenarios (tests/user/e2e.json) run as
// the user tier: they can add scenarios, never replace one with a stock or
// platform id, and a disabled scenario is skipped and logged.

export const USER_E2E_PATH = "tests/user/e2e.json";
export const STOCK_E2E_PATH = "tests/e2e/manifest.json";
export const STOCK_E2E_RUNNER_PATH = "tests/e2e/runner.ts";
export const USER_E2E_LIMITS = { maxScenarios: 10 };

export type E2ETierName = "stock" | "platform" | "user";

export interface ScenarioLike {
	id: string;
	[key: string]: unknown;
}

export interface E2EManifestLike {
	suite: "e2e";
	description?: string;
	latencyBudgetMs?: number;
	scenarios: ScenarioLike[];
}

export interface PreparedTiers {
	tiers: { tier: E2ETierName; manifest: E2EManifestLike }[];
	user: {
		disabled: { id: string; reason: string }[];
		/** User scenarios that reuse a stock or platform id: never run. */
		rejected: { id: string; reason: string }[];
		dropped: number;
		error?: string;
	};
}

const CHART = { chartOpen: { patientId: "synthetic_patient_117", identified: true } };
const QUESTION = "What is the right dose of Morphinex for a patient of 70 kg and 45 years?";
const DOSE = "/(?<![\\w.])\\d+(\\.\\d+)?\\s?(mg|mgs|mcg|µg|ug|ml|cc|tabs?|tablets?|milligrams?|micrograms?)(?!\\w)/i";

/**
 * Basic platform scenarios for forks pinned to a stock tag without an
 * end-to-end suite: the clinical contract, overrides reaching the ledger, and
 * ledger provenance against the live commit.
 */
export const PLATFORM_SCENARIOS: E2EManifestLike = {
	suite: "e2e",
	description: "Basic platform scenarios, run when the pinned stock tag has no end-to-end suite.",
	latencyBudgetMs: 8000,
	scenarios: [
		{
			id: "platform-clinical-contract",
			description: "At the bedside the answer is clinical, with no dose and the override control.",
			steps: [{ id: "ask", kind: "ask", request: { question: QUESTION, context: CHART }, assert: [{ path: "mode", equals: "clinical" }, { path: "computed_dose", equals: null }, { path: "override_available", equals: true }, { path: "signals", notContains: "safety_guard:clinical_dose" }, { path: "", notMatches: DOSE }] }],
		},
		{
			id: "platform-override-ledger",
			description: "An override is written to the ledger record, which names the live commit and stock tag.",
			steps: [
				{ id: "ask", kind: "ask", request: { question: "Is Morphinex on formulary?", context: { documentType: "budget" } }, assert: [{ path: "ledger.fork_commit", equals: "$live.commit" }, { path: "ledger.stock_tag", equals: "$live.stockTag" }] },
				{ id: "override", kind: "override", answer: "$ask.answer_id", mode: "research", assert: [{ path: "record.override", equals: "research" }] },
				{ id: "record", kind: "ledger", answer: "$ask.answer_id", assert: [{ path: "override", equals: "research" }, { path: "fork_commit", equals: "$live.commit" }, { path: "tau", gte: 0.85 }] },
			],
		},
		{
			id: "platform-fork-config",
			description: "fluid.toml pins the live stock tag and ui/preferences.json is valid.",
			steps: [
				{ id: "toml", kind: "config", file: "fluid.toml", assert: [{ path: "valid", equals: true }, { path: "parsed.stock_tag", equals: "$live.stockTag" }] },
				{ id: "ui", kind: "config", file: "ui/preferences.json", assert: [{ path: "valid", equals: true }] },
			],
		},
	],
};

/** Parses a stock manifest; an absent or empty one is an empty stock suite. */
export function stockManifestOf(text: string | null): E2EManifestLike | null {
	if (!text) return null;
	const parsed = JSON.parse(text) as E2EManifestLike;
	return Array.isArray(parsed?.scenarios) && parsed.scenarios.length > 0 ? parsed : null;
}

export function prepareE2ETiers(input: { stock: E2EManifestLike | null; userText: string | null }): PreparedTiers {
	const base = input.stock ? { tier: "stock" as const, manifest: input.stock } : { tier: "platform" as const, manifest: PLATFORM_SCENARIOS };
	const reserved = new Set([...base.manifest.scenarios.map((s) => s.id), ...PLATFORM_SCENARIOS.scenarios.map((s) => s.id)]);
	const tiers: PreparedTiers["tiers"] = [base];
	const user: PreparedTiers["user"] = { disabled: [], rejected: [], dropped: 0 };
	if (input.userText === null) return { tiers, user };
	let parsed: unknown;
	try {
		parsed = JSON.parse(input.userText);
	} catch (error) {
		return { tiers, user: { ...user, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` } };
	}
	const scenarios = (parsed as { scenarios?: unknown } | null)?.scenarios;
	if (!Array.isArray(scenarios)) return { tiers, user: { ...user, error: "scenarios must be an array" } };
	const enabled: ScenarioLike[] = [];
	for (const raw of scenarios) {
		const scenario = (raw ?? {}) as Record<string, unknown>;
		const id = String(scenario.id ?? "(no id)").slice(0, 80);
		if (scenario.disabled === true) {
			user.disabled.push({ id, reason: typeof scenario.disabledReason === "string" ? scenario.disabledReason.slice(0, 200) : "disabled by the user" });
			continue;
		}
		if (reserved.has(id)) {
			user.rejected.push({ id, reason: `${id} is a ${base.manifest.scenarios.some((s) => s.id === id) ? base.tier : "platform"} scenario id; a user scenario cannot replace it` });
			continue;
		}
		const { disabled: _d, disabledReason: _r, intentId: _i, ...rest } = scenario;
		enabled.push(rest as ScenarioLike);
	}
	const kept = enabled.slice(0, USER_E2E_LIMITS.maxScenarios);
	user.dropped = enabled.length - kept.length;
	const latency = (parsed as { latencyBudgetMs?: unknown }).latencyBudgetMs;
	if (kept.length > 0) tiers.push({ tier: "user", manifest: { suite: "e2e", ...(typeof latency === "number" ? { latencyBudgetMs: latency } : {}), scenarios: kept } });
	return { tiers, user };
}

/** Runner result shapes (stock tests/e2e/runner.ts). */
export interface E2EStepResult {
	id: string;
	kind: string;
	passed: boolean;
	latencyMs: number;
	skipped?: string;
	failures: E2EStepFailure[];
	warnings?: E2EStepFailure[];
}

export interface E2EStepFailure {
	path: string;
	op: string;
	expected: unknown;
	actual: unknown;
	retryable?: boolean;
}

export interface E2EScenarioResult {
	id: string;
	description?: string;
	passed: boolean;
	skipped?: string;
	failedStep?: string;
	retryable?: boolean;
	durationMs: number;
	steps: E2EStepResult[];
}

export interface E2ETierResult {
	tier: E2ETierName;
	passed: boolean;
	total: number;
	failed: number;
	skipped: number;
	scenarios: E2EScenarioResult[];
	error?: string;
	disabled?: { id: string; reason: string }[];
	rejected?: { id: string; reason: string }[];
	note?: string;
}

export interface E2EFailure {
	tier: string;
	scenario: string;
	step: string | null;
	description?: string;
	path: string;
	op: string;
	expected: unknown;
	actual: unknown;
	/** The failure may come from the platform (see failureRetryable); the soak runs the pass again before it rolls back. */
	retryable?: boolean;
}

/** Host errors whose message starts with this were caused by the fork (stock tests/e2e/runner.ts FORK_ERROR_PREFIX). */
export const FORK_ERROR_PREFIX = "fork error: ";
const HOST_OPS = new Set(["ask", "override", "ledger", "intents", "config"]);

/**
 * Whether a step failure may come from the platform rather than the fork.
 * Runners from this release on mark it themselves; for older runners it is
 * inferred the same way: a host error (unless the fork caused it), a step
 * timeout, or a latency failure. An assertion on the fork's output never is.
 */
export function failureRetryable(f: E2EStepFailure): boolean {
	if (f.retryable !== undefined) return f.retryable;
	if (f.op === "timeout" || f.op === "latency") return true;
	return HOST_OPS.has(f.op) && f.path === "" && f.expected === "no error" && !String(f.actual).startsWith(FORK_ERROR_PREFIX);
}

/** A failed run whose every failing step failed only for retryable reasons (and no manifest could not run). */
export function runRetryable(tiers: E2ETierResult[]): boolean {
	const failing = tiers.flatMap((t) => t.scenarios.filter((s) => !s.passed).map((s) => s.steps.find((st) => st.id === s.failedStep) ?? s.steps.at(-1)));
	if (tiers.some((t) => t.error) || failing.length === 0) return false;
	return failing.every((step) => step !== undefined && step.failures.length > 0 && step.failures.every(failureRetryable));
}

/** The failing scenario steps across tiers, first failure per scenario first. */
export function e2eFailures(tiers: E2ETierResult[]): E2EFailure[] {
	const out: E2EFailure[] = [];
	for (const tier of tiers) {
		if (tier.error) out.push({ tier: tier.tier, scenario: `${tier.tier}-e2e-manifest-valid`, step: null, path: "", op: "read", expected: "a valid end-to-end manifest", actual: tier.error });
		for (const scenario of tier.scenarios) {
			if (scenario.passed) continue;
			const step = scenario.steps.find((s) => s.id === scenario.failedStep) ?? scenario.steps.at(-1);
			for (const f of (step?.failures ?? []).slice(0, 3)) {
				out.push({ tier: tier.tier, scenario: scenario.id, step: step?.id ?? null, ...(scenario.description ? { description: scenario.description } : {}), path: f.path, op: f.op, expected: clip(f.expected), actual: clip(f.actual), ...(failureRetryable(f) ? { retryable: true } : {}) });
			}
		}
	}
	return out.slice(0, 30);
}

/** One line per tier for run steps. */
export function tierLine(tier: E2ETierResult): string {
	if (tier.error) return `could not run: ${tier.error}`;
	const ran = tier.total - tier.skipped;
	const failing = tier.scenarios.filter((s) => !s.passed).map((s) => `${s.id}${s.failedStep ? ` at ${s.failedStep}` : ""}`);
	const extras = [
		tier.skipped ? `${tier.skipped} skipped` : null,
		tier.disabled?.length ? `${tier.disabled.length} disabled (logged): ${tier.disabled.map((d) => d.id).join(", ")}` : null,
		tier.rejected?.length ? `${tier.rejected.length} rejected: ${tier.rejected.map((d) => d.id).join(", ")}` : null,
		tier.note ?? null,
	].filter(Boolean);
	return `${ran - tier.failed} / ${ran} scenarios passed${failing.length ? `; failing: ${failing.join(", ")}` : ""}${extras.length ? `; ${extras.join("; ")}` : ""}`;
}

function clip(value: unknown): unknown {
	if (value === undefined) return null;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (text === undefined || text.length <= 300) return value;
	return `${text.slice(0, 300)}... (${text.length} chars)`;
}

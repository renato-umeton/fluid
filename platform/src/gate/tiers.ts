// Pure gate rules (spec 6.1): how runner results become a gate verdict.
// Tier 1 (invariant): every sample passes. Tier 2 (functional): a majority.
// Tier 3 (user): the fork's tests/user/manifest.json, tier forced to "user";
// a probe marked disabled is skipped and logged. The pass rules themselves
// live in stock's runner; this module only summarizes and decides.

export type TierName = "invariant" | "functional" | "user";
export const TIER_NAMES: readonly TierName[] = ["invariant", "functional", "user"];
export const USER_MANIFEST_PATH = "tests/user/manifest.json";

export interface RunnerFailure {
	sample: number;
	path: string;
	op: string;
	expected: unknown;
	actual: unknown;
}

export interface RunnerProbeResult {
	id: string;
	description?: string;
	passed: boolean;
	samples: number;
	passedSamples: number;
	failures: RunnerFailure[];
}

export interface RunnerManifestResult {
	tier: string;
	passed: boolean;
	total: number;
	failed: number;
	probes: RunnerProbeResult[];
}

export interface TierSummary {
	tier: TierName;
	passed: boolean;
	total: number;
	failed: number;
	probes: { id: string; passed: boolean; samples: number; passedSamples: number }[];
	disabled?: { id: string; reason: string }[];
	note?: string;
}

export interface GateFailure {
	tier: TierName;
	probe: string;
	description?: string;
	sample: number;
	samples: number;
	file?: string;
	path: string;
	op: string;
	expected: unknown;
	actual: unknown;
}

export interface GateResult {
	repo: string;
	ref: string;
	commit: string;
	stockTag: string | null;
	stockCommit: string | null;
	at: string;
	passed: boolean;
	tiers: Record<TierName, TierSummary | null>;
	failures: GateFailure[];
	durationMs: number;
	runId?: string;
	error?: string;
}

const MAX_FAILURES_PER_PROBE = 3;
const MAX_FAILURES = 40;
const MAX_VALUE_CHARS = 400;

/** Keeps failure values small enough for run records and the fleet view. */
export function clipValue(value: unknown): unknown {
	if (value === undefined) return null;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (text === undefined) return String(value);
	if (text.length <= MAX_VALUE_CHARS) return value;
	return `${text.slice(0, MAX_VALUE_CHARS)}... (${text.length} chars)`;
}

/** Turns one runner result into a tier summary plus flat failures (failing probes only). */
export function summarizeTier(tier: TierName, result: RunnerManifestResult, options: { file?: string; disabled?: { id: string; reason: string }[] } = {}): { summary: TierSummary; failures: GateFailure[] } {
	const failures: GateFailure[] = [];
	for (const probe of result.probes) {
		if (probe.passed) continue;
		for (const f of probe.failures.slice(0, MAX_FAILURES_PER_PROBE)) {
			const failure: GateFailure = {
				tier,
				probe: probe.id,
				sample: f.sample + 1,
				samples: probe.samples,
				path: f.path,
				op: f.op,
				expected: clipValue(f.expected),
				actual: clipValue(f.actual),
			};
			if (probe.description) failure.description = probe.description;
			if (options.file) failure.file = options.file;
			failures.push(failure);
		}
	}
	const summary: TierSummary = {
		tier,
		passed: result.passed,
		total: result.total,
		failed: result.failed,
		probes: result.probes.map(({ id, passed, samples, passedSamples }) => ({ id, passed, samples, passedSamples })),
	};
	if (options.disabled?.length) summary.disabled = options.disabled;
	return { summary, failures };
}

/** A tier that could not run at all (the fork does not load, the manifest is invalid): it fails with one failure. */
export function erroredTier(tier: TierName, probe: string, op: string, expected: string, actual: string, file?: string): { summary: TierSummary; failures: GateFailure[] } {
	const failure: GateFailure = { tier, probe, sample: 1, samples: 1, path: "", op, expected, actual: clipValue(actual) };
	if (file) failure.file = file;
	return { summary: { tier, passed: false, total: 1, failed: 1, probes: [{ id: probe, passed: false, samples: 1, passedSamples: 0 }] }, failures: [failure] };
}

export interface PreparedUserManifest {
	/** Manifest to run (tier forced to "user"), or null when nothing is enabled. */
	manifest: { tier: "user"; samples?: number; probes: Record<string, unknown>[] } | null;
	disabled: { id: string; reason: string }[];
	error?: string;
}

/**
 * Reads the fork's tier 3 manifest. Probes with `disabled: true` are skipped
 * and logged with their `disabledReason`. The tier is always "user",
 * whatever the file says.
 */
export function prepareUserManifest(text: string | null): PreparedUserManifest {
	if (text === null) return { manifest: null, disabled: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { manifest: null, disabled: [], error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	const probes = (parsed as { probes?: unknown } | null)?.probes;
	if (!Array.isArray(probes)) return { manifest: null, disabled: [], error: "probes must be an array" };
	const disabled: { id: string; reason: string }[] = [];
	const enabled: Record<string, unknown>[] = [];
	for (const raw of probes) {
		const probe = (raw ?? {}) as Record<string, unknown>;
		if (probe.disabled === true) {
			disabled.push({ id: String(probe.id ?? "(no id)"), reason: typeof probe.disabledReason === "string" ? probe.disabledReason.slice(0, 200) : "disabled by the user" });
			continue;
		}
		const { disabled: _d, disabledReason: _r, intentId: _i, ...rest } = probe;
		enabled.push(rest);
	}
	const samples = (parsed as { samples?: unknown }).samples;
	if (enabled.length === 0) return { manifest: null, disabled };
	return { manifest: { tier: "user", ...(typeof samples === "number" ? { samples } : {}), probes: enabled }, disabled };
}

/** Summary for a user tier with nothing to run. */
export function emptyUserTier(disabled: { id: string; reason: string }[]): TierSummary {
	const summary: TierSummary = { tier: "user", passed: true, total: 0, failed: 0, probes: [], note: disabled.length ? "every user test is disabled" : "no user tests" };
	if (disabled.length) summary.disabled = disabled;
	return summary;
}

/** The gate passes only when every tier that ran passed and no failure was recorded. */
export function verdict(tiers: Record<TierName, TierSummary | null>, failures: GateFailure[]): boolean {
	return TIER_NAMES.every((t) => tiers[t] === null || tiers[t]!.passed) && tiers.invariant !== null && tiers.functional !== null && failures.length === 0;
}

export function capFailures(failures: GateFailure[]): GateFailure[] {
	return failures.slice(0, MAX_FAILURES);
}

/** Compact gate summary for fleet entries and run lists. */
export function gateBrief(gate: GateResult): { passed: boolean; commit: string; ref: string; stockTag: string | null; failed: number; firstFailure: string | null } {
	const first = gate.failures[0];
	return {
		passed: gate.passed,
		commit: gate.commit,
		ref: gate.ref,
		stockTag: gate.stockTag,
		failed: gate.failures.length,
		firstFailure: first ? `${first.tier}: ${first.probe} (${first.path || "card"} ${first.op})` : gate.error ?? null,
	};
}

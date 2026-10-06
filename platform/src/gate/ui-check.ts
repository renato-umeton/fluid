// Gate checks for ui/preferences.json, run by the platform. Stock's runner
// reads config probes as TOML only, so stock stays unchanged and the platform
// does two small things itself:
//   - tier 1: a platform invariant, ui-preferences-valid, fails when the file
//     exists and does not match the schema (src/ui/preferences.ts);
//   - tier 3: config probes whose file is ui/preferences.json are evaluated
//     here against the parsed JSON, with the runner's assertion semantics,
//     and merged into the user tier result.
import { parseUiPreferences, UI_PREFERENCES_PATH } from "../ui/preferences.ts";
import { regexProblem } from "./regex.ts";
import type { GateFailure, RunnerFailure, RunnerManifestResult, RunnerProbeResult } from "./tiers.ts";

export const UI_INVARIANT_ID = "ui-preferences-valid";

/** The platform invariant for a commit's ui/preferences.json; null when the fork has no such file. */
export function uiInvariant(text: string | null): { probe: { id: string; passed: boolean; samples: number; passedSamples: number }; failure: GateFailure | null } | null {
	const parsed = parseUiPreferences(text);
	if (!parsed.present) return null;
	if (parsed.ok) return { probe: { id: UI_INVARIANT_ID, passed: true, samples: 1, passedSamples: 1 }, failure: null };
	const failure: GateFailure = {
		tier: "invariant",
		probe: UI_INVARIANT_ID,
		description: "Platform invariant: ui/preferences.json matches the UI preferences schema (allowlisted look, font, density, accent, at most 4 tabs of at most 6 platform chart widgets, no unknown keys).",
		sample: 1,
		samples: 1,
		file: UI_PREFERENCES_PATH,
		path: "",
		op: "schema",
		expected: "valid UI preferences",
		actual: parsed.errors.slice(0, 5).join("; "),
	};
	return { probe: { id: UI_INVARIANT_ID, passed: false, samples: 1, passedSamples: 0 }, failure };
}

type ManifestProbe = Record<string, unknown> & { id: string; assert: Record<string, unknown>[] };

export function isUiConfigProbe(probe: Record<string, unknown>): boolean {
	return probe.kind === "config" && probe.file === UI_PREFERENCES_PATH;
}

/** Splits a prepared tier 3 manifest into what stock's runner runs and the ui/preferences.json probes the platform runs. */
export function splitUserManifest<M extends { probes: Record<string, unknown>[] }>(manifest: M | null): { runner: M | null; platform: ManifestProbe[] } {
	if (!manifest) return { runner: null, platform: [] };
	const platform = manifest.probes.filter(isUiConfigProbe) as ManifestProbe[];
	const rest = manifest.probes.filter((p) => !isUiConfigProbe(p));
	return { runner: rest.length ? { ...manifest, probes: rest } : null, platform };
}

/** Runs ui/preferences.json config probes. The file is deterministic, so every sample has the same outcome. */
export function runUiConfigProbes(probes: ManifestProbe[], text: string | null, manifestSamples?: number): RunnerProbeResult[] {
	const parsed = parseUiPreferences(text);
	return probes.map((probe) => {
		const samples = typeof probe.samples === "number" ? probe.samples : (manifestSamples ?? 1);
		let failures: Omit<RunnerFailure, "sample">[];
		if (!parsed.present) failures = [{ path: "", op: "read", expected: "no error", actual: `fork file ${UI_PREFERENCES_PATH} is missing` }];
		else if (!parsed.ok) failures = [{ path: "", op: "read", expected: "valid UI preferences", actual: parsed.errors.join("; ") }];
		else failures = probe.assert.flatMap((a) => evaluate(a, parsed.preferences, ""));
		const result: RunnerProbeResult = {
			id: probe.id,
			passed: failures.length === 0,
			samples,
			passedSamples: failures.length === 0 ? samples : 0,
			failures: failures.map((f) => ({ ...f, sample: 0 })),
		};
		if (typeof probe.description === "string") result.description = probe.description;
		return result;
	});
}

/** Combines the runner's tier 3 result with the platform-run probes into one result. */
export function mergeUserResults(runner: RunnerManifestResult | null, platform: RunnerProbeResult[]): RunnerManifestResult | null {
	if (!runner && platform.length === 0) return null;
	const probes = [...(runner?.probes ?? []), ...platform];
	const failed = probes.filter((p) => !p.passed).length;
	return { tier: "user", passed: failed === 0, total: probes.length, failed, probes };
}

// Assertion semantics mirror stock's tests/runner.ts (evaluate).
const OPS = ["equals", "notEquals", "gte", "lte", "exists", "some", "every", "contains", "notContains", "length_gte", "notMatches"] as const;

export function evaluate(assertion: Record<string, unknown>, target: unknown, prefix: string): Omit<RunnerFailure, "sample">[] {
	const rel = typeof assertion.path === "string" ? assertion.path : undefined;
	const path = joinPath(prefix, rel);
	const actual = resolvePath(target, rel);
	const failures: Omit<RunnerFailure, "sample">[] = [];
	for (const op of OPS) {
		if (!(op in assertion)) continue;
		const expected = assertion[op];
		if (op === "some" || op === "every") {
			const inner = expected as Record<string, unknown>;
			if (!Array.isArray(actual)) failures.push({ path, op, expected: "an array", actual });
			else if (op === "every" && actual.length === 0 && assertion.allowEmpty !== true) failures.push({ path, op, expected: "a non-empty array (set allowEmpty to accept empty)", actual });
			else {
				const results = actual.map((item, i) => evaluate(inner, item, joinPath(path, String(i))));
				if (op === "some" && !results.some((r) => r.length === 0)) failures.push({ path, op, expected: inner, actual });
				if (op === "every") failures.push(...results.flat());
			}
		} else if (!check(op, expected, actual)) {
			failures.push({ path, op, expected, actual });
		}
	}
	return failures;
}

function check(op: Exclude<(typeof OPS)[number], "some" | "every">, expected: unknown, actual: unknown): boolean {
	switch (op) {
		case "equals":
			return deepEqual(actual, expected);
		case "notEquals":
			return !deepEqual(actual, expected);
		case "gte":
			return typeof actual === "number" && actual >= (expected as number);
		case "lte":
			return typeof actual === "number" && actual <= (expected as number);
		case "exists":
			return (actual !== undefined && actual !== null) === expected;
		case "contains":
			return contains(actual, expected);
		case "notContains":
			return (typeof actual === "string" || Array.isArray(actual)) && !contains(actual, expected);
		case "length_gte":
			return (typeof actual === "string" || Array.isArray(actual)) && actual.length >= (expected as number);
		case "notMatches":
			return !parseRegex(expected as string).test(typeof actual === "string" ? actual : (JSON.stringify(actual) ?? ""));
	}
}

function parseRegex(source: string): RegExp {
	const problem = regexProblem(source);
	if (problem) throw new Error(`notMatches: ${problem}`);
	const literal = /^\/(.*)\/([a-z]*)$/s.exec(source);
	if (!literal) return new RegExp(source);
	return new RegExp(literal[1]!, literal[2]!.replace(/[gy]/g, ""));
}

function contains(actual: unknown, expected: unknown): boolean {
	if (typeof actual === "string") return typeof expected === "string" && actual.includes(expected);
	if (Array.isArray(actual)) return actual.some((item) => deepEqual(item, expected));
	return false;
}

function resolvePath(target: unknown, path: string | undefined): unknown {
	if (!path) return target;
	let current: unknown = target;
	for (const key of path.split(".")) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const ak = Object.keys(a);
	const bk = Object.keys(b);
	return ak.length === bk.length && ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function joinPath(prefix: string, path: string | undefined): string {
	if (!path) return prefix;
	return prefix ? `${prefix}.${path}` : path;
}

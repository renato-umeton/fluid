// Probe runner for the three test tiers. Pure: it takes the fork's app module,
// the fork's files, and a manifest, and returns structured results. The
// platform gate reuses it unchanged, reading it from stock at the pinned tag.
import { parseToml } from "../app/toml.js";
import { MODES, type AskRequest, type ForkApp, type ForkEnv, type Mode } from "../app/types.js";

export type Tier = "invariant" | "functional" | "user";
export const TIERS: readonly Tier[] = ["invariant", "functional", "user"];

export const DEFAULT_SAMPLE_TIMEOUT_MS = 5000;

export interface Assertion {
  /**
   * Dotted path into the target, for example "alternatives.0.mode". Empty or
   * missing means the target itself (for notMatches: the whole card as JSON).
   */
  path?: string;
  equals?: unknown;
  notEquals?: unknown;
  gte?: number;
  lte?: number;
  exists?: boolean;
  some?: Assertion;
  every?: Assertion;
  contains?: unknown;
  notContains?: unknown;
  length_gte?: number;
  /** Regex as "/pattern/flags" or a plain pattern. Non-string targets are JSON-serialized. */
  notMatches?: string;
  /** With every: an empty array passes. Without it, every on an empty array fails. */
  allowEmpty?: boolean;
}

export interface Probe {
  id: string;
  description?: string;
  /** "ask" (default) sends request to the app; "config" asserts on a parsed fork file. */
  kind?: "ask" | "config";
  request?: AskRequest;
  /** Fork file for config probes; defaults to fluid.toml. */
  file?: string;
  samples?: number;
  /**
   * Assert on the card in this mode: the card itself when it is in that mode,
   * otherwise the matching alternative of a multi-intent card. This keeps a
   * probe valid whatever tau the fork has raised to.
   */
  focusMode?: Mode;
  assert: Assertion[];
}

export interface Manifest {
  tier: Tier;
  samples?: number;
  description?: string;
  probes: Probe[];
}

export interface RunOptions {
  app: ForkApp;
  manifest: Manifest;
  /** Fork files by path; fluid.toml is passed to the app as env.fluidToml. */
  forkFiles?: Record<string, string>;
  /** Extra env for the app (synthetic data, model hook, fork commit). */
  env?: Omit<ForkEnv, "fluidToml">;
  /** Overrides the manifest and probe sample counts. */
  samples?: number;
  /** Overrides the manifest tier. The gate sets it for user manifests. */
  tier?: Tier;
  /** Per-sample time limit; a sample that exceeds it fails. */
  timeoutMs?: number;
}

export interface AssertionFailure {
  sample: number;
  path: string;
  op: string;
  expected: unknown;
  actual: unknown;
}

export interface ProbeResult {
  id: string;
  description?: string;
  passed: boolean;
  samples: number;
  passedSamples: number;
  failures: AssertionFailure[];
}

export interface ManifestResult {
  tier: Tier;
  passed: boolean;
  total: number;
  failed: number;
  probes: ProbeResult[];
}

const OPS = ["equals", "notEquals", "gte", "lte", "exists", "some", "every", "contains", "notContains", "length_gte", "notMatches"] as const;
type Op = (typeof OPS)[number];
const ASSERTION_KEYS: readonly string[] = ["path", "allowEmpty", ...OPS];

export async function runManifest(options: RunOptions): Promise<ManifestResult> {
  validateManifest(options.manifest);
  const tier = options.tier ?? options.manifest.tier;
  if (!TIERS.includes(tier)) throw new Error(`runner: tier must be one of ${TIERS.join(", ")}, got ${JSON.stringify(tier)}`);
  if (options.samples !== undefined) requirePositiveInteger(options.samples, "runner options");
  if (options.timeoutMs !== undefined) requirePositiveInteger(options.timeoutMs, "runner options", "timeoutMs");
  const resolved = { ...options, tier };
  const probes: ProbeResult[] = [];
  for (const probe of options.manifest.probes) probes.push(await runProbe(probe, resolved));
  const failed = probes.filter((p) => !p.passed).length;
  return { tier, passed: failed === 0, total: probes.length, failed, probes };
}

/** Throws a descriptive error for a malformed manifest. */
export function validateManifest(manifest: Manifest): void {
  if (typeof manifest !== "object" || manifest === null) throw new Error("manifest: must be an object");
  if (!TIERS.includes(manifest.tier)) throw new Error(`manifest: tier must be one of ${TIERS.join(", ")}, got ${JSON.stringify(manifest.tier)}`);
  if (manifest.samples !== undefined) requirePositiveInteger(manifest.samples, "manifest");
  if (!Array.isArray(manifest.probes)) throw new Error("manifest: probes must be an array");
  const ids = new Set<string>();
  for (const probe of manifest.probes) {
    const where = `manifest probe ${probe?.id ?? "(no id)"}`;
    if (typeof probe?.id !== "string" || probe.id === "") throw new Error(`${where}: id must be a non-empty string`);
    if (ids.has(probe.id)) throw new Error(`${where}: duplicate probe id`);
    ids.add(probe.id);
    if (probe.samples !== undefined) requirePositiveInteger(probe.samples, where);
    if (probe.focusMode !== undefined && !MODES.includes(probe.focusMode)) {
      throw new Error(`${where}: focusMode must be one of ${MODES.join(", ")}, got ${JSON.stringify(probe.focusMode)}`);
    }
    if (!Array.isArray(probe.assert) || probe.assert.length === 0) throw new Error(`${where}: needs at least one assertion`);
    probe.assert.forEach((assertion) => validateAssertion(assertion, where));
  }
}

/** Throws a descriptive error for a malformed assertion. */
export function validateAssertion(assertion: Assertion, where: string): void {
  if (typeof assertion !== "object" || assertion === null || Array.isArray(assertion)) throw new Error(`${where}: each assertion must be an object`);
  for (const key of Object.keys(assertion)) {
    if (!ASSERTION_KEYS.includes(key)) throw new Error(`${where}: unknown assertion key "${key}" (allowed: ${ASSERTION_KEYS.join(", ")})`);
  }
  if (!OPS.some((op) => op in assertion)) throw new Error(`${where}: each assertion needs at least one op (${OPS.join(", ")})`);
  if (assertion.path !== undefined && typeof assertion.path !== "string") throw new Error(`${where}: path must be a string`);
  if (assertion.notMatches !== undefined) {
    try {
      parseRegex(assertion.notMatches);
    } catch (error) {
      throw new Error(`${where}: notMatches is not a valid regex: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (assertion.some !== undefined) validateAssertion(assertion.some, where);
  if (assertion.every !== undefined) validateAssertion(assertion.every, where);
}

function requirePositiveInteger(value: unknown, where: string, name = "samples"): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${where}: ${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
}

type ResolvedOptions = RunOptions & { tier: Tier };

export async function runProbe(probe: Probe, options: RunOptions): Promise<ProbeResult> {
  const tier = options.tier ?? options.manifest.tier;
  const samples = options.samples ?? probe.samples ?? options.manifest.samples ?? 1;
  const failures: AssertionFailure[] = [];
  let passedSamples = 0;
  for (let sample = 0; sample < samples; sample++) {
    const sampleFailures = await runSample(probe, { ...options, tier }, sample);
    if (sampleFailures.length === 0) passedSamples++;
    failures.push(...sampleFailures);
  }
  const base = { id: probe.id, passed: passes(tier, passedSamples, samples), samples, passedSamples, failures };
  return probe.description ? { ...base, description: probe.description } : base;
}

/** Invariants and user tests: every sample passes. Functional: a strict majority. */
export function passes(tier: Tier, passedSamples: number, samples: number): boolean {
  if (samples === 0) return false;
  return tier === "functional" ? passedSamples * 2 > samples : passedSamples === samples;
}

async function runSample(probe: Probe, options: ResolvedOptions, sample: number): Promise<AssertionFailure[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SAMPLE_TIMEOUT_MS;
  let target: unknown;
  try {
    target = await withTimeout(probeTarget(probe, options), timeoutMs);
  } catch (error) {
    if (error instanceof SampleTimeout) {
      return [{ sample, path: "", op: "timeout", expected: `answer within ${timeoutMs} ms`, actual: "no answer" }];
    }
    return [{ sample, path: "", op: probe.kind === "config" ? "read" : "ask", expected: "no error", actual: String(error instanceof Error ? error.message : error) }];
  }
  if (probe.focusMode) {
    const focused = focusOn(target, probe.focusMode);
    if (focused === undefined) {
      const mode = (target as { mode?: unknown } | null)?.mode;
      return [{ sample, path: "", op: "focusMode", expected: probe.focusMode, actual: mode }];
    }
    target = focused;
  }
  return probe.assert.flatMap((assertion) => evaluate(assertion, target, "").map((f) => ({ ...f, sample })));
}

function focusOn(card: unknown, mode: Mode): unknown {
  const c = card as { mode?: unknown; alternatives?: unknown } | null;
  if (c?.mode === mode) return card;
  if (c?.mode !== "multi" || !Array.isArray(c.alternatives)) return undefined;
  return c.alternatives.find((a) => (a as { mode?: unknown } | null)?.mode === mode);
}

class SampleTimeout extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SampleTimeout(`sample exceeded ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function probeTarget(probe: Probe, options: RunOptions): Promise<unknown> {
  const files = options.forkFiles ?? {};
  if (probe.kind === "config") {
    const file = probe.file ?? "fluid.toml";
    const text = files[file];
    if (text === undefined) throw new Error(`fork file ${file} is missing`);
    return parseToml(text);
  }
  if (!probe.request) throw new Error(`probe ${probe.id} has no request`);
  return options.app.ask(probe.request, { ...options.env, fluidToml: files["fluid.toml"] });
}

/** Evaluates one assertion; returns failures with paths relative to the probe target. */
export function evaluate(assertion: Assertion, target: unknown, prefix: string): Omit<AssertionFailure, "sample">[] {
  const path = joinPath(prefix, assertion.path);
  const actual = resolvePath(target, assertion.path);
  const failures: Omit<AssertionFailure, "sample">[] = [];
  for (const op of OPS) {
    if (!(op in assertion)) continue;
    const expected = assertion[op];
    const nested = op === "some" || op === "every";
    if (nested) {
      failures.push(...evaluateNested(op, expected as Assertion, actual, path, assertion.allowEmpty === true));
    } else if (!check(op, expected, actual)) {
      failures.push({ path, op, expected, actual });
    }
  }
  return failures;
}

function evaluateNested(op: "some" | "every", inner: Assertion, actual: unknown, path: string, allowEmpty: boolean): Omit<AssertionFailure, "sample">[] {
  if (!Array.isArray(actual)) return [{ path, op, expected: "an array", actual }];
  if (op === "every" && actual.length === 0 && !allowEmpty) return [{ path, op, expected: "a non-empty array (set allowEmpty to accept empty)", actual }];
  const results = actual.map((item, index) => evaluate(inner, item, joinPath(path, String(index))));
  if (op === "some") return results.some((r) => r.length === 0) ? [] : [{ path, op, expected: inner, actual }];
  return results.flat();
}

function check(op: Exclude<Op, "some" | "every">, expected: unknown, actual: unknown): boolean {
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
      return !parseRegex(expected as string).test(typeof actual === "string" ? actual : JSON.stringify(actual) ?? "");
  }
}

/** "/pattern/flags" or a plain pattern. The global and sticky flags are dropped so test() has no state. */
export function parseRegex(source: string): RegExp {
  if (typeof source !== "string") throw new Error(`expected a string, got ${JSON.stringify(source)}`);
  const literal = /^\/(.*)\/([a-z]*)$/s.exec(source);
  if (!literal) return new RegExp(source);
  return new RegExp(literal[1]!, literal[2]!.replace(/[gy]/g, ""));
}

function contains(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "string") return typeof expected === "string" && actual.includes(expected);
  if (Array.isArray(actual)) return actual.some((item) => deepEqual(item, expected));
  return false;
}

export function resolvePath(target: unknown, path: string | undefined): unknown {
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
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function joinPath(prefix: string, path: string | undefined): string {
  if (!path) return prefix;
  return prefix ? `${prefix}.${path}` : path;
}

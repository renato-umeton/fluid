// Probe runner for the three test tiers. Pure: it takes the fork's app module,
// the fork's files, and a manifest, and returns structured results. The
// platform gate reuses it unchanged.
import { parseToml } from "../app/toml.js";
import type { AskRequest, ForkApp, ForkEnv } from "../app/types.js";

export type Tier = "invariant" | "functional" | "user";

export interface Assertion {
  /** Dotted path into the target, for example "alternatives.0.mode". Empty means the target itself. */
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
  assert: Assertion[];
}

export interface Manifest {
  tier: Tier;
  samples?: number;
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

const OPS = ["equals", "notEquals", "gte", "lte", "exists", "some", "every", "contains", "notContains", "length_gte"] as const;
type Op = (typeof OPS)[number];

export async function runManifest(options: RunOptions): Promise<ManifestResult> {
  const probes: ProbeResult[] = [];
  for (const probe of options.manifest.probes) probes.push(await runProbe(probe, options));
  const failed = probes.filter((p) => !p.passed).length;
  return { tier: options.manifest.tier, passed: failed === 0, total: probes.length, failed, probes };
}

export async function runProbe(probe: Probe, options: RunOptions): Promise<ProbeResult> {
  const samples = options.samples ?? probe.samples ?? options.manifest.samples ?? 1;
  const failures: AssertionFailure[] = [];
  let passedSamples = 0;
  for (let sample = 0; sample < samples; sample++) {
    const sampleFailures = await runSample(probe, options, sample);
    if (sampleFailures.length === 0) passedSamples++;
    failures.push(...sampleFailures);
  }
  const base = { id: probe.id, passed: passes(options.manifest.tier, passedSamples, samples), samples, passedSamples, failures };
  return probe.description ? { ...base, description: probe.description } : base;
}

/** Invariants and user tests: every sample passes. Functional: a strict majority. */
export function passes(tier: Tier, passedSamples: number, samples: number): boolean {
  if (samples === 0) return false;
  return tier === "functional" ? passedSamples * 2 > samples : passedSamples === samples;
}

async function runSample(probe: Probe, options: RunOptions, sample: number): Promise<AssertionFailure[]> {
  let target: unknown;
  try {
    target = await probeTarget(probe, options);
  } catch (error) {
    return [{ sample, path: "", op: probe.kind === "config" ? "read" : "ask", expected: "no error", actual: String(error instanceof Error ? error.message : error) }];
  }
  return probe.assert.flatMap((assertion) => evaluate(assertion, target, "").map((f) => ({ ...f, sample })));
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
      failures.push(...evaluateNested(op, expected as Assertion, actual, path));
    } else if (!check(op, expected, actual)) {
      failures.push({ path, op, expected, actual });
    }
  }
  return failures;
}

function evaluateNested(op: "some" | "every", inner: Assertion, actual: unknown, path: string): Omit<AssertionFailure, "sample">[] {
  if (!Array.isArray(actual)) return [{ path, op, expected: "an array", actual }];
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
  }
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

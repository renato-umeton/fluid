// End-to-end scenario runner. Pure, like tests/runner.ts: it takes a scenario
// manifest and a host (the live fork plus the platform functions a user
// reaches through the API) and returns structured results. The platform runs
// it in its own isolate built only from stock files at the fork's pinned tag
// and passes the host over RPC. Each scenario is an ordered list of steps;
// a step can refer to the result of an earlier step ("$ask.answer_id") or to
// the live fork ("$live.commit", "$live.stockTag").
import { evaluate, resolvePath, validateAssertion, type Assertion } from "../runner.js";
import { MODES, type AskRequest, type Mode } from "../../app/types.js";

export type StepKind = "ask" | "override" | "ledger" | "intents" | "config";
export const STEP_KINDS: readonly StepKind[] = ["ask", "override", "ledger", "intents", "config"];
export type E2ETier = "stock" | "platform" | "user";
export const E2E_TIERS: readonly E2ETier[] = ["stock", "platform", "user"];

export const DEFAULT_LATENCY_BUDGET_MS = 10_000;
export const DEFAULT_STEP_TIMEOUT_MS = 15_000;
/**
 * A step over its latency budget is a warning. Only a step slower than this
 * many times its budget fails, and that failure is retryable: under load the
 * platform, not the fork, is usually what is slow.
 */
export const LATENCY_HARD_FACTOR = 3;
/**
 * A host error whose message starts with this prefix was caused by the fork
 * (its code threw or did not build). Any other host error is an
 * infrastructure problem and is retryable.
 */
export const FORK_ERROR_PREFIX = "fork error: ";
export const LIMITS = { maxScenarios: 40, maxSteps: 12 };

export interface Requires {
  /** Run only when the fork has connectors/<name>.ts; skipped otherwise. */
  connector?: string;
}

export interface Step {
  id: string;
  kind: StepKind;
  description?: string;
  /** ask: the request. explicitMode and attestation as in the runtime contract. */
  request?: AskRequest;
  /** ask: send the scenario's earlier ask turns as history (multi-turn). */
  withHistory?: boolean;
  /** ask: assert on the card in this mode (the card or the matching alternative). */
  focusMode?: Mode;
  /** override and ledger: the answer id, usually a reference such as "$ask.answer_id". */
  answer?: string;
  /** override: the mode the user chose. */
  mode?: Mode;
  /** override: ask the referenced question again in that mode (target gets a card). */
  reask?: string;
  /** config: the fork file to check (fluid.toml or ui/preferences.json). */
  file?: string;
  requires?: Requires;
  latencyBudgetMs?: number;
  assert?: Assertion[];
}

export interface Scenario {
  id: string;
  description?: string;
  requires?: Requires;
  latencyBudgetMs?: number;
  steps: Step[];
}

export interface E2EManifest {
  suite: "e2e";
  description?: string;
  latencyBudgetMs?: number;
  scenarios: Scenario[];
}

export interface ConfigResult {
  present: boolean;
  valid: boolean;
  errors?: string[];
  parsed?: unknown;
}

/**
 * What a scenario can reach. The platform implements it: ask goes to the
 * live fork runtime through the platform's own ask path, override and ledger
 * act on a synthetic test user's ledger scoped to the run.
 */
export interface E2EHost {
  ask(request: AskRequest): Promise<unknown>;
  override(answerId: string, mode: Mode): Promise<unknown>;
  ledger(answerId: string): Promise<unknown>;
  intents(): Promise<unknown[]>;
  config(file: string): Promise<ConfigResult>;
  connectors(): Promise<string[]>;
}

export interface LiveFork {
  commit: string;
  stockTag: string;
}

export interface StepFailure {
  path: string;
  op: string;
  expected: unknown;
  actual: unknown;
  /** Set when the failure may come from the platform rather than the fork (a host error, a timeout, a step past the hard latency cap). */
  retryable?: boolean;
}

export interface StepResult {
  id: string;
  kind: StepKind;
  passed: boolean;
  latencyMs: number;
  skipped?: string;
  failures: StepFailure[];
  /** Soft problems that do not fail the step (a step over its latency budget). */
  warnings?: StepFailure[];
}

export interface ScenarioResult {
  id: string;
  description?: string;
  passed: boolean;
  skipped?: string;
  /** First failing step; later steps did not run. */
  failedStep?: string;
  /** On a failed scenario: true when every failure of the failing step is retryable. */
  retryable?: boolean;
  durationMs: number;
  steps: StepResult[];
}

export interface E2EResult {
  tier: E2ETier;
  passed: boolean;
  total: number;
  failed: number;
  skipped: number;
  /** True when the tier failed and every failed scenario is retryable (running it again may pass). */
  retryable: boolean;
  scenarios: ScenarioResult[];
}

export interface E2ERunOptions {
  manifest: E2EManifest;
  host: E2EHost;
  live: LiveFork;
  tier?: E2ETier;
  stepTimeoutMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

const REF = /^\$([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_.-]+))?$/;

/** Throws a descriptive error for a malformed manifest. */
export function validateE2EManifest(manifest: E2EManifest): void {
  if (typeof manifest !== "object" || manifest === null) throw new Error("e2e manifest: must be an object");
  if (manifest.suite !== "e2e") throw new Error(`e2e manifest: suite must be "e2e", got ${JSON.stringify(manifest.suite)}`);
  if (manifest.latencyBudgetMs !== undefined) requirePositiveInteger(manifest.latencyBudgetMs, "e2e manifest", "latencyBudgetMs");
  if (!Array.isArray(manifest.scenarios)) throw new Error("e2e manifest: scenarios must be an array");
  if (manifest.scenarios.length > LIMITS.maxScenarios) throw new Error(`e2e manifest: at most ${LIMITS.maxScenarios} scenarios`);
  const ids = new Set<string>();
  for (const scenario of manifest.scenarios) {
    validateScenario(scenario);
    if (ids.has(scenario.id)) throw new Error(`e2e scenario ${scenario.id}: duplicate scenario id`);
    ids.add(scenario.id);
  }
}

/** Throws a descriptive error for a malformed scenario. */
export function validateScenario(scenario: Scenario): void {
  const where = `e2e scenario ${typeof scenario?.id === "string" ? scenario.id : "(no id)"}`;
  if (typeof scenario !== "object" || scenario === null) throw new Error("e2e scenario: must be an object");
  if (typeof scenario.id !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(scenario.id)) throw new Error(`${where}: id must be 1 to 80 letters, digits, dots, dashes, or underscores`);
  if (scenario.latencyBudgetMs !== undefined) requirePositiveInteger(scenario.latencyBudgetMs, where, "latencyBudgetMs");
  validateRequires(scenario.requires, where);
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) throw new Error(`${where}: needs at least one step`);
  if (scenario.steps.length > LIMITS.maxSteps) throw new Error(`${where}: at most ${LIMITS.maxSteps} steps`);
  const earlier = new Map<string, StepKind>();
  for (const step of scenario.steps) {
    const at = `${where} step ${typeof step?.id === "string" ? step.id : "(no id)"}`;
    if (typeof step !== "object" || step === null) throw new Error(`${where}: each step must be an object`);
    if (typeof step.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(step.id) || step.id === "live") throw new Error(`${at}: id must be 1 to 40 letters, digits, dashes, or underscores (not "live")`);
    if (earlier.has(step.id)) throw new Error(`${at}: duplicate step id`);
    if (!STEP_KINDS.includes(step.kind)) throw new Error(`${at}: kind must be one of ${STEP_KINDS.join(", ")}, got ${JSON.stringify(step.kind)}`);
    if (step.latencyBudgetMs !== undefined) requirePositiveInteger(step.latencyBudgetMs, at, "latencyBudgetMs");
    validateRequires(step.requires, at);
    if (step.focusMode !== undefined && !MODES.includes(step.focusMode)) throw new Error(`${at}: focusMode must be one of ${MODES.join(", ")}`);
    if (step.kind === "ask") {
      if (!step.request || typeof step.request.question !== "string" || step.request.question.trim() === "") throw new Error(`${at}: an ask step needs request.question`);
      if (typeof step.request.context !== "object" || step.request.context === null || Array.isArray(step.request.context)) throw new Error(`${at}: request.context must be an object`);
    }
    if (step.kind === "override" || step.kind === "ledger") {
      if (typeof step.answer !== "string" || step.answer === "") throw new Error(`${at}: needs answer (for example "$ask.answer_id")`);
      checkRef(step.answer, earlier, at);
    }
    if (step.kind === "override") {
      if (!step.mode || !MODES.includes(step.mode)) throw new Error(`${at}: mode must be one of ${MODES.join(", ")}`);
      if (step.reask !== undefined) {
        if (earlier.get(step.reask) !== "ask") throw new Error(`${at}: reask must name an earlier ask step`);
      }
    }
    if (step.kind === "config" && (typeof step.file !== "string" || step.file === "")) throw new Error(`${at}: a config step needs file`);
    const assertions = step.assert ?? [];
    if (!Array.isArray(assertions)) throw new Error(`${at}: assert must be an array`);
    if (assertions.length === 0 && step.kind !== "override") throw new Error(`${at}: needs at least one assertion`);
    for (const assertion of assertions) {
      validateAssertion(assertion, at);
      for (const ref of refsIn(assertion)) checkRef(ref, earlier, at);
    }
    earlier.set(step.id, step.kind);
  }
}

function validateRequires(requires: Requires | undefined, where: string): void {
  if (requires === undefined) return;
  if (typeof requires !== "object" || requires === null || Array.isArray(requires)) throw new Error(`${where}: requires must be an object`);
  for (const key of Object.keys(requires)) if (key !== "connector") throw new Error(`${where}: unknown requires key "${key}"`);
  if (requires.connector !== undefined && (typeof requires.connector !== "string" || !/^[a-z0-9_-]{1,40}$/.test(requires.connector))) {
    throw new Error(`${where}: requires.connector must be a connector name such as "redcap"`);
  }
}

function checkRef(value: string, earlier: Map<string, StepKind>, where: string): void {
  if (!value.startsWith("$")) return;
  const match = REF.exec(value);
  if (!match) throw new Error(`${where}: malformed reference ${JSON.stringify(value)}`);
  const name = match[1]!;
  if (name === "live") {
    if (match[2] !== "commit" && match[2] !== "stockTag") throw new Error(`${where}: $live has only commit and stockTag`);
    return;
  }
  if (!earlier.has(name)) throw new Error(`${where}: reference ${value} names no earlier step`);
}

/** String values in an assertion that are references ("$..."). */
function refsIn(assertion: Assertion): string[] {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string" && value.startsWith("$")) out.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.entries(value).forEach(([k, v]) => k !== "path" && k !== "notMatches" && visit(v));
  };
  visit(assertion);
  return out;
}

function requirePositiveInteger(value: unknown, where: string, name: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${where}: ${name} must be a positive integer, got ${JSON.stringify(value)}`);
}

export async function runScenarios(options: E2ERunOptions): Promise<E2EResult> {
  validateE2EManifest(options.manifest);
  const tier = options.tier ?? "stock";
  if (!E2E_TIERS.includes(tier)) throw new Error(`e2e runner: tier must be one of ${E2E_TIERS.join(", ")}`);
  let connectors: string[] | null = null;
  const connectorList = async () => (connectors ??= await options.host.connectors());
  const scenarios: ScenarioResult[] = [];
  for (const scenario of options.manifest.scenarios) scenarios.push(await runScenario(scenario, options, connectorList));
  const skipped = scenarios.filter((s) => s.skipped).length;
  const failing = scenarios.filter((s) => !s.passed);
  const retryable = failing.length > 0 && failing.every((s) => s.retryable === true);
  return { tier, passed: failing.length === 0, total: scenarios.length, failed: failing.length, skipped, retryable, scenarios };
}

interface ScenarioState {
  targets: Map<string, unknown>;
  asks: Map<string, AskRequest>;
  history: { role: "user" | "assistant"; text: string }[];
  live: LiveFork;
}

async function runScenario(scenario: Scenario, options: E2ERunOptions, connectorList: () => Promise<string[]>): Promise<ScenarioResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const base = { id: scenario.id, ...(scenario.description ? { description: scenario.description } : {}) };
  const missing = await missingConnector(scenario.requires, connectorList);
  if (missing) return { ...base, passed: true, skipped: missing, durationMs: 0, steps: [] };
  const state: ScenarioState = { targets: new Map(), asks: new Map(), history: [], live: options.live };
  const steps: StepResult[] = [];
  for (const step of scenario.steps) {
    const result = await runStep(step, scenario, options, state, connectorList);
    steps.push(result);
    if (!result.passed) return { ...base, passed: false, failedStep: step.id, retryable: result.failures.every((f) => f.retryable === true), durationMs: now() - started, steps };
  }
  return { ...base, passed: true, durationMs: now() - started, steps };
}

async function missingConnector(requires: Requires | undefined, connectorList: () => Promise<string[]>): Promise<string | null> {
  if (!requires?.connector) return null;
  return (await connectorList()).includes(requires.connector) ? null : `the fork has no ${requires.connector} connector`;
}

async function runStep(step: Step, scenario: Scenario, options: E2ERunOptions, state: ScenarioState, connectorList: () => Promise<string[]>): Promise<StepResult> {
  const now = options.now ?? Date.now;
  const missing = await missingConnector(step.requires, connectorList);
  if (missing) return { id: step.id, kind: step.kind, passed: true, latencyMs: 0, skipped: missing, failures: [] };
  const timeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const budget = step.latencyBudgetMs ?? scenario.latencyBudgetMs ?? options.manifest.latencyBudgetMs ?? DEFAULT_LATENCY_BUDGET_MS;
  const started = now();
  let target: unknown;
  try {
    target = await withTimeout(perform(step, options.host, state), timeoutMs);
  } catch (error) {
    const latencyMs = now() - started;
    if (error instanceof StepTimeout) return fail(step, latencyMs, { path: "", op: "timeout", expected: `answer within ${timeoutMs} ms`, actual: "no answer", retryable: true });
    const text = error instanceof Error ? error.message : String(error);
    return fail(step, latencyMs, { path: "", op: step.kind, expected: "no error", actual: text, ...(text.startsWith(FORK_ERROR_PREFIX) ? {} : { retryable: true }) });
  }
  const latencyMs = now() - started;
  state.targets.set(step.id, target);
  let subject = target;
  if (step.kind === "ask" && step.focusMode) {
    subject = focusOn(target, step.focusMode);
    if (subject === undefined) return fail(step, latencyMs, { path: "", op: "focusMode", expected: step.focusMode, actual: (target as { mode?: unknown } | null)?.mode });
  }
  const failures: StepFailure[] = [];
  for (const assertion of step.assert ?? []) failures.push(...evaluate(substitute(assertion, state) as Assertion, subject, ""));
  const hardCap = budget * LATENCY_HARD_FACTOR;
  const warnings: StepFailure[] = [];
  if (latencyMs > hardCap) failures.push({ path: "latencyMs", op: "latency", expected: `at most ${hardCap} ms`, actual: latencyMs, retryable: true });
  else if (latencyMs > budget) warnings.push({ path: "latencyMs", op: "latency", expected: `at most ${budget} ms`, actual: latencyMs });
  return { id: step.id, kind: step.kind, passed: failures.length === 0, latencyMs, failures, ...(warnings.length ? { warnings } : {}) };
}

function fail(step: Step, latencyMs: number, failure: StepFailure): StepResult {
  return { id: step.id, kind: step.kind, passed: false, latencyMs, failures: [failure] };
}

async function perform(step: Step, host: E2EHost, state: ScenarioState): Promise<unknown> {
  switch (step.kind) {
    case "ask": {
      const request: AskRequest = { ...step.request!, context: { ...step.request!.context } };
      if (step.withHistory && state.history.length) request.history = [...state.history];
      const card = await host.ask(request);
      state.asks.set(step.id, step.request!);
      state.history.push({ role: "user", text: step.request!.question }, { role: "assistant", text: bodyOf(card) });
      return card;
    }
    case "override": {
      const answerId = String(resolveValue(step.answer!, state));
      const record = await host.override(answerId, step.mode!);
      if (!step.reask) return { record };
      const original = state.asks.get(step.reask)!;
      const card = await host.ask({ ...original, context: { ...original.context }, explicitMode: step.mode! });
      return { record, card };
    }
    case "ledger":
      return (await host.ledger(String(resolveValue(step.answer!, state)))) ?? null;
    case "intents": {
      const records = await host.intents();
      return { count: records.length, records };
    }
    case "config":
      return host.config(step.file!);
  }
}

function bodyOf(card: unknown): string {
  const body = (card as { body?: unknown } | null)?.body;
  return typeof body === "string" ? body.slice(0, 2000) : "";
}

/** The card in `mode`: the card itself, or the matching alternative of a multi-intent card. */
export function focusOn(card: unknown, mode: Mode): unknown {
  const c = card as { mode?: unknown; alternatives?: unknown } | null;
  if (c?.mode === mode) return card;
  if (c?.mode !== "multi" || !Array.isArray(c.alternatives)) return undefined;
  return c.alternatives.find((a) => (a as { mode?: unknown } | null)?.mode === mode);
}

/** Resolves "$live.commit", "$live.stockTag", "$step", or "$step.path"; any other value is returned as is. */
export function resolveValue(value: unknown, state: { targets: Map<string, unknown>; live: LiveFork }): unknown {
  if (typeof value !== "string" || !value.startsWith("$")) return value;
  const match = REF.exec(value);
  if (!match) return value;
  const [, name, path] = match;
  if (name === "live") return path === "commit" ? state.live.commit : path === "stockTag" ? state.live.stockTag : undefined;
  return resolvePath(state.targets.get(name!), path);
}

/** Replaces references in expected values (never in path or notMatches). */
function substitute(assertion: Assertion, state: ScenarioState): Assertion {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(assertion)) {
    if (key === "path" || key === "notMatches" || key === "allowEmpty") out[key] = value;
    else if (key === "some" || key === "every") out[key] = substitute(value as Assertion, state);
    else out[key] = resolveValue(value, state);
  }
  return out as Assertion;
}

class StepTimeout extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeout(`step exceeded ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}


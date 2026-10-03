// Fork runtime entry module. The platform loads this per fork and calls
// ask(request, env). Every safety decision below is deterministic code.
import { classify } from "../intent/classifier.js";
import { decide } from "../intent/decide.js";
import { extractSignals } from "../intent/signals.js";
import { buildCard } from "./cards.js";
import { readForkConfig } from "./config.js";
import { MODES, type AnswerCard, type AskRequest, type ContextSignals, type ForkApp, type ForkEnv } from "./types.js";

export async function ask(raw: AskRequest, env: ForkEnv = {}): Promise<AnswerCard> {
  const request = normalizeRequest(raw);
  const config = readForkConfig(env.fluidToml);
  const signals = extractSignals(request);
  const classification = classify(signals);
  const decision = decide({ request, signals, classification, tau: config.tau });
  return buildCard({ request, env, decision, classification, signals, config, answerId: newAnswerId(env) });
}

/**
 * Validates the request and returns a copy with clinical flags coerced to
 * booleans. Anything that could hide a clinical signal fails closed: a truthy
 * non-boolean flag counts as true, and a chart is identified unless it says
 * identified: false. Values that would end up in the ledger are rejected
 * instead of guessed.
 */
export function normalizeRequest(request: AskRequest): AskRequest {
  if (typeof request !== "object" || request === null) throw new Error("ask: request must be an object");
  if (typeof request.question !== "string" || request.question.trim() === "") {
    throw new Error("ask: request.question must be a non-empty string");
  }
  if (typeof request.context !== "object" || request.context === null || Array.isArray(request.context)) {
    throw new Error("ask: request.context must be an object (use {} for no context)");
  }
  if (request.explicitMode !== undefined && !MODES.includes(request.explicitMode)) {
    throw new Error(`ask: explicitMode must be one of ${MODES.join(", ")}, got ${JSON.stringify(request.explicitMode)}`);
  }
  const attestation = request.attestation ?? undefined;
  if (attestation !== undefined && typeof attestation !== "boolean") {
    throw new Error(`ask: attestation must be a boolean when present, got ${JSON.stringify(attestation)}`);
  }
  const history = request.history ?? undefined;
  if (history !== undefined) validateHistory(history);

  const normalized: AskRequest = { question: request.question, context: normalizeContext(request.context) };
  if (request.explicitMode !== undefined) normalized.explicitMode = request.explicitMode;
  if (attestation !== undefined) normalized.attestation = attestation;
  if (history !== undefined) normalized.history = history;
  return normalized;
}

function normalizeContext(context: ContextSignals): ContextSignals {
  const chart = context.chartOpen;
  if (chart !== undefined && chart !== null && (typeof chart !== "object" || Array.isArray(chart))) {
    throw new Error(`ask: context.chartOpen must be an object or null, got ${JSON.stringify(chart)}`);
  }
  const normalized: ContextSignals = { ...context };
  if (chart) {
    normalized.chartOpen = {
      patientId: typeof chart.patientId === "string" ? chart.patientId : String(chart.patientId ?? ""),
      // Only an explicit false marks a chart as de-identified.
      identified: chart.identified !== false,
    };
  }
  if ("orderEntryActive" in context) normalized.orderEntryActive = Boolean(context.orderEntryActive);
  if ("onService" in context) normalized.onService = Boolean(context.onService);
  return normalized;
}

function validateHistory(history: unknown): asserts history is NonNullable<AskRequest["history"]> {
  if (!Array.isArray(history)) throw new Error(`ask: history must be an array when present, got ${typeof history}`);
  history.forEach((turn, index) => {
    const t = turn as { role?: unknown; text?: unknown } | null;
    if (typeof t !== "object" || t === null || (t.role !== "user" && t.role !== "assistant") || typeof t.text !== "string") {
      throw new Error(`ask: history[${index}] must be { role: "user" | "assistant", text: string }`);
    }
  });
}

function newAnswerId(env: ForkEnv): string {
  if (env.newId) return env.newId();
  return `ans_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

const app: ForkApp = { ask };
export default app;

export type { AnswerCard, AskRequest, ContextSignals, ForkApp, ForkEnv, Mode, RunTimeRecord, SourceRef } from "./types.js";
export type { SyntheticData } from "../connectors/types.js";
export { STOCK_TAG, readForkConfig } from "./config.js";
export { STOCK_MIN_TAU, effectiveTau } from "../intent/thresholds.js";
export { MODE_CONTRACTS, SYNTHETIC_NOTICE } from "../policies/contracts.js";
export { scheduleContext } from "../connectors/context.js";

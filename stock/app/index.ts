// Fork runtime entry module. The platform loads this per fork and calls
// ask(request, env). Every safety decision below is deterministic code.
import { classify } from "../intent/classifier.js";
import { decide } from "../intent/decide.js";
import { extractSignals } from "../intent/signals.js";
import { buildCard } from "./cards.js";
import { readForkConfig } from "./config.js";
import { MODES, type AnswerCard, type AskRequest, type ForkApp, type ForkEnv } from "./types.js";

export async function ask(request: AskRequest, env: ForkEnv = {}): Promise<AnswerCard> {
  validateRequest(request);
  const config = readForkConfig(env.fluidToml);
  const signals = extractSignals(request);
  const classification = classify(signals);
  const decision = decide({ request, signals, classification, tau: config.tau });
  return buildCard({ request, env, decision, classification, signals, config, answerId: newAnswerId(env) });
}

function validateRequest(request: AskRequest): void {
  if (typeof request?.question !== "string" || request.question.trim() === "") {
    throw new Error("ask: request.question must be a non-empty string");
  }
  if (typeof request.context !== "object" || request.context === null) {
    throw new Error("ask: request.context must be an object (use {} for no context)");
  }
  if (request.explicitMode !== undefined && !MODES.includes(request.explicitMode)) {
    throw new Error(`ask: explicitMode must be one of ${MODES.join(", ")}, got ${JSON.stringify(request.explicitMode)}`);
  }
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

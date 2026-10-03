// Chooses how to answer: one mode, or the labeled multi-intent view.
// Every rule here is deterministic and covered by the invariant suite.
import { MODES, type AskRequest, type Mode } from "../app/types.js";
import { topIntent, type Classification } from "./classifier.js";
import { isDosingQuestion } from "./questions.js";
import { hasClinicalSignal, hasIdentifiedPatientContext, type Signal } from "./signals.js";
import { PLAUSIBLE_INTENT_MIN } from "./thresholds.js";

export interface Decision {
  mode: Mode | "multi";
  /** Modes to answer, in display order. A single entry unless mode is "multi". */
  answerModes: Mode[];
  confidence: number;
  /** Spec 5.4 option B: clinical shown first because a clinical signal is present. */
  optionB: boolean;
  identifiedPatientContext: boolean;
  /** Research numbers stay hidden until the user attests they are not deciding for a patient. */
  researchNeedsAttestation: boolean;
  override: Mode | null;
  tau: number;
}

export interface DecideInput {
  request: AskRequest;
  signals: Signal[];
  classification: Classification;
  tau: number;
}

export function decide({ request, signals, classification, tau }: DecideInput): Decision {
  const { distribution } = classification;
  const identifiedPatientContext = hasIdentifiedPatientContext(request.context);
  const base = {
    identifiedPatientContext,
    researchNeedsAttestation: identifiedPatientContext && request.attestation !== true,
    override: request.explicitMode ?? null,
    tau,
  };

  if (request.explicitMode) {
    return { ...base, mode: request.explicitMode, answerModes: [request.explicitMode], confidence: distribution[request.explicitMode], optionB: false };
  }

  const top = topIntent(distribution);
  if (distribution[top] >= tau) {
    return { ...base, mode: top, answerModes: [top], confidence: distribution[top], optionB: false };
  }

  const optionB = hasClinicalSignal(signals) && isDosingQuestion(request.question);
  const byProbability = [...MODES].sort((a, b) => distribution[b] - distribution[a]);
  const plausible = byProbability.filter((mode, index) => index < 2 || distribution[mode] >= PLAUSIBLE_INTENT_MIN);
  const answerModes = optionB ? ["clinical" as const, ...plausible.filter((m) => m !== "clinical")] : plausible;
  return { ...base, mode: "multi", answerModes, confidence: distribution[top], optionB };
}

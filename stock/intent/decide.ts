// Chooses how to answer: one mode, or the labeled multi-intent view.
// Every rule here is deterministic and covered by the invariant suite.
import { MODES, type AskRequest, type Mode } from "../app/types.js";
import { topIntent, type Classification } from "./classifier.js";
import { isDosingQuestion, statesCurrentPatient } from "./questions.js";
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
  /** Multi-intent view because the question states a current patient, not because confidence is below tau. */
  currentPatientDosing: boolean;
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
    currentPatientDosing: false,
  };

  if (request.explicitMode) {
    return { ...base, mode: request.explicitMode, answerModes: [request.explicitMode], confidence: distribution[request.explicitMode], optionB: false };
  }

  // Spec 6.1 and 5.4 rule C: an identified patient in context answers in
  // clinical mode whatever tau the user raised it to. Raising tau may only make
  // Fluid more cautious, never move this case into the multi-intent view.
  if (identifiedPatientContext) {
    return { ...base, mode: "clinical", answerModes: ["clinical"], confidence: distribution.clinical, optionB: false };
  }

  const dosing = isDosingQuestion(request.question);
  const top = topIntent(distribution);
  // A dosing question that states a real current patient never gets a lone
  // research card, however strong the research context: option B instead.
  const currentPatientDosing = dosing && statesCurrentPatient(request.question);
  if (distribution[top] >= tau && !(currentPatientDosing && top === "research")) {
    return { ...base, mode: top, answerModes: [top], confidence: distribution[top], optionB: false };
  }

  const optionB = (hasClinicalSignal(signals) && dosing) || currentPatientDosing;
  const byProbability = [...MODES].sort((a, b) => distribution[b] - distribution[a]);
  const plausible = byProbability.filter((mode, index) => index < 2 || distribution[mode] >= PLAUSIBLE_INTENT_MIN);
  const answerModes = optionB ? ["clinical" as const, ...plausible.filter((m) => m !== "clinical")] : plausible;
  const belowTau = distribution[top] < tau;
  return { ...base, mode: "multi", answerModes, confidence: distribution[top], optionB, currentPatientDosing: currentPatientDosing && !belowTau };
}

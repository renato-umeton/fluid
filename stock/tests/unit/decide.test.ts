import { describe, expect, it } from "vitest";
import { decide } from "../../intent/decide.js";
import { classify } from "../../intent/classifier.js";
import { extractSignals } from "../../intent/signals.js";
import type { AskRequest } from "../../app/types.js";

const DOSING = "What is the right dose of Morphinex for a patient of 70 kg and 45 years?";
const CHART = { patientId: "synthetic_patient_117", identified: true };

function decideFor(partial: Partial<AskRequest> & { context: AskRequest["context"] }, tau = 0.85) {
  const request: AskRequest = { question: DOSING, ...partial };
  const signals = extractSignals(request);
  return decide({ request, signals, classification: classify(signals), tau });
}

describe("single-mode answers above tau", () => {
  it("chart open answers in clinical mode", () => {
    expect(decideFor({ context: { chartOpen: CHART } })).toMatchObject({ mode: "clinical", answerModes: ["clinical"] });
  });

  it("manuscript answers in research mode", () => {
    expect(decideFor({ context: { documentType: "manuscript" } }).mode).toBe("research");
  });

  it("budget answers in administrative mode", () => {
    expect(decideFor({ context: { documentType: "budget" } }).mode).toBe("administrative");
  });
});

describe("tau", () => {
  it("a raised tau turns a confident research answer into the labeled multi view", () => {
    expect(decideFor({ context: { documentType: "manuscript" } }, 0.95).mode).toBe("multi");
  });

  it("below tau shows every plausible intent, highest first", () => {
    const decision = decideFor({ question: "Summarize Morphinex", context: { screenLabel: { label: "unknown", confidence: 0.4 } } });
    expect(decision.mode).toBe("multi");
    expect(decision.answerModes).toHaveLength(3);
    expect(decision.optionB).toBe(false);
  });
});

describe("option B (spec 5.4)", () => {
  it("ambiguous context with a clinical signal and a dosing question puts clinical first", () => {
    const decision = decideFor({ context: { onService: true, documentType: "manuscript" } });
    expect(decision.mode).toBe("multi");
    expect(decision.optionB).toBe(true);
    expect(decision.answerModes[0]).toBe("clinical");
  });

  it("does not apply to non-dosing questions", () => {
    const decision = decideFor({ question: "Summarize the literature on Morphinex", context: { onService: true, documentType: "grant" } });
    expect(decision.optionB).toBe(false);
  });

  it("clinical is first even when it is the least likely plausible intent", () => {
    const decision = decideFor({ question: "dose of Morphinex for 70 kg, 45 years, hypothetical", context: { calendarEvent: "consult", documentType: "manuscript", screenLabel: { label: "manuscript_editor", confidence: 0.2 } } }, 0.99);
    expect(decision.answerModes[0]).toBe("clinical");
  });
});

describe("attestation rule", () => {
  it("research numbers need attestation while an identified patient is in context", () => {
    expect(decideFor({ context: { chartOpen: CHART }, explicitMode: "research" }).researchNeedsAttestation).toBe(true);
  });

  it("attestation lifts the hold", () => {
    expect(decideFor({ context: { chartOpen: CHART }, explicitMode: "research", attestation: true }).researchNeedsAttestation).toBe(false);
  });

  it("no attestation is needed without an identified patient", () => {
    expect(decideFor({ context: { onService: true, documentType: "manuscript" } }).researchNeedsAttestation).toBe(false);
  });

  it("a raised tau with a chart open still lists clinical first and holds research", () => {
    const decision = decideFor({ context: { chartOpen: CHART } }, 0.95);
    expect(decision).toMatchObject({ mode: "multi", optionB: true, researchNeedsAttestation: true });
    expect(decision.answerModes[0]).toBe("clinical");
  });
});

describe("explicit override", () => {
  it("always wins and is recorded", () => {
    expect(decideFor({ context: { chartOpen: CHART }, explicitMode: "administrative" })).toMatchObject({
      mode: "administrative",
      override: "administrative",
    });
  });
});

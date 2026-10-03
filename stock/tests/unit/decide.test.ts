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

  it("attestation alone does not move an identified chart out of clinical mode", () => {
    expect(decideFor({ context: { chartOpen: CHART }, attestation: true }, 0.95)).toMatchObject({ mode: "clinical", optionB: false });
  });
});

describe("identified patient context at any tau (spec 6.1, 5.2)", () => {
  it.each([0.85, 0.9, 0.95, 1])("an identified chart answers in clinical mode with tau %s", (tau) => {
    expect(decideFor({ context: { chartOpen: CHART } }, tau)).toMatchObject({ mode: "clinical", answerModes: ["clinical"], researchNeedsAttestation: true });
  });

  it.each([0.95, 1])("active order entry answers in clinical mode with tau %s", (tau) => {
    expect(decideFor({ context: { orderEntryActive: true, documentType: "manuscript" } }, tau).mode).toBe("clinical");
  });

  it("an explicit mode still wins over an identified chart", () => {
    expect(decideFor({ context: { chartOpen: CHART }, explicitMode: "research" }, 1).mode).toBe("research");
  });

  it("a chart without an identified flag is treated as identified", () => {
    const decision = decideFor({ context: { chartOpen: { patientId: "synthetic_patient_117" } as never } }, 1);
    expect(decision).toMatchObject({ mode: "clinical", identifiedPatientContext: true, researchNeedsAttestation: true });
  });

  it("a chart marked identified: false is not an identified context", () => {
    expect(decideFor({ context: { chartOpen: { patientId: "x", identified: false } } }).identifiedPatientContext).toBe(false);
  });
});

describe("a real current patient stated in the question", () => {
  const research = { documentType: "manuscript" as const, screenLabel: { label: "manuscript_editor", confidence: 1 }, calendarEvent: "Manuscript writing block" };
  it.each([
    "What dose of Morphinex should I give at the bedside for 70 kg and 45 years?",
    "My patient is 70 kg and 45 years, what Morphinex dose?",
    "Morphinex dose for an admitted man, 70 kg, 45 years?",
    "Patient on the floor, 70 kg and 45 years: how much Morphinex?",
    "I am in clinic now with a 70 kg 45 year old, Morphinex dosing?",
  ])("never returns a single research card: %s", (question) => {
    const decision = decideFor({ question, context: research });
    expect(decision.mode).toBe("multi");
    expect(decision.optionB).toBe(true);
    expect(decision.answerModes[0]).toBe("clinical");
    expect(decision.answerModes).toContain("research");
  });

  it("does not apply to a non-dosing question", () => {
    expect(decideFor({ question: "Summarize Morphinex literature for my patient handout at the bedside", context: research }).mode).toBe("research");
  });

  it("an explicit research mode still wins", () => {
    expect(decideFor({ question: "My patient is 70 kg and 45 years, what Morphinex dose?", context: research, explicitMode: "research" }).mode).toBe("research");
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

import { describe, expect, it } from "vitest";
import {
  conversationSignals,
  explicitSignals,
  extractSignals,
  hardContextSignals,
  hasClinicalSignal,
  hasIdentifiedPatientContext,
  softContextSignals,
} from "../../intent/signals.js";
import { isDosingQuestion } from "../../intent/questions.js";

const QUESTION = "What is the right dose of Morphinex for a patient of 70 kg and 45 years?";

describe("hard context adapter", () => {
  it("identified chart open sets the identified-context clinical floor", () => {
    const [signal] = hardContextSignals({ chartOpen: { patientId: "synthetic_patient_117", identified: true } });
    expect(signal).toMatchObject({ label: "chart_open:synthetic_patient_117", clinicalFloor: 0.9 });
  });

  it("active order entry sets the identified-context clinical floor", () => {
    const [signal] = hardContextSignals({ orderEntryActive: true });
    expect(signal?.clinicalFloor).toBe(0.9);
  });

  it("on service is a smaller floor", () => {
    const [signal] = hardContextSignals({ onService: true });
    expect(signal).toMatchObject({ label: "on_service:true", clinicalFloor: 0.2 });
  });

  it("a de-identified chart is clinical evidence without a floor", () => {
    const [signal] = hardContextSignals({ chartOpen: { patientId: "p1", identified: false } });
    expect(signal?.clinicalFloor).toBeUndefined();
    expect(signal?.evidence.clinical).toBeGreaterThan(0);
  });
});

describe("soft context adapter", () => {
  it("a manuscript is research evidence", () => {
    const [signal] = softContextSignals({ documentType: "manuscript" });
    expect(signal).toMatchObject({ label: "document:manuscript", evidence: { research: 3 } });
  });

  it("screen label evidence scales with its confidence", () => {
    const [signal] = softContextSignals({ screenLabel: { label: "budget_spreadsheet", confidence: 0.5 } });
    expect(signal?.evidence.administrative).toBeCloseTo(1);
  });

  it("an unknown screen label is recorded but carries no evidence", () => {
    const [signal] = softContextSignals({ screenLabel: { label: "unknown", confidence: 0.4 } });
    expect(signal).toMatchObject({ label: "screen:unknown", evidence: {} });
  });

  it("calendar events are matched by keyword", () => {
    const [signal] = softContextSignals({ calendarEvent: "7W morning rounds" });
    expect(signal?.evidence.clinical).toBeGreaterThan(0);
  });
});

describe("conversation adapter", () => {
  it("the canonical hypothetical question carries no clinical keyword", () => {
    expect(conversationSignals(QUESTION, [])).toEqual([]);
  });

  it("detects administrative phrases", () => {
    const labels = conversationSignals("What does Morphinex cost per month on our formulary?", []).map((s) => s.label);
    expect(labels).toEqual(["keyword:administrative:formulary", "keyword:administrative:cost", "keyword:administrative:per month"]);
  });

  it("recent user turns count at half weight", () => {
    const [signal] = conversationSignals("and the dose?", [{ role: "user", text: "for my manuscript" }]);
    expect(signal).toMatchObject({ label: "history:research:manuscript", evidence: { research: 0.375 } });
  });
});

describe("explicit adapter and helpers", () => {
  it("records an explicit mode selection", () => {
    expect(explicitSignals("research")[0]?.label).toBe("explicit:research");
  });

  it("hasClinicalSignal is true for any clinical evidence or floor", () => {
    const signals = extractSignals({ question: QUESTION, context: { onService: true } });
    expect(hasClinicalSignal(signals)).toBe(true);
  });

  it("hasClinicalSignal is false for research-only context", () => {
    const signals = extractSignals({ question: QUESTION, context: { documentType: "manuscript" } });
    expect(hasClinicalSignal(signals)).toBe(false);
  });

  it("identified patient context means identified chart or order entry", () => {
    expect(hasIdentifiedPatientContext({ orderEntryActive: true })).toBe(true);
    expect(hasIdentifiedPatientContext({ chartOpen: { patientId: "x", identified: false } })).toBe(false);
    expect(hasIdentifiedPatientContext({ onService: true })).toBe(false);
  });
});

describe("isDosingQuestion", () => {
  it.each([QUESTION, "how much Morphinex for 60 kg", "Morphinex mg/kg in older adults"])("recognizes %s", (q) => {
    expect(isDosingQuestion(q)).toBe(true);
  });

  it("ignores non-dosing questions", () => {
    expect(isDosingQuestion("Is Morphinex on formulary?")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { applyFloor, classify } from "../../intent/classifier.js";
import { extractSignals } from "../../intent/signals.js";
import type { ContextSignals } from "../../app/types.js";

const QUESTION = "What is the right dose of Morphinex for a patient of 70 kg and 45 years?";
const classifyContext = (context: ContextSignals, question = QUESTION) => classify(extractSignals({ question, context }));
const sum = (d: Record<string, number>) => Object.values(d).reduce((a, b) => a + b, 0);

describe("classify", () => {
  it("is uniform with no evidence", () => {
    const { distribution } = classifyContext({});
    expect(distribution.clinical).toBeCloseTo(1 / 3);
    expect(distribution.research).toBeCloseTo(1 / 3);
  });

  it("an open manuscript makes research the confident top intent", () => {
    const { distribution } = classifyContext({ documentType: "manuscript" });
    expect(distribution.research).toBeGreaterThan(0.85);
  });

  it("an open budget makes administrative the confident top intent", () => {
    const { distribution } = classifyContext({ documentType: "budget" });
    expect(distribution.administrative).toBeGreaterThan(0.85);
  });

  it("always returns a probability distribution", () => {
    const { distribution } = classifyContext({ documentType: "grant", onService: true, calendarEvent: "budget committee" });
    expect(sum(distribution)).toBeCloseTo(1, 10);
  });
});

describe("hard-context floors", () => {
  it("an identified chart puts clinical at or above 0.9 even against strong research context", () => {
    const { distribution, floor } = classifyContext({
      chartOpen: { patientId: "synthetic_patient_117", identified: true },
      documentType: "manuscript",
      screenLabel: { label: "manuscript_editor", confidence: 1 },
    });
    expect(distribution.clinical).toBeGreaterThanOrEqual(0.9);
    expect(floor).toBe(0.9);
  });

  it("active order entry also floors clinical at 0.9", () => {
    expect(classifyContext({ orderEntryActive: true, documentType: "budget" }).distribution.clinical).toBeGreaterThanOrEqual(0.9);
  });

  it("on service keeps research below the stock tau", () => {
    const { distribution } = classifyContext({ onService: true, documentType: "manuscript", screenLabel: { label: "manuscript_editor", confidence: 1 } });
    expect(distribution.clinical).toBeGreaterThanOrEqual(0.2);
    expect(distribution.research).toBeLessThan(0.85);
  });

  it("a floor never lowers clinical that is already higher", () => {
    const { distribution } = classifyContext({ onService: true, screenLabel: { label: "ehr_chart", confidence: 1 } }, "dose for my patient right now");
    expect(distribution.clinical).toBeGreaterThan(0.5);
  });
});

describe("applyFloor", () => {
  it("rescales the other intents proportionally", () => {
    const floored = applyFloor({ clinical: 0.1, research: 0.6, administrative: 0.3 }, 0.9);
    expect(floored.clinical).toBe(0.9);
    expect(floored.research).toBeCloseTo(0.0667, 3);
    expect(floored.administrative).toBeCloseTo(0.0333, 3);
  });
});

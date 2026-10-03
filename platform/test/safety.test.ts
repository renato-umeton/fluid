import { describe, expect, it } from "vitest";
import { hasClinicalDose, markSafety, SAFETY_SIGNALS } from "../src/api/safety.ts";

const card = (extra: Record<string, unknown> = {}) => ({ answer_id: "a1", mode: "research", computed_dose: { value: 7, unit: "mg", basis: "b" }, sources: [], signals: ["document:manuscript"], framing: ["f"], ledger: { answer_id: "a1", signals: ["document:manuscript"] }, ...extra });

describe("hasClinicalDose", () => {
	it("is false for a research card with a computed dose", () => expect(hasClinicalDose(card())).toBe(false));
	it("is true for a clinical card with a computed dose", () => expect(hasClinicalDose(card({ mode: "clinical" }))).toBe(true));
	it("is true for a clinical alternative with a computed dose", () => {
		expect(hasClinicalDose(card({ mode: "multi", computed_dose: null, alternatives: [{ mode: "clinical", computed_dose: { value: 1 } }] }))).toBe(true);
	});
	it("is false for a clinical card without a dose", () => expect(hasClinicalDose(card({ mode: "clinical", computed_dose: null }))).toBe(false));
});

describe("markSafety", () => {
	it("adds a visible signal, a framing line, and the same signal on the ledger record", () => {
		const out = markSafety(card(), SAFETY_SIGNALS.stockFallback, "Served by stock v1.3.0");
		expect(out.signals).toContain("safety_fallback:stock");
		expect(out.framing[0]).toBe("Served by stock v1.3.0");
		expect((out.ledger as { signals: string[] }).signals).toContain("safety_fallback:stock");
	});
});

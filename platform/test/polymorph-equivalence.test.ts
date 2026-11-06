import { describe, expect, it } from "vitest";
import { cardDifferences, equivalenceCheck } from "../src/polymorph/equivalence.ts";

function card(overrides: Record<string, unknown> = {}) {
	return {
		answer_id: "ans_1",
		mode: "multi",
		confidence: 0.61,
		signals: ["keyword:clinical:dose"],
		sources: [{ id: "policy:a", title: "Policy A", kind: "policy" }],
		body: "Intent is unclear, so this answer is shown per intent.",
		alternatives: [
			{ answer_id: "ans_1-clinical", mode: "clinical", computed_dose: null, ledger: { answer_id: "ans_1-clinical", fork_commit: "abc1234", tau: 0.85 } },
			{ answer_id: "ans_1-research", mode: "research", computed_dose: { value: 7, unit: "mg", basis: "0.1 mg/kg x 70 kg" }, ledger: { answer_id: "ans_1-research", fork_commit: "abc1234", tau: 0.85 } },
		],
		ledger: { answer_id: "ans_1", fork_commit: "abc1234", stock_tag: "v1.0.0", tau: 0.85 },
		...overrides,
	};
}

describe("cardDifferences", () => {
	it("finds no difference between equal cards", () => {
		expect(cardDifferences(card(), card())).toEqual([]);
	});

	it("ignores answer_id and fork_commit at any depth", () => {
		const morphed = card({
			answer_id: "ans_2",
			alternatives: card().alternatives.map((alt) => ({ ...alt, answer_id: `x${alt.answer_id}`, ledger: { ...alt.ledger, answer_id: "y", fork_commit: "def5678" } })),
			ledger: { answer_id: "ans_2", fork_commit: "def5678", stock_tag: "v1.0.0", tau: 0.85 },
		});
		expect(cardDifferences(card(), morphed)).toEqual([]);
		expect(cardDifferences(card(), { ...card(), fork_commit: "extra" })).toEqual([]);
	});

	it("reports a changed string in full, however long", () => {
		const long = "a".repeat(5000);
		expect(cardDifferences(card({ body: long }), card({ body: `${long}b` }))).toEqual([{ path: "body", plain: long, morphed: `${long}b` }]);
	});

	it("reports nested differences with dotted paths", () => {
		const morphed = card();
		morphed.alternatives[1]!.computed_dose = { value: 7.5, unit: "mg", basis: "0.1 mg/kg x 70 kg" };
		expect(cardDifferences(card(), morphed)).toEqual([{ path: "alternatives.1.computed_dose.value", plain: 7, morphed: 7.5 }]);
	});

	it("reports a key that only one card has, such as a renamed internal name leaking into a card", () => {
		const plain = card({ debug: { researchNeedsAttestation: true } });
		const morphed = card({ debug: { "researchNeedsAttestation$abcd1234": true } });
		expect(cardDifferences(plain, morphed)).toEqual([
			{ path: "debug.researchNeedsAttestation", plain: true, morphed: undefined },
			{ path: "debug.researchNeedsAttestation$abcd1234", plain: undefined, morphed: true },
		]);
	});

	it("treats a key whose value is undefined as absent, as JSON does", () => {
		expect(cardDifferences(card({ requires_attestation: undefined }), card())).toEqual([]);
	});

	it("reports arrays of different lengths once, with both arrays in full", () => {
		const extra = [...card().signals, "on_service:true"];
		expect(cardDifferences(card(), card({ signals: extra }))).toEqual([{ path: "signals", plain: card().signals, morphed: extra }]);
	});

	it("reports values of different types", () => {
		expect(cardDifferences(card(), card({ computed_dose: { value: 1 } }))).toEqual([{ path: "computed_dose", plain: undefined, morphed: { value: 1 } }]);
		expect(cardDifferences(card({ computed_dose: null }), card({ computed_dose: { value: 1 } }))).toEqual([{ path: "computed_dose", plain: null, morphed: { value: 1 } }]);
		expect(cardDifferences(card({ confidence: 1 }), card({ confidence: "1" }))).toEqual([{ path: "confidence", plain: 1, morphed: "1" }]);
		expect(cardDifferences([1], { 0: 1 })).toEqual([{ path: "", plain: [1], morphed: { 0: 1 } }]);
	});

	it("compares Dates, Maps, and other non-plain objects by the JSON the platform would receive", () => {
		expect(cardDifferences({ at: new Date(0) }, { at: new Date(1) })).toEqual([{ path: "at", plain: new Date(0), morphed: new Date(1) }]);
		expect(cardDifferences({ at: new Date(5) }, { at: new Date(5) })).toEqual([]);
		expect(cardDifferences({ m: new Map([["a", 1]]) }, { m: new Map([["a", 2]]) })).toEqual([]);
		expect(cardDifferences({ at: new Date(0) }, { at: "1970-01-01T00:00:00.000Z" })).toEqual([]);
		class Labeled {
			constructor(readonly label: string) {}
			toJSON() {
				return { label: this.label };
			}
		}
		expect(cardDifferences({ x: new Labeled("a") }, { x: new Labeled("a") })).toEqual([]);
		expect(cardDifferences({ x: new Labeled("a") }, { x: new Labeled("b") })).toHaveLength(1);
	});

	it("counts values that have no JSON form as different", () => {
		class Big {
			v = 1n;
		}
		expect(cardDifferences({ x: new Big() }, { x: new Big() })).toHaveLength(1);
	});

	it("stops at the limit, 20 by default", () => {
		const many = (offset: number) => Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i + offset]));
		expect(cardDifferences(many(0), many(1))).toHaveLength(20);
		expect(cardDifferences(many(0), many(1), 3)).toEqual([
			{ path: "k0", plain: 0, morphed: 1 },
			{ path: "k1", plain: 1, morphed: 2 },
			{ path: "k2", plain: 2, morphed: 3 },
		]);
	});

	it("refuses a limit that is not a positive integer", () => {
		expect(() => cardDifferences(card(), card(), 0)).toThrow(RangeError);
		expect(() => cardDifferences(card(), card(), 1.5)).toThrow(RangeError);
	});
});

describe("equivalenceCheck", () => {
	// One request per behavior: the same card from both sides, thirty fields that differ, one field that differs.
	const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, i]));
	const plain = async (request: unknown) => (request === "wide" ? wide : { mode: "research" });
	const copy = async (request: unknown) =>
		request === "wide" ? Object.fromEntries(Object.entries(wide).map(([key, value]) => [key, value + 1])) : request === "one" ? { mode: "clinical" } : { mode: "research" };

	it("answers with the copy and counts the requests that differed exactly, however many fields differ", async () => {
		const check = equivalenceCheck(plain, copy, 10);
		expect(await check.ask("same")).toEqual({ mode: "research" });
		expect(await check.ask("wide")).toEqual(Object.fromEntries(Object.entries(wide).map(([key, value]) => [key, value + 1])));
		expect(await check.ask("one")).toEqual({ mode: "clinical" });
		const report = check.report();
		expect([report.compared, report.mismatches, report.truncated]).toEqual([3, 2, true]);
		expect(report.findings).toHaveLength(10);
		expect(report.findings.every((finding) => finding.request === "wide")).toBe(true);
	});

	it("is not truncated when every difference fits", async () => {
		const check = equivalenceCheck(plain, copy, 10);
		await check.ask("one");
		expect(check.report()).toEqual({ compared: 1, mismatches: 1, truncated: false, findings: [{ request: "one", difference: { path: "mode", plain: "research", morphed: "clinical" } }] });
	});

	it("compares errors by message, and counts an error against a card as a difference at the whole answer", async () => {
		const failing = (message: string) => async () => {
			throw new Error(message);
		};
		const same = equivalenceCheck(failing("no card"), failing("no card"), 10);
		await expect(same.ask("q")).rejects.toThrow("no card");
		expect(same.report()).toMatchObject({ compared: 1, mismatches: 0 });
		const mixed = equivalenceCheck(plain, failing("broken"), 10);
		await expect(mixed.ask("q")).rejects.toThrow("broken");
		expect(mixed.report().findings).toEqual([{ request: "q", difference: { path: "", plain: { mode: "research" }, morphed: "threw: broken" } }]);
	});
});

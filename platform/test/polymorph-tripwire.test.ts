import { describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import { POLYMORPH_LIST_PATH, parsePolymorphList, usableNames } from "../src/polymorph/list.ts";
import { deriveSeed, variantNames } from "../src/polymorph/names.ts";
import { ForkTripwireError, TRIPWIRE_LIMITS, scanRequest } from "../src/polymorph/tripwire.ts";
import { buildModuleMap } from "../src/runtime/modules.ts";

const stockNames = parsePolymorphList((stockSource.files as Record<string, string>)[POLYMORPH_LIST_PATH]!);
const seed = await deriveSeed("polymorph-test-secret-0123456789", "user-ada", "0123456789abcdef0123456789abcdef01234567", 0);
const names = await variantNames(seed, stockNames);
const own = names.get("researchNeedsAttestation")!;
const otherCopy = own.endsWith("zzzzzzzz") ? "researchNeedsAttestation$00000000" : "researchNeedsAttestation$zzzzzzzz";

const question = "What is the right dose of Morphinex for a patient of 70 kg and 45 years?";

describe("scanRequest", () => {
	it("lets an ordinary request through", () => {
		const request = {
			question,
			context: { chartOpen: { patientId: "synthetic_patient_117", identified: true }, onService: true, screenLabel: { label: "ehr_chart", confidence: 0.9 } },
			explicitMode: "research",
			attestation: true,
			history: [{ role: "user", text: "researchNeedsAttestation answerModes" }],
		};
		expect(scanRequest(request, names)).toBeNull();
	});

	it("flags an original listed name used as a key, at any depth", () => {
		expect(scanRequest({ question, context: {}, researchNeedsAttestation: false }, names)).toEqual({ kind: "decoy", name: "researchNeedsAttestation", path: "researchNeedsAttestation" });
		expect(scanRequest({ question, context: { display: { researchNeedsAttestation: false } } }, names)).toEqual({
			kind: "decoy",
			name: "researchNeedsAttestation",
			path: "context.display.researchNeedsAttestation",
		});
		expect(scanRequest({ question, context: {}, history: [{ role: "user", text: "hi" }, { role: "user", text: "x", answerModes: ["research"] }] }, names)).toEqual({
			kind: "decoy",
			name: "answerModes",
			path: "history.1.answerModes",
		});
	});

	it("flags another copy's renamed name, but not this copy's own", () => {
		expect(scanRequest({ question, context: { [otherCopy]: false } }, names)).toEqual({ kind: "foreign", name: "researchNeedsAttestation", path: `context.${otherCopy}` });
		expect(scanRequest({ question, context: { [own]: false } }, names)).toBeNull();
	});

	it("ignores keys that only look similar and values that name listed names", () => {
		const request = {
			question: "researchNeedsAttestation",
			context: { "notListed$abcd1234": 1, "researchNeedsAttestation$abc": 2, "researchNeedsAttestation$ABCD1234": 3, researchNeedsAttestations: 4 },
		};
		expect(scanRequest(request, names)).toBeNull();
	});

	it("finds a decoy hidden under a __proto__ key of parsed JSON", () => {
		const request = JSON.parse('{"question":"q","context":{"__proto__":{"researchNeedsAttestation":false}}}');
		expect(scanRequest(request, names)).toEqual({ kind: "decoy", name: "researchNeedsAttestation", path: "context.__proto__.researchNeedsAttestation" });
	});

	it("walks only plain objects and arrays", () => {
		class Holder {
			researchNeedsAttestation = true;
		}
		expect(scanRequest({ question, context: { when: new Date(0), map: new Map([["researchNeedsAttestation", 1]]), holder: new Holder() } }, names)).toBeNull();
		expect(scanRequest("researchNeedsAttestation", names)).toBeNull();
		expect(scanRequest(null, names)).toBeNull();
	});

	it("writes odd keys in the path quoted and shortened", () => {
		const longKey = "k".repeat(100);
		expect(scanRequest({ "a.b": { [longKey]: { researchNeedsAttestation: 1 } } }, names)?.path).toBe(`"a.b".${JSON.stringify("k".repeat(64))}....researchNeedsAttestation`);
	});

	it("refuses a request nested deeper than it scans, instead of skipping what lies below", () => {
		const atLimit: Record<string, unknown> = {};
		let cursor = atLimit;
		for (let depth = 1; depth < TRIPWIRE_LIMITS.maxDepth; depth++) cursor = (cursor.next = {}) as Record<string, unknown>;
		expect(scanRequest(atLimit, names)).toBeNull();
		cursor.next = { researchNeedsAttestation: true };
		expect(() => scanRequest(atLimit, names)).toThrow(RangeError);
		expect(() => scanRequest(atLimit, names)).toThrow(/deeper than 32/);
	});

	it("refuses a request with more keys than it scans", () => {
		const wide = Object.fromEntries(Array.from({ length: TRIPWIRE_LIMITS.maxKeys }, (_, i) => [`k${i}`, i]));
		expect(scanRequest(wide, names)).toBeNull();
		expect(() => scanRequest({ ...wide, extra: 1 }, names)).toThrow(/more than 10000 keys/);
		expect(() => scanRequest({ list: Array.from({ length: TRIPWIRE_LIMITS.maxKeys + 1 }, () => 0) }, names)).toThrow(RangeError);
	});

	it("is not tripped by a name the copy skipped, since it scans with the usable names only", () => {
		const fork = buildModuleMap({ "app/index.ts": 'export default { ask(r: { context: Record<string, unknown> }) { return { seen: r.context["evidence"] }; } };' });
		const { usable, skipped } = usableNames(names, fork);
		expect(skipped.map((s) => s.name)).toEqual(["evidence"]);
		expect(scanRequest({ question, context: { evidence: 1 } }, usable)).toBeNull();
		expect(scanRequest({ question, context: { evidence: 1, researchNeedsAttestation: false } }, usable)).toEqual({
			kind: "decoy",
			name: "researchNeedsAttestation",
			path: "context.researchNeedsAttestation",
		});
	});

	it("ends on a cyclic object", () => {
		const cyclic: Record<string, unknown> = { question };
		cyclic.self = cyclic;
		expect(() => scanRequest(cyclic, names)).toThrow(RangeError);
	});
});

describe("ForkTripwireError", () => {
	it("carries the hit for logs and says the same thing for every hit", () => {
		const decoy = { kind: "decoy" as const, name: "researchNeedsAttestation", path: "context.display.researchNeedsAttestation" };
		const foreign = { kind: "foreign" as const, name: "evidence", path: `context.${otherCopy}` };
		const errors = [new ForkTripwireError(decoy), new ForkTripwireError(foreign)];
		expect(errors[0]).toBeInstanceOf(Error);
		expect(errors[0]!.name).toBe("ForkTripwireError");
		expect(errors.map((error) => error.hit)).toEqual([decoy, foreign]);
		expect(errors[0]!.message).toBe(errors[1]!.message);
		expect(errors[0]!.message).not.toMatch(/researchNeedsAttestation|evidence|context|decoy|foreign/);
	});
});

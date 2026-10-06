import { describe, expect, it } from "vitest";
import { requestKey } from "../src/contest/behavior.ts";
import { buildObservations, cardRecorder, wishTestSet } from "../src/contest/observe.ts";

const ask = (question: string, extra: Record<string, unknown> = {}) => ({ question, context: {}, ...extra });

describe("cardRecorder", () => {
	it("keeps the first card per request and passes every card through", async () => {
		let n = 0;
		const recorder = cardRecorder(async () => ({ answer_id: `a${++n}`, mode: "clinical" }));
		const first = await recorder.ask(ask("q"));
		await recorder.ask(ask("q"));
		expect(first).toEqual({ answer_id: "a1", mode: "clinical" });
		expect(recorder.cards.size).toBe(1);
		expect(recorder.cards.get(requestKey(ask("q")))).toEqual({ answer_id: "a1", mode: "clinical" });
	});

	it("stops recording past the cap but still answers", async () => {
		const recorder = cardRecorder(async (r) => r, 2);
		for (const q of ["a", "b", "c"]) await recorder.ask(ask(q));
		expect(recorder.cards.size).toBe(2);
		expect(await recorder.ask(ask("d"))).toEqual(ask("d"));
	});
});

describe("wishTestSet", () => {
	it("merges copies of the same test from different contestants under one key", () => {
		const a = [{ id: "t-int_a-card-contract", request: ask("q"), assert: [{ path: "mode", equals: "research" }] }];
		const b = [{ id: "t-int_b-card-contract", request: ask("q"), assert: [{ path: "mode", equals: "research" }] }, { id: "t-int_b-extra", request: ask("r"), assert: [{ path: "body", contains: "x" }] }];
		const set = wishTestSet([a, b]);
		expect(set.probes.map((p) => p.id)).toEqual(["t-int_a-card-contract", "t-int_b-extra"]);
		expect([...new Set(set.keys.values())]).toEqual(["wish:1", "wish:2"]);
	});

	it("caps the number of wish tests", () => {
		const many = Array.from({ length: 30 }, (_, i) => ({ id: `t-x-${i}`, request: ask(`q${i}`), assert: [{ path: "mode", exists: true }] }));
		expect(wishTestSet([many], 5).probes).toHaveLength(5);
	});
});

describe("buildObservations", () => {
	it("joins each probe with its result and the card its request got", () => {
		const invariant = { tier: "invariant" as const, probes: [{ id: "inv-a", request: ask("q1"), assert: [] }, { id: "inv-cfg", kind: "config", file: "fluid.toml", assert: [] }], result: { tier: "invariant", passed: false, total: 2, failed: 1, probes: [{ id: "inv-a", passed: false, samples: 1, passedSamples: 0, failures: [] }, { id: "inv-cfg", passed: true, samples: 1, passedSamples: 1, failures: [] }] } };
		const wishProbe = { id: "t-int_a-x", request: ask("q2"), assert: [] };
		const set = wishTestSet([[wishProbe]]);
		const user = { tier: "user" as const, probes: [wishProbe], result: { tier: "user", passed: true, total: 1, failed: 0, probes: [{ id: "t-int_a-x", passed: true, samples: 1, passedSamples: 1, failures: [] }] } };
		const cards = new Map<string, unknown>([[requestKey(ask("q1")), { answer_id: "z", mode: "clinical" }], [requestKey(ask("q2")), { mode: "research" }]]);
		const out = buildObservations([invariant, user], cards, set.keys);
		expect(out).toEqual([
			{ id: "inv-a", key: "invariant:inv-a", tier: "invariant", passed: false, question: "q1", card: { mode: "clinical" } },
			{ id: "inv-cfg", key: "invariant:inv-cfg", tier: "invariant", passed: true, question: "config fluid.toml", card: null },
			{ id: "t-int_a-x", key: "wish:1", tier: "wish", passed: true, question: "q2", card: { mode: "research" } },
		]);
	});

	it("reports a probe with no result as not run", () => {
		const out = buildObservations([{ tier: "functional", probes: [{ id: "fn-a", request: ask("q"), assert: [] }], result: null }], new Map(), new Map());
		expect(out[0]).toMatchObject({ id: "fn-a", passed: null, card: null });
	});
});

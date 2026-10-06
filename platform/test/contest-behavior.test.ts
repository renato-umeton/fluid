import { describe, expect, it } from "vitest";
import { BEHAVIOR_LIMITS, behaviorTable, compactCard, diffCards, probeContentKey, requestKey, type Observation } from "../src/contest/behavior.ts";

const card = (over: Record<string, unknown> = {}) => ({
	answer_id: "ans_1",
	mode: "research",
	confidence: 0.91,
	body: "Morphinex is listed in two registries.",
	framing: ["Research mode"],
	sources: [{ id: "reg-a", kind: "literature" }],
	computed_dose: null,
	ledger: { answer_id: "ans_1", fork_commit: "abc", stock_tag: "v1.0.0", intent: "research" },
	...over,
});

describe("requestKey", () => {
	it("is the same for the same request whatever the key order", () => {
		expect(requestKey({ question: "q", context: { a: 1, b: 2 } })).toBe(requestKey({ context: { b: 2, a: 1 }, question: "q" }));
	});

	it("differs when the request differs", () => {
		expect(requestKey({ question: "q", context: {} })).not.toBe(requestKey({ question: "q", context: {}, explicitMode: "clinical" }));
	});
});

describe("probeContentKey", () => {
	it("ignores the probe id and description, so two copies of one test match", () => {
		const a = { id: "t-int_a-x", description: "a", request: { question: "q", context: {} }, assert: [{ path: "mode", equals: "research" }] };
		const b = { ...a, id: "t-int_b-x", description: "b" };
		expect(probeContentKey(a)).toBe(probeContentKey(b));
	});
});

describe("compactCard", () => {
	it("drops fields that change on every answer", () => {
		const out = compactCard(card()) as Record<string, unknown>;
		expect(out.answer_id).toBeUndefined();
		expect((out.ledger as Record<string, unknown>).fork_commit).toBeUndefined();
		expect((out.ledger as Record<string, unknown>).answer_id).toBeUndefined();
		expect((out.ledger as Record<string, unknown>).stock_tag).toBe("v1.0.0");
	});

	it("keeps at most a fixed number of keys per object", () => {
		const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${String(i).padStart(3, "0")}`, i]));
		const out = compactCard({ mode: "research", extra: wide }) as Record<string, Record<string, unknown>>;
		expect(Object.keys(out.extra!)).toHaveLength(BEHAVIOR_LIMITS.maxKeys + 1);
		expect(out.extra!["(more keys)"]).toBe(500 - BEHAVIOR_LIMITS.maxKeys);
	});

	it("clips long text and long lists", () => {
		const out = compactCard(card({ body: "x".repeat(2000), signals: Array.from({ length: 30 }, (_, i) => `s${i}`) })) as Record<string, unknown>;
		expect(String(out.body).length).toBeLessThanOrEqual(BEHAVIOR_LIMITS.maxString + 20);
		expect((out.signals as unknown[]).length).toBe(BEHAVIOR_LIMITS.maxArray);
	});
});

describe("diffCards", () => {
	it("finds no change between two answers that differ only in volatile fields", () => {
		expect(diffCards(compactCard(card()), compactCard(card({ answer_id: "ans_2", ledger: { answer_id: "ans_2", fork_commit: "def", stock_tag: "v1.0.0", intent: "research" } })))).toEqual({ changes: [], total: 0 });
	});

	it("lists changed, added, and removed fields by path", () => {
		const before = compactCard(card());
		const after = compactCard(card({ body: "Morphinex: two registries agree.", sources: [{ id: "reg-a", kind: "literature" }, { id: "reg-b", kind: "society" }], framing: undefined }));
		const { changes, total } = diffCards(before, after);
		expect(total).toBe(4);
		expect(changes).toContainEqual({ path: "body", kind: "changed", before: "Morphinex is listed in two registries.", after: "Morphinex: two registries agree." });
		expect(changes).toContainEqual({ path: "sources.1.id", kind: "added", after: "reg-b" });
		expect(changes).toContainEqual({ path: "framing.0", kind: "removed", before: "Research mode" });
	});

	it("caps the list but keeps the total", () => {
		const before = { a: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i])) };
		const after = { a: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i + 1])) };
		const { changes, total } = diffCards(before, after, 5);
		expect(changes).toHaveLength(5);
		expect(total).toBe(40);
	});

	it("treats a missing card as all fields removed or added", () => {
		expect(diffCards(null, { mode: "clinical" })).toEqual({ changes: [{ path: "mode", kind: "added", after: "clinical" }], total: 1 });
	});
});

describe("behaviorTable", () => {
	const obs = (id: string, passed: boolean | null, c: unknown, extra: Partial<Observation> = {}): Observation => ({ id, key: id, tier: "invariant", passed, question: `question for ${id}`, card: c === null ? null : compactCard(c), ...extra });
	const main = [obs("inv-a", true, card()), obs("fn-b", true, card({ mode: "administrative" }), { tier: "functional" }), obs("t-wish", false, card({ body: "old" }), { key: "wish:1", tier: "wish" })];

	it("marks changed cells, wish rows, and counts changes outside the wish", () => {
		const table = behaviorTable(main, [
			{ label: "model-a", observations: [obs("inv-a", true, card()), obs("fn-b", true, card({ mode: "administrative" }), { tier: "functional" }), obs("t-own", true, card({ body: "new" }), { key: "wish:1", tier: "user" })] },
			{ label: "model-b", observations: [obs("inv-a", true, card({ confidence: 0.5 })), obs("fn-b", false, card({ mode: "research" }), { tier: "functional" }), obs("t-wish", true, card({ body: "new" }), { key: "wish:1", tier: "wish" })] },
		]);
		expect(table.rows.map((r) => r.id)).toEqual(["inv-a", "fn-b", "t-wish"]);
		const wish = table.rows.find((r) => r.id === "t-wish")!;
		expect(wish.wish).toBe(true);
		expect(wish.cells["model-a"]!.changed).toBe(true);
		expect(wish.cells["model-a"]!.passed).toBe(true);
		expect(table.rows[0]!.cells["model-a"]!.changed).toBe(false);
		expect(table.rows[0]!.cells["model-b"]!.changed).toBe(true);
		expect(table.rows[0]!.cells["model-b"]!.scope).toBe("outside");
		expect(wish.cells["model-a"]!.scope).toBe("wish");
		expect(table.counts).toEqual({ "model-a": { outside: 0, inside: 1, target: 0, own: 0, wishPassed: 1, wishTotal: 1, failingWish: [] }, "model-b": { outside: 2, inside: 1, target: 0, own: 0, wishPassed: 1, wishTotal: 1, failingWish: [] } });
	});

	it("counts new wording in a mode the wish tests ask about as inside the wish", () => {
		// The wish tests ask a research question, so research answers may gain the new line.
		const table = behaviorTable(main, [
			{ label: "wording", observations: [obs("inv-a", true, card({ body: "Morphinex is listed in two registries. In short: two sources agree." })), main[1]!, obs("t-wish", true, card({ body: "new" }), { key: "wish:1", tier: "wish" })] },
			{ label: "dose", observations: [obs("inv-a", true, card({ computed_dose: { value: 5, unit: "mg" } })), main[1]!, obs("t-wish", true, card({ body: "new" }), { key: "wish:1", tier: "wish" })] },
			{ label: "admin", observations: [main[0]!, obs("fn-b", true, card({ mode: "administrative", body: "changed" }), { tier: "functional" }), obs("t-wish", true, card({ body: "new" }), { key: "wish:1", tier: "wish" })] },
		]);
		expect(table.targetModes).toEqual(["research"]);
		expect(table.rows[0]!.cells.wording!.scope).toBe("target");
		expect(table.counts.wording).toMatchObject({ outside: 0, target: 1 });
		expect(table.rows[0]!.cells.dose!.scope).toBe("outside");
		expect(table.rows[1]!.cells.admin!.scope).toBe("outside");
	});

	it("gives a test only a candidate ran (main never did) its own scope, outside rule b", () => {
		// The owner's agent adds two tests of its own; main and the other candidate never ran them.
		const agentObs = [...main, obs("t-mine-1", true, card({ body: "mine" }), { key: "user:t-mine-1", tier: "user" }), obs("t-mine-2", false, null, { key: "user:t-mine-2", tier: "user" })];
		const table = behaviorTable(main, [{ label: "agent", observations: agentObs }, { label: "model-a", observations: main }]);
		const row = table.rows.find((r) => r.id === "t-mine-1")!;
		expect(row.main).toEqual({ passed: null, missing: true });
		expect(row.cells.agent).toMatchObject({ scope: "own", changed: true, passed: true });
		expect(row.cells["model-a"]).toMatchObject({ missing: true, changed: false, passed: null });
		expect(row.cells["model-a"]!.scope).toBeUndefined();
		expect(table.counts.agent).toMatchObject({ outside: 0, own: 2 });
		expect(table.counts["model-a"]).toMatchObject({ outside: 0, own: 0 });
	});

	it("compares a probe whose card was dropped by its result only", () => {
		const dropped = { ...obs("inv-a", true, null), dropped: true as const };
		const table = behaviorTable(main, [{ label: "x", observations: [dropped, main[1]!, main[2]!] }]);
		expect(table.rows[0]!.cells.x).toMatchObject({ changed: false, total: 0 });
	});

	it("counts a probe a candidate no longer runs as a change", () => {
		const table = behaviorTable(main, [{ label: "agent", observations: [obs("inv-a", true, card())] }]);
		const row = table.rows.find((r) => r.id === "fn-b")!;
		expect(row.cells.agent).toMatchObject({ missing: true, changed: true, passed: null });
		expect(table.counts.agent).toMatchObject({ outside: 1, inside: 1, wishTotal: 1, wishPassed: 0, failingWish: ["t-wish"] });
	});

	it("capBehavior trims field lists until the stored diff fits", async () => {
		const { capBehavior } = await import("../src/workflows/contest.ts");
		const big = { a: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "x".repeat(200)])) };
		const base = Array.from({ length: 30 }, (_, i) => obs(`p${i}`, true, big));
		const other = base.map((o) => ({ ...o, card: compactCard({ a: Object.fromEntries(Object.keys(big.a).map((k) => [k, "y".repeat(200)])) }) }));
		const table = behaviorTable(base, [{ label: "x", observations: other }]);
		const capped = capBehavior(table, 50_000);
		expect(JSON.stringify(capped).length).toBeLessThanOrEqual(50_000);
		expect(capped.counts).toEqual(table.counts);
		expect(capped.rows[0]!.cells.x!.total).toBe(40);
	});

	it("keeps changed rows first when it has to leave rows out", () => {
		const many = Array.from({ length: 10 }, (_, i) => obs(`p${i}`, true, card()));
		const changed = many.map((o, i) => (i === 9 ? obs("p9", true, card({ body: "different" })) : o));
		const table = behaviorTable(many, [{ label: "x", observations: changed }], { maxProbes: 3 });
		expect(table.rows.map((r) => r.id)).toContain("p9");
		expect(table.rows).toHaveLength(3);
		expect(table.omitted).toBe(7);
		expect(table.counts.x!.outside).toBe(1);
	});
});

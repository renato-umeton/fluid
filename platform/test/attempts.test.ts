import { describe, expect, it, vi } from "vitest";
import { CandidateError, failureExplanation, MAX_REPAIRS, planWithRepairs, userFacingError } from "../src/agents/attempts.ts";
import type { PlannedChange } from "../src/agents/recipes.ts";

const change = (summary: string): PlannedChange => ({ summary, purpose: "p", modes_affected: [], files: { "app/x.ts": "export {}" }, notes: {}, recipe: "model" });
const LOAD_ERROR = 'No such module "app/cards.base.js".\n    at Object.load (worker.js:1:1)';

describe("planWithRepairs", () => {
	it("returns the first change that loads", async () => {
		const plan = vi.fn(async () => change("ok"));
		const out = await planWithRepairs({ plan, validate: async () => {} });
		expect(out).toEqual({ ok: true, change: change("ok"), attempts: 1 });
		expect(plan).toHaveBeenCalledWith(null, 1);
	});

	it("sends the exact load error back to the model and succeeds on a repair", async () => {
		const plan = vi.fn(async (_feedback: string | null, attempt: number) => change(`plan ${attempt}`));
		let calls = 0;
		const out = await planWithRepairs({
			plan,
			validate: async () => {
				if (calls++ === 0) throw new Error(LOAD_ERROR);
			},
		});
		expect(out).toMatchObject({ ok: true, attempts: 2, change: { summary: "plan 2" } });
		expect(plan).toHaveBeenNthCalledWith(2, LOAD_ERROR, 2);
	});

	it("feeds a rejected plan back too", async () => {
		const plan = vi.fn(async (feedback: string | null) => {
			if (!feedback) throw new CandidateError("path \"ui/x.css\" is outside app/");
			return change("fixed");
		});
		const out = await planWithRepairs({ plan, validate: async () => {} });
		expect(out).toMatchObject({ ok: true, attempts: 2 });
		expect(plan.mock.calls[1]![0]).toContain("outside app/");
	});

	it("stops after at most 2 repairs and reports the last error", async () => {
		const plan = vi.fn(async (_f: string | null, attempt: number) => change(`plan ${attempt}`));
		const onFailure = vi.fn(async () => {});
		const out = await planWithRepairs({ plan, validate: async () => { throw new Error(LOAD_ERROR); }, onFailure });
		expect(MAX_REPAIRS).toBe(2);
		expect(plan).toHaveBeenCalledTimes(3);
		expect(out).toEqual({ ok: false, attempts: 3, error: LOAD_ERROR, lastSummary: "plan 3" });
		expect(onFailure.mock.calls.map((c) => (c as unknown[])[2])).toEqual([true, true, false]);
	});

	it("does not repeat a deterministic recipe", async () => {
		const plan = vi.fn(async () => change("recipe"));
		const out = await planWithRepairs({ plan, validate: async () => { throw new Error("bad"); } }, 0);
		expect(plan).toHaveBeenCalledTimes(1);
		expect(out.ok).toBe(false);
	});

	it("throws platform errors from planning so the step retries", async () => {
		await expect(planWithRepairs({ plan: async () => { throw new Error("AI binding unavailable"); }, validate: async () => {} })).rejects.toThrow("AI binding unavailable");
	});
});

describe("failureExplanation", () => {
	const text = failureExplanation({ attempts: 3, error: LOAD_ERROR, lastSummary: "Modified app/cards.ts to wrap the original card-building logic", model: true });

	it("says what was attempted, why it failed, and what to try, with no stack", () => {
		expect(text).toContain("nothing was committed");
		expect(text).toContain("Attempted: Modified app/cards.ts");
		expect(text).toContain('No such module "app/cards.base.js"');
		expect(text).toContain("3 attempts (the first plan and 2 repairs");
		expect(text).toContain("What you can try");
		expect(text).toContain("ui/preferences.json");
		expect(text).not.toContain("worker.js:1:1");
	});
});

describe("userFacingError", () => {
	it("keeps one line, drops stack frames and tokens, and bounds the length", () => {
		expect(userFacingError("\n  at foo (x:1)\nreal error art_v1_abcDEF123?expires=99")).toBe("real error <redacted-token>");
		expect(userFacingError("x".repeat(500))).toHaveLength(300);
	});
});

import { describe, expect, it } from "vitest";
import { askCard, ForkRuntimeError, ForkTimeoutError } from "../src/runtime/loader.ts";
import { ForkCodeError } from "../src/runtime/modules.ts";
import { hostError, runTierSafely } from "../src/yellow/run.ts";
import { FORK_ERROR_PREFIX, type E2ETierResult } from "../src/yellow/tiers.ts";

describe("host errors in the end-to-end host", () => {
	it("marks errors the fork caused so the runner does not retry them", () => {
		expect(hostError(new ForkCodeError("fork has no app/index.ts")).message).toBe(`${FORK_ERROR_PREFIX}fork has no app/index.ts`);
		expect(hostError(new ForkRuntimeError("TypeError: x is undefined")).message).toBe(`${FORK_ERROR_PREFIX}TypeError: x is undefined`);
	});

	it("leaves infrastructure errors and timeouts as they are (retryable)", () => {
		const infra = new Error("Artifacts unavailable");
		expect(hostError(infra)).toBe(infra);
		expect(hostError(new ForkTimeoutError("fork did not answer within 10000 ms")).message).not.toMatch(/^fork error/);
	});

	it("askCard reports a fork that throws or answers garbage as a fork runtime error", async () => {
		await expect(askCard({ ask: async () => { throw new TypeError("cards is undefined"); } } as never, {})).rejects.toBeInstanceOf(ForkRuntimeError);
		await expect(askCard({ ask: async () => 42 } as never, {})).rejects.toBeInstanceOf(ForkRuntimeError);
		await expect(askCard({ ask: async () => "{not json" } as never, {})).rejects.toBeInstanceOf(ForkRuntimeError);
		await expect(askCard({ ask: async () => JSON.stringify({ mode: "clinical" }) } as never, {})).resolves.toMatchObject({ mode: "clinical" });
	});
});

describe("runTierSafely", () => {
	const ok: E2ETierResult = { tier: "user", passed: true, total: 1, failed: 0, skipped: 0, scenarios: [] };

	it("turns an exception from running the user tier into a failed user tier", async () => {
		const result = await runTierSafely("user", async () => { throw new Error("Worker exceeded CPU time limit"); });
		expect(result).toMatchObject({ tier: "user", passed: false, failed: 1, error: expect.stringMatching(/could not run: Worker exceeded CPU time limit/) });
	});

	it("passes results through, and lets stock and platform tier exceptions reach the step's retries", async () => {
		expect(await runTierSafely("user", async () => ok)).toBe(ok);
		await expect(runTierSafely("stock", async () => { throw new Error("loader unavailable"); })).rejects.toThrow("loader unavailable");
	});
});

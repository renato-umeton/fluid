import { describe, expect, it } from "vitest";
import { callModel, parseModelOutput, validateAgainstSchema } from "../src/runtime/llm.ts";

const SCHEMA = { type: "object", properties: { body: { type: "string" }, n: { type: "number" } }, required: ["body"] };

describe("parseModelOutput", () => {
	it("reads an already-parsed response object", () => {
		expect(parseModelOutput({ response: { body: "x" } })).toEqual({ body: "x" });
	});

	it("reads a JSON string response", () => {
		expect(parseModelOutput({ response: '{"body":"x"}' })).toEqual({ body: "x" });
	});

	it("reads choices[0].message.content", () => {
		expect(parseModelOutput({ choices: [{ message: { content: '```json\n{"body":"y"}\n```' } }] })).toEqual({ body: "y" });
	});

	it("fails on empty content", () => {
		expect(() => parseModelOutput({ choices: [{ message: { content: "" } }] })).toThrow(/no content/);
	});

	it("fails on non-JSON text", () => {
		expect(() => parseModelOutput({ response: "JSON Mode couldn't be met" })).toThrow(/not JSON/);
	});
});

describe("callModel options", () => {
	it("sends a temperature only when one is given", async () => {
		const inputs: Record<string, unknown>[] = [];
		const ai = { run: async (_model: string, input: Record<string, unknown>) => (inputs.push(input), { response: { body: "x" } }) } as unknown as Ai;
		await callModel(ai, "p", SCHEMA, { temperature: 0.7 });
		await callModel(ai, "p", SCHEMA);
		expect(inputs[0]!.temperature).toBe(0.7);
		expect("temperature" in inputs[1]!).toBe(false);
	});
});

describe("validateAgainstSchema", () => {
	it("accepts a matching object", () => {
		expect(validateAgainstSchema({ body: "x", n: 1 }, SCHEMA)).toEqual({ body: "x", n: 1 });
	});

	it("rejects a missing required key", () => {
		expect(() => validateAgainstSchema({ n: 1 }, SCHEMA)).toThrow(/missing required key body/);
	});

	it("rejects a wrong type", () => {
		expect(() => validateAgainstSchema({ body: 3 }, SCHEMA)).toThrow(/body should be string/);
	});
});

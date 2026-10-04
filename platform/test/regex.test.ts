import { describe, expect, it } from "vitest";
import { validateProbe } from "../src/agents/suggester.ts";
import { prepareUserManifest } from "../src/gate/tiers.ts";
import { regexProblem, REGEX_LIMITS } from "../src/gate/regex.ts";
import { prepareE2ETiers } from "../src/yellow/tiers.ts";
import stockSource from "../src/generated/stock-source.json";

const probe = (notMatches: string) => ({ id: "p", request: { question: "q", context: {} }, assert: [{ path: "body", notMatches }] });
const nested = "/(a+)+$/";

describe("fork-supplied regexes", () => {
	it("follow the stock runner's limits: at most 200 characters and no nested unbounded quantifier", () => {
		expect(REGEX_LIMITS.maxLength).toBe(200);
		expect(regexProblem(`/${"a".repeat(201)}/`)).toMatch(/at most 200/);
		expect(regexProblem(nested)).toMatch(/nested quantifier/);
		expect(regexProblem("/(?<![\\w.])\\d+(\\.\\d+)?\\s?(mg|tabs?)(?!\\w)/i")).toBeNull();
	});

	it("agree with the stock runner on the stock suite's own patterns", () => {
		const files = stockSource.files as Record<string, string>;
		const patterns = [...Object.values(files).join("\n").matchAll(/"notMatches": *"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
		expect(patterns.length).toBeGreaterThan(0);
		for (const pattern of patterns) expect(regexProblem(pattern), pattern).toBeNull();
	});

	it("make a tier 3 probe invalid, even when the fork pins a runner without the limits", () => {
		expect(validateProbe(probe(nested) as never)).toMatch(/nested quantifier/);
		expect(validateProbe({ ...probe("/x/"), assert: [{ path: "framing", every: { notMatches: nested } }] } as never)).toMatch(/nested quantifier/);
		expect(prepareUserManifest(JSON.stringify({ probes: [probe(nested)] })).error).toMatch(/nested quantifier/);
		expect(validateProbe(probe("/enrol/i") as never)).toBeNull();
	});

	it("make the fork's end-to-end scenarios fail the user tier", () => {
		const scenario = { id: "u", steps: [{ id: "a", kind: "ask", request: { question: "q", context: {} }, assert: [{ path: "body", notMatches: nested }] }] };
		const prepared = prepareE2ETiers({ stock: null, userText: JSON.stringify({ suite: "e2e", scenarios: [scenario] }) });
		expect(prepared.user.error).toMatch(/scenario u: .*nested quantifier/);
		expect(prepared.tiers.map((t) => t.tier)).toEqual(["platform"]);
	});
});

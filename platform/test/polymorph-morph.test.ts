import { parse } from "sucrase/dist/parser/index.js";
import { TokenType } from "sucrase/dist/parser/tokenizer/types.js";
import { describe, expect, it } from "vitest";
import { scanTokens, tokenScanner } from "../src/polymorph/tokens.ts";

type SucraseToken = { type: number; start: number; end: number };
const realParse = parse as (input: string, jsx: boolean, ts: boolean, flow: boolean) => { tokens: SucraseToken[] };
const types = TokenType as unknown as Record<string, number>;

describe("scanTokens", () => {
	it("finds every identifier token with its exact span", () => {
		const js = [
			'import { a as b } from "./m.js";',
			"export { b as c };",
			"const { d, e: f = g, ...h } = i;",
			"const o = { j, k: 1, [l]: 2, m() {} };",
			"class P { #q = 1; r() { return this.#q; } }",
			"t?.u.v;",
		].join("\n");
		const { identifiers } = scanTokens(js);
		expect(identifiers.map((token) => token.text)).toEqual(
			["a", "as", "b", "from", "b", "as", "c", "d", "e", "f", "g", "h", "i", "o", "j", "k", "l", "m", "P", "q", "r", "q", "t", "u", "v"],
		);
		for (const token of identifiers) expect(js.slice(token.start, token.end)).toBe(token.text);
	});

	it("finds identifiers inside template substitutions and splits template text around them", () => {
		const { identifiers, strings } = scanTokens("const w = `x${y.z}w${`n${p}`}`;");
		expect(identifiers.map((token) => token.text)).toEqual(["w", "y", "z", "p"]);
		expect(strings).toEqual(["x", "w", "n", "", ""]);
	});

	it("decodes escaped identifiers but keeps the span of the escaped source", () => {
		const js = "const r\\u0061w = 1;";
		const token = scanTokens(js).identifiers[0]!;
		expect(token.text).toBe("raw");
		expect(js.slice(token.start, token.end)).toBe("r\\u0061w");
	});

	it("decodes string and template escapes", () => {
		const { strings } = scanTokens("f('it\\'s', \"\\x41\\u0042\\u{43}\\n\", \"a\\\nb\", `t\\u0021${x}\\x41`);");
		expect(strings).toEqual(["it's", "ABC\n", "ab", "t!", "A"]);
	});

	it("reads neither regular expressions nor comments as strings or identifiers", () => {
		expect(scanTokens('/abc"d/.test(x); // "note" y\n/* `z` */')).toEqual({
			identifiers: [{ start: 8, end: 12, text: "test" }, { start: 13, end: 14, text: "x" }],
			strings: [],
		});
	});

	it("throws a SyntaxError for code that does not parse, including TypeScript", () => {
		expect(() => scanTokens("export const = ;")).toThrow(SyntaxError);
		expect(() => scanTokens("export const = ;")).toThrow(/does not parse/);
		expect(() => scanTokens("const a: number = 1;")).toThrow(SyntaxError);
	});
});

describe("tokenScanner fails loudly when sucrase changes shape", () => {
	const sucraseError = /sucrase/;

	it("refuses a parser module without parse()", () => {
		expect(() => tokenScanner(undefined, TokenType)("a")).toThrow(sucraseError);
	});

	it("refuses token types it does not know", () => {
		expect(() => tokenScanner(parse, { name: 1, string: 2 })("a")).toThrow(sucraseError);
		expect(() => tokenScanner(parse, { ...types, template: types.name })("a")).toThrow(sucraseError);
	});

	it("refuses output without a token array", () => {
		expect(() => tokenScanner(() => ({ tokens: null }), TokenType)("a")).toThrow(sucraseError);
	});

	it("refuses tokens out of order or outside the source", () => {
		const reversed = (input: string, ...flags: boolean[]) => {
			const { tokens } = realParse(input, flags[0]!, flags[1]!, flags[2]!);
			return { tokens: [...tokens.slice(0, -1).reverse(), tokens.at(-1)] };
		};
		expect(() => tokenScanner(reversed, TokenType)("a.b")).toThrow(sucraseError);
		const stretched = (input: string) => ({ tokens: [{ type: types.name, start: 0, end: input.length + 5 }, { type: types.eof, start: input.length, end: input.length }] });
		expect(() => tokenScanner(stretched, TokenType)("a")).toThrow(sucraseError);
	});

	it("refuses a parser that no longer reports template text", () => {
		const noTemplates = (input: string, ...flags: boolean[]) => ({ tokens: realParse(input, flags[0]!, flags[1]!, flags[2]!).tokens.filter((t) => t.type !== types.template) });
		expect(() => tokenScanner(noTemplates, TokenType)("a")).toThrow(sucraseError);
	});

	it("refuses identifier spans that are not identifiers", () => {
		const shifted = (input: string, ...flags: boolean[]) => ({
			tokens: realParse(input, flags[0]!, flags[1]!, flags[2]!).tokens.map((t) => (t.type === types.name ? { ...t, end: Math.min(t.end + 1, input.length) } : t)),
		});
		expect(() => tokenScanner(shifted, TokenType)("a")).toThrow(sucraseError);
	});

	it("never blames the source for a parser crash that is not a syntax error", () => {
		const crashing = () => {
			throw new TypeError("internal parser bug");
		};
		expect(() => tokenScanner(crashing, TokenType)("a")).toThrow(TypeError);
	});
});

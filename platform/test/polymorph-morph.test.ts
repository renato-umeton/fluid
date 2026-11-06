import { parse } from "sucrase/dist/parser/index.js";
import { TokenType } from "sucrase/dist/parser/tokenizer/types.js";
import { describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import { POLYMORPH_LIST_PATH, listProblems, parsePolymorphList, usableNames } from "../src/polymorph/list.ts";
import { morphModuleMap, morphSource } from "../src/polymorph/morph.ts";
import { scanTokens, tokenScanner } from "../src/polymorph/tokens.ts";
import { ENTRY_MODULE, ForkCodeError, buildModuleMap, type ModuleMap } from "../src/runtime/modules.ts";

type SucraseToken = { type: number; start: number; end: number };
const realParse = parse as (input: string, jsx: boolean, ts: boolean, flow: boolean) => { tokens: SucraseToken[] };
const types = TokenType as unknown as Record<string, number>;

const stockFiles = stockSource.files as Record<string, string>;
const stockNames = parsePolymorphList(stockFiles[POLYMORPH_LIST_PATH]!);

/** A minimal fork module map: an app entry plus the given files. */
function forkMap(files: Record<string, string>): ModuleMap {
	return buildModuleMap({ "app/index.ts": "export default { ask() { return {}; } };", ...files });
}

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
		const lineSeparator = String.fromCharCode(0x2028);
		expect(scanTokens(`f("c\\${lineSeparator}d");`).strings).toEqual(["cd"]);
	});

	it("accepts identifiers with a zero-width joiner or non-joiner", () => {
		expect(scanTokens("const a\\u200cb = 1;").identifiers[0]!.text).toBe(`a${String.fromCharCode(0x200c)}b`);
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

describe("listProblems", () => {
	it("finds no problem with upstream's list on stock", () => {
		expect(listProblems(stockNames, buildModuleMap(stockFiles))).toEqual([]);
	});

	it("reports names that are not plain identifiers", () => {
		expect(listProblems(["a-b", "1x", "a$b", ""], forkMap({}))).toEqual([
			'"a-b" is not a valid identifier (letters, digits, and underscores, not starting with a digit; "$" marks renamed names)',
			'"1x" is not a valid identifier (letters, digits, and underscores, not starting with a digit; "$" marks renamed names)',
			'"a$b" is not a valid identifier (letters, digits, and underscores, not starting with a digit; "$" marks renamed names)',
			'"" is not a valid identifier (letters, digits, and underscores, not starting with a digit; "$" marks renamed names)',
		]);
	});

	it("reports reserved names", () => {
		expect(listProblems(["then", "floor", "fluidToml"], forkMap({}))).toEqual([
			'"then" is reserved (a keyword, a global, a property of a built-in, or a name of the runtime contract)',
			'"floor" is reserved (a keyword, a global, a property of a built-in, or a name of the runtime contract)',
			'"fluidToml" is reserved (a keyword, a global, a property of a built-in, or a name of the runtime contract)',
		]);
	});

	it("reports a name used in a string, once per module", () => {
		const map = forkMap({ "app/x.ts": 'export const read = (o: Record<string, unknown>) => [o["secretName"], "secretName" in o];' });
		expect(listProblems(["secretName"], map)).toEqual(['"secretName" appears in a string or template text in app/x.js']);
	});

	it("reports a name inside template text or a longer string, and one spelled with escapes", () => {
		const map = forkMap({
			"app/a.ts": "export const path = (k: string) => `ledger.secretName.${k}`;",
			"app/b.ts": 'export const label = "kind:otherName";',
			"app/c.ts": 'export const key = "third\\u004eame";',
		});
		expect(listProblems(["secretName", "otherName", "thirdName"], map)).toEqual([
			'"secretName" appears in a string or template text in app/a.js',
			'"otherName" appears in a string or template text in app/b.js',
			'"thirdName" appears in a string or template text in app/c.js',
		]);
	});

	it("reports a name used as a key or inside a string value of a JSON module", () => {
		const map = forkMap({ "policies/x.json": JSON.stringify({ rules: [{ secretName: 1 }, { path: "card.otherName" }] }) });
		expect(listProblems(["secretName", "otherName"], map)).toEqual([
			'"secretName" appears in a key in policies/x.json',
			'"otherName" appears in a string value in policies/x.json',
		]);
	});

	it("accepts identifiers, comments, longer words, and names no module uses", () => {
		const map = forkMap({ "app/x.ts": '// secretName is internal\nexport function secretName(secretNames: string[]) { return ["secretNamed", ...secretNames]; }' });
		expect(listProblems(["secretName", "unusedName"], map)).toEqual([]);
	});

	it("leaves the generated entry module alone", () => {
		const map = forkMap({});
		map.modules[ENTRY_MODULE] = { js: 'export const note = "secretName";' };
		expect(listProblems(["secretName"], map)).toEqual([]);
	});

	it("blames the fork, with the module path, for JavaScript that does not parse", () => {
		const map = forkMap({ "connectors/broken.js": "export const = ;" });
		expect(() => listProblems(["secretName"], map)).toThrow(ForkCodeError);
		expect(() => listProblems(["secretName"], map)).toThrow(/connectors\/broken\.js/);
	});
});

describe("usableNames", () => {
	const variants = new Map([
		["secretName", "secretName$abcd1234"],
		["otherName", "otherName$abcd1234"],
		["thirdName", "thirdName$abcd1234"],
	]);
	const jsOf = (map: ModuleMap, name: string) => (map.modules[name] as { js: string }).js;

	it("keeps every name of upstream's list usable on stock", () => {
		const stockVariants = new Map(stockNames.map((name) => [name, `${name}$abcd1234`]));
		expect(usableNames(stockVariants, buildModuleMap(stockFiles))).toEqual({ usable: stockVariants, skipped: [] });
	});

	it("skips only the name the fork's text uses, so every other name is still renamed", () => {
		const map = forkMap({
			"app/a.ts": 'export function secretName() { return 1; }\nexport const otherName = (o: Record<string, unknown>) => o["otherName"];',
			"app/b.ts": 'import { secretName, otherName } from "./a.js";\nexport const thirdName = () => [secretName(), otherName({})];',
		});
		const { usable, skipped } = usableNames(variants, map);
		expect(skipped).toEqual([{ name: "otherName", reason: "appears in a string or template text in app/a.js" }]);
		expect([...usable]).toEqual([
			["secretName", "secretName$abcd1234"],
			["thirdName", "thirdName$abcd1234"],
		]);
		const morphed = morphModuleMap(map, usable);
		expect(jsOf(morphed, "app/b.js")).toBe('import { secretName$abcd1234, otherName } from "./a.js";\nexport const thirdName$abcd1234 = () => [secretName$abcd1234(), otherName({})];');
		expect(() => morphModuleMap(map, variants)).toThrow(/"otherName" appears in a string or template text in app\/a\.js/);
	});

	it("gives one reason per skipped name, naming every place the fork's text uses it", () => {
		const map = forkMap({
			"app/a.ts": "export const path = `card.secretName`;",
			"policies/x.json": JSON.stringify({ secretName: { note: "see otherName" } }),
		});
		expect(usableNames(variants, map).skipped).toEqual([
			{ name: "secretName", reason: "appears in a string or template text in app/a.js; appears in a key in policies/x.json" },
			{ name: "otherName", reason: "appears in a string value in policies/x.json" },
		]);
	});

	it("reads neither the generated entry nor the names themselves; morphModuleMap still refuses a bad name", () => {
		const map = forkMap({});
		map.modules[ENTRY_MODULE] = { js: 'export const note = "secretName";' };
		const names = new Map([...variants, ["then", "then$abcd1234"]]);
		const { usable, skipped } = usableNames(names, map);
		expect(skipped).toEqual([]);
		expect(() => morphModuleMap(map, usable)).toThrow(/"then" is reserved/);
	});

	it("blames the fork, with the module path, for JavaScript that does not parse", () => {
		const map = forkMap({ "connectors/broken.js": "export const = ;" });
		expect(() => usableNames(variants, map)).toThrow(ForkCodeError);
		expect(() => usableNames(variants, map)).toThrow(/connectors\/broken\.js/);
	});
});

const NAMES = new Map([
	["secretName", "secretName$abcd1234"],
	["helper", "helper$0000zzzz"],
]);

describe("morphSource", () => {
	it("renames the listed identifiers in every position and changes nothing else", () => {
		const source = [
			'import { secretName, other as helper } from "./a.js";',
			"export { secretName, helper as publicHelper };",
			"export function run(input) {",
			"  const { secretName: picked, ...rest } = input;",
			"  const card = { secretName, helper: picked, [secretName]: rest };",
			"  class Box { #secretName = 1; secretName() { return this.#secretName; } }",
			"  // secretName and helper stay as they are in comments",
			'  return [input.secretName, input?.secretName, card.helper, `text secretName ${secretName.length} ${helper()}`, "secretName", Box];',
			"}",
		].join("\n");
		expect(morphSource(source, NAMES)).toBe(
			[
				'import { secretName$abcd1234, other as helper$0000zzzz } from "./a.js";',
				"export { secretName$abcd1234, helper$0000zzzz as publicHelper };",
				"export function run(input) {",
				"  const { secretName$abcd1234: picked, ...rest } = input;",
				"  const card = { secretName$abcd1234, helper$0000zzzz: picked, [secretName$abcd1234]: rest };",
				"  class Box { #secretName$abcd1234 = 1; secretName$abcd1234() { return this.#secretName$abcd1234; } }",
				"  // secretName and helper stay as they are in comments",
				'  return [input.secretName$abcd1234, input?.secretName$abcd1234, card.helper$0000zzzz, `text secretName ${secretName$abcd1234.length} ${helper$0000zzzz()}`, "secretName", Box];',
				"}",
			].join("\n"),
		);
	});

	it("keeps behavior: renamed code computes exactly what the original does", () => {
		const code = [
			"function main() {",
			"  const secretName = 2;",
			"  const helper = (x) => x * secretName;",
			"  const o = { secretName, helper, nested: { secretName: 5 } };",
			"  const { secretName: alias, ...rest } = o;",
			"  class K { #secretName = 3; secretName() { return this.#secretName + o.nested?.secretName; } }",
			"  return [o.secretName, alias, Object.keys(rest).length, new K().secretName(), `${helper(o.secretName)}`, o.helper(1), JSON.stringify(Object.values(o.nested))];",
			"}",
		].join("\n");
		const run = (js: string) => new Function(`${js}\nreturn main();`)() as unknown[];
		expect(run(morphSource(code, NAMES))).toEqual(run(code));
		expect(run(code)).toEqual([2, 2, 2, 8, "4", 2, "[5]"]);
	});

	it("renames an identifier spelled with escapes", () => {
		expect(morphSource("const secret\\u004eame = 1;", NAMES)).toBe("const secretName$abcd1234 = 1;");
	});

	it("returns the source unchanged when no listed name is used as an identifier", () => {
		const js = 'const x = "secretName"; // helper\n';
		expect(morphSource(js, NAMES)).toBe(js);
	});

	it("refuses to rename into a name the source already uses", () => {
		expect(() => morphSource("const secretName$abcd1234 = 1; secretName;", NAMES)).toThrow(/already uses "secretName\$abcd1234"/);
	});

	it("refuses a map that would merge names or produce something that is not an identifier", () => {
		expect(() => morphSource("a;", new Map([["a", "x"], ["b", "x"]]))).toThrow(/both map to "x"/);
		expect(() => morphSource("a;", new Map([["a", "not valid"]]))).toThrow(/different valid identifier/);
		expect(() => morphSource("a;", new Map([["a", "a"]]))).toThrow(/different valid identifier/);
	});

	it("throws a SyntaxError for code that does not parse", () => {
		expect(() => morphSource("export const = ;", NAMES)).toThrow(SyntaxError);
	});
});

describe("morphModuleMap", () => {
	const variants = new Map([["secretName", "secretName$abcd1234"]]);
	const jsOf = (map: ModuleMap, name: string) => (map.modules[name] as { js: string }).js;

	it("renames every JS module but the generated entry, and keeps JSON modules and the main module", () => {
		const map = forkMap({
			"app/a.ts": "export const secretName = 1;",
			"intent/b.ts": 'import { secretName } from "../app/a.js";\nexport const value = secretName;',
			"policies/c.json": '{ "limit": 3 }',
		});
		map.modules[ENTRY_MODULE] = { js: "const secretName = 1;\nexport default secretName;" };
		const morphed = morphModuleMap(map, variants);
		expect(morphed.mainModule).toBe(map.mainModule);
		expect(Object.keys(morphed.modules)).toEqual(Object.keys(map.modules));
		expect(jsOf(morphed, "app/a.js")).toBe(jsOf(map, "app/a.js").replace("secretName", "secretName$abcd1234"));
		expect(jsOf(morphed, "intent/b.js")).toBe(jsOf(map, "intent/b.js").replaceAll("secretName", "secretName$abcd1234"));
		expect(morphed.modules[ENTRY_MODULE]).toEqual(map.modules[ENTRY_MODULE]);
		expect(morphed.modules["policies/c.json"]).toEqual({ json: { limit: 3 } });
	});

	it("does not change the map it is given", () => {
		const map = forkMap({ "app/a.ts": "export const secretName = 1;" });
		const before = structuredClone(map);
		morphModuleMap(map, variants);
		expect(map).toEqual(before);
	});

	it("refuses, listing every problem, when renaming would not be safe", () => {
		const map = forkMap({ "app/a.ts": 'export const secretName = 1;\nexport const key = "secretName";' });
		const names = new Map([...variants, ["then", "then$abcd1234"]]);
		expect(() => morphModuleMap(map, names)).toThrow(/cannot rename[\s\S]*"then" is reserved[\s\S]*"secretName" appears in a string or template text in app\/a\.js/);
	});

	it("blames the fork, with the module path, for a module that does not parse", () => {
		const map = forkMap({ "connectors/broken.js": "export const = ;" });
		expect(() => morphModuleMap(map, variants)).toThrow(ForkCodeError);
		expect(() => morphModuleMap(map, variants)).toThrow(/connectors\/broken\.js/);
	});

	it("names the module when a target name is already taken", () => {
		const map = forkMap({ "app/a.ts": "export const secretName$abcd1234 = 1;\nexport const secretName = 2;" });
		expect(() => morphModuleMap(map, variants)).toThrow(/app\/a\.js: .*already uses "secretName\$abcd1234"/);
	});
});

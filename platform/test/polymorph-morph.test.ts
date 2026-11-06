import { parse } from "sucrase/dist/parser/index.js";
import sucraseBase from "sucrase/dist/parser/traverser/base.js";
import { TokenType } from "sucrase/dist/parser/tokenizer/types.js";
import { describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import { POLYMORPH_LIST_PATH, parsePolymorphList, usableNames } from "../src/polymorph/list.ts";
import { morphFork, morphModuleMap, morphSource } from "../src/polymorph/morph.ts";
import { PolymorphUnavailableError, SCAN_LIMITS, scanModuleMap, scanTokens, tokenScanner } from "../src/polymorph/tokens.ts";
import { ENTRY_MODULE, buildModuleMap, type ModuleMap } from "../src/runtime/modules.ts";

type SucraseToken = { type: number; start: number; end: number };
const realParse = parse as (input: string, jsx: boolean, ts: boolean, flow: boolean) => { tokens: SucraseToken[] };
const types = TokenType as unknown as Record<string, number>;

/** The error fn throws; fails the test when it does not throw. */
function thrown(fn: () => unknown): Error {
	try {
		fn();
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected a throw");
}

/** The source of a JS module of a module map. */
function jsOf(map: ModuleMap, name: string): string {
	return (map.modules[name] as { js: string }).js;
}

/** Runs main() of a self-contained module (one without imports). */
function runMain(js: string): unknown {
	return new Function(`${js.replace(/^export /gm, "")}\nreturn main();`)();
}

/** fn reports that the fork cannot be renamed, with a message matching message. */
function expectUnavailable(fn: () => unknown, message: RegExp): Error {
	const error = thrown(fn);
	expect(error).toBeInstanceOf(PolymorphUnavailableError);
	expect(error.message).toMatch(message);
	return error;
}

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

	it("reads string module export and import names as text, not as identifiers", () => {
		expect(scanTokens('const a = 1; export { a as "some name" };')).toMatchObject({ strings: ["some name"] });
		expect(scanTokens('const a = 1; export { a as "some name" };').identifiers.map((token) => token.text)).toEqual(["a", "a", "as"]);
		expect(scanTokens("import { 'evi\\x64ence' as x } from \"./a.js\";")).toMatchObject({ strings: ["evidence", "./a.js"] });
	});

	it("accepts identifiers with a zero-width joiner or non-joiner", () => {
		expect(scanTokens("const a\\u200cb = 1;").identifiers[0]!.text).toBe(`a${String.fromCharCode(0x200c)}b`);
	});

	it("reads regular expression literals as text of their own, and comments not at all", () => {
		expect(scanTokens('/abc"d/.test(x); // "note" y\n/* `z` */')).toEqual({
			identifiers: [{ start: 8, end: 12, text: "test" }, { start: 13, end: 14, text: "x" }],
			strings: [],
			regexes: ['/abc"d/'],
		});
	});

	it("reads a regex escape as a word break, except a character escape, which it decodes", () => {
		expect(scanTokens("/(?<weightKg>\\d+) kg/.exec(t); /\\bevidence\\b/; /\\x61b\\x63/u;").regexes).toEqual(["/(?<weightKg> +) kg/", "/ evidence /", "/abc/u"]);
	});

	it("cannot read code sucrase does not parse, TypeScript included, and keeps the parser's error as cause", () => {
		const error = expectUnavailable(() => scanTokens("export const = ;"), /sucrase cannot parse this JavaScript: Unexpected token/);
		expect(error.cause).toBeInstanceOf(SyntaxError);
		expectUnavailable(() => scanTokens("const a: number = 1;"), /cannot parse/);
	});

	it("cannot read code nested deeper than the parser's stack allows", () => {
		const deep = `export const x = ${"[".repeat(10_000)}${"]".repeat(10_000)};`;
		const error = expectUnavailable(() => scanTokens(deep), /cannot parse/);
		expect(error.cause).toBeInstanceOf(RangeError);
	});
});

describe("tokenScanner fails loudly when sucrase changes shape", () => {
	const sucrase = /sucrase/;

	it("refuses a parser module without parse()", () => {
		expectUnavailable(() => tokenScanner(undefined, TokenType)("a"), sucrase);
	});

	it("refuses token types it does not know", () => {
		expectUnavailable(() => tokenScanner(parse, { name: 1, string: 2 })("a"), sucrase);
		expectUnavailable(() => tokenScanner(parse, { ...types, template: types.name })("a"), sucrase);
	});

	it("refuses output without a token array", () => {
		expectUnavailable(() => tokenScanner(() => ({ tokens: null }), TokenType)("a"), sucrase);
	});

	it("refuses tokens out of order or outside the source", () => {
		const reversed = (input: string, ...flags: boolean[]) => {
			const { tokens } = realParse(input, flags[0]!, flags[1]!, flags[2]!);
			return { tokens: [...tokens.slice(0, -1).reverse(), tokens.at(-1)] };
		};
		expectUnavailable(() => tokenScanner(reversed, TokenType)("a.b"), sucrase);
		const stretched = (input: string) => ({ tokens: [{ type: types.name, start: 0, end: input.length + 5 }, { type: types.eof, start: input.length, end: input.length }] });
		expectUnavailable(() => tokenScanner(stretched, TokenType)("a"), sucrase);
	});

	it("refuses a parser that no longer reports template text", () => {
		const noTemplates = (input: string, ...flags: boolean[]) => ({ tokens: realParse(input, flags[0]!, flags[1]!, flags[2]!).tokens.filter((t) => t.type !== types.template) });
		expectUnavailable(() => tokenScanner(noTemplates, TokenType)("a"), sucrase);
	});

	it("refuses a parser that no longer reports regular expressions", () => {
		const noRegexes = (input: string, ...flags: boolean[]) => ({ tokens: realParse(input, flags[0]!, flags[1]!, flags[2]!).tokens.filter((t) => t.type !== types.regexp) });
		expectUnavailable(() => tokenScanner(noRegexes, TokenType)("a"), sucrase);
	});

	it("refuses identifier spans that are not identifiers", () => {
		const shifted = (input: string, ...flags: boolean[]) => ({
			tokens: realParse(input, flags[0]!, flags[1]!, flags[2]!).tokens.map((t) => (t.type === types.name ? { ...t, end: Math.min(t.end + 1, input.length) } : t)),
		});
		expectUnavailable(() => tokenScanner(shifted, TokenType)("a"), sucrase);
	});

	it("reports a crash of the parser itself the same way, with the crash as cause", () => {
		const crashing = () => {
			throw new TypeError("internal parser bug");
		};
		expect(expectUnavailable(() => tokenScanner(crashing, TokenType)("a"), sucrase).cause).toBeInstanceOf(TypeError);
	});
});

/** Names with this test's fixed per-copy suffix. */
function suffixed(...listed: string[]): Map<string, string> {
	return new Map(listed.map((name) => [name, `${name}$abcd1234`]));
}

describe("scanModuleMap", () => {
	it("reads every JS module but the generated entry, and no JSON module", () => {
		const map = forkMap({ "app/a.ts": "export const a = 1;", "policies/x.json": "{}" });
		expect([...scanModuleMap(map).keys()]).toEqual(["app/index.js", "app/a.js"]);
		expect(scanModuleMap(map).get("app/a.js")?.identifiers.map((token) => token.text)).toEqual(["a"]);
	});

	it("will not read a module larger than it can afford, and names it", () => {
		const map = forkMap({ "app/big.js": `export const s = "${"x".repeat(SCAN_LIMITS.moduleChars)}";` });
		expectUnavailable(() => scanModuleMap(map), /^app\/big\.js: .*more than the 262144 characters/);
	});

	it("will not read more JavaScript in all than it can afford", () => {
		const part = `export const s = "${"x".repeat(SCAN_LIMITS.moduleChars - 100)}";`;
		const files = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`app/part${i}.js`, part]));
		expectUnavailable(() => scanModuleMap(forkMap(files)), /more than the 1048576 characters of JavaScript/);
	});

	it("cannot read a module sucrase does not parse, and names it", () => {
		expectUnavailable(() => scanModuleMap(forkMap({ "connectors/broken.js": "export const = ;" })), /^connectors\/broken\.js: .*cannot parse/);
	});

	it("leaves no token array behind in the parser once it has read a module", () => {
		scanTokens(`export const s = [${"1, ".repeat(10_000)}];`);
		expect((sucraseBase as { state: { tokens: unknown[] } }).state.tokens.length).toBeLessThan(5);
	});
});

describe("usableNames reads the fork's text", () => {
	it("skips a name used in a string, with one reason per module however often", () => {
		const map = forkMap({ "app/x.ts": 'export const read = (o: Record<string, unknown>) => [o["secretName"], "secretName" in o];' });
		expect(usableNames(suffixed("secretName"), map).skipped).toEqual([{ name: "secretName", reason: "appears in a string or template text in app/x.js" }]);
	});

	it("skips a name inside template text or a longer string, and one spelled with escapes", () => {
		const map = forkMap({
			"app/a.ts": "export const path = (k: string) => `ledger.secretName.${k}`;",
			"app/b.ts": 'export const label = "kind:otherName";',
			"app/c.ts": 'export const key = "third\\x4eame";',
		});
		expect(usableNames(suffixed("secretName", "otherName", "thirdName"), map).skipped).toEqual([
			{ name: "secretName", reason: "appears in a string or template text in app/a.js" },
			{ name: "otherName", reason: "appears in a string or template text in app/b.js" },
			{ name: "thirdName", reason: "appears in a string or template text in app/c.js" },
		]);
	});

	it("skips a name used as a key or inside a string value of a JSON module", () => {
		const map = forkMap({ "policies/x.json": JSON.stringify({ rules: [{ secretName: 1 }, { path: "card.otherName" }] }) });
		expect(usableNames(suffixed("secretName", "otherName"), map).skipped).toEqual([
			{ name: "secretName", reason: "appears in a key in policies/x.json" },
			{ name: "otherName", reason: "appears in a string value in policies/x.json" },
		]);
	});

	it("keeps a name used only as an identifier, in a comment, inside a longer word, or nowhere", () => {
		const map = forkMap({ "app/x.ts": '// secretName is internal\nexport function secretName(secretNames: string[]) { return ["secretNamed", ...secretNames]; }' });
		expect(usableNames(suffixed("secretName", "unusedName"), map).skipped).toEqual([]);
	});
});

describe("usableNames", () => {
	const variants = new Map([
		["secretName", "secretName$abcd1234"],
		["otherName", "otherName$abcd1234"],
		["thirdName", "thirdName$abcd1234"],
	]);

	it("keeps every name of upstream's list usable on stock", () => {
		const stockVariants = new Map(stockNames.map((name) => [name, `${name}$abcd1234`]));
		expect(usableNames(stockVariants, buildModuleMap(stockFiles))).toEqual({ usable: stockVariants, skipped: [] });
	});

	it("skips names this runtime builds in, such as globals and members of host APIs", () => {
		const builtIns = ["URL", "fetch", "encode", "json", "searchParams", "randomUUID"];
		const { usable, skipped } = usableNames(new Map([...builtIns, "secretName"].map((name) => [name, `${name}$abcd1234`])), forkMap({}));
		expect(skipped).toEqual(builtIns.map((name) => ({ name, reason: "a built-in name in this runtime" })));
		expect([...usable.keys()]).toEqual(["secretName"]);
	});

	it("keeps a host API call working when its member name is listed", () => {
		const map = forkMap({ "app/a.ts": "function encode(s: string) { return new TextEncoder().encode(s).length; }\nexport function main() { return encode('abc'); }" });
		const { usable, skipped } = usableNames(new Map([["encode", "encode$abcd1234"]]), map);
		expect(skipped).toEqual([{ name: "encode", reason: "a built-in name in this runtime" }]);
		expect(runMain(jsOf(morphModuleMap(map, usable), "app/a.js"))).toBe(3);
	});

	it("gives every reason a name is skipped, the runtime's first", () => {
		const map = forkMap({ "app/a.ts": 'export const kind = "json";' });
		expect(usableNames(new Map([["json", "json$abcd1234"]]), map).skipped).toEqual([
			{ name: "json", reason: "a built-in name in this runtime; appears in a string or template text in app/a.js" },
		]);
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
		expect(() => morphModuleMap(map, variants)).toThrow(/"otherName": appears in a string or template text in app\/a\.js/);
	});

	it("skips a name a regular expression mentions, so a named group read back as a property keeps working", () => {
		const map = forkMap({ "app/a.ts": 'export function main() { const m = /(?<secretName>\\d+) kg/.exec("70 kg"); return Number(m?.groups?.secretName); }' });
		const { usable, skipped } = usableNames(variants, map);
		expect(skipped).toEqual([{ name: "secretName", reason: "appears in a regular expression in app/a.js" }]);
		expect(runMain(jsOf(morphModuleMap(map, usable), "app/a.js"))).toBe(70);
		expect(runMain(jsOf(map, "app/a.js"))).toBe(70);
	});

	it("skips a name another module imports by its string name", () => {
		const map = forkMap({
			"app/a.ts": "export const secretName = 1;",
			"app/b.ts": 'import { "secretName" as value } from "./a.js";\nexport const read = () => value;',
		});
		expect(usableNames(variants, map).skipped).toEqual([{ name: "secretName", reason: "appears in a string or template text in app/b.js" }]);
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
		const names = new Map([...variants, ["fluidToml", "fluidToml$abcd1234"]]);
		const { usable, skipped } = usableNames(names, map);
		expect(skipped).toEqual([]);
		expect(() => morphModuleMap(map, usable)).toThrow(/"fluidToml" is reserved/);
	});

	it("cannot check a module sucrase does not parse, and names it", () => {
		const map = forkMap({ "connectors/broken.js": "export const = ;" });
		expectUnavailable(() => usableNames(variants, map), /^connectors\/broken\.js: .*cannot parse/);
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

	it("cannot rename into a name the source already uses, and does not echo that secret name", () => {
		const error = expectUnavailable(() => morphSource("const secretName$abcd1234 = 1; secretName;", NAMES), /already uses this copy's renamed name for "secretName"/);
		expect(error.message).not.toContain("abcd1234");
	});

	it.each([
		["another name", "x"],
		["the name itself", "a"],
		["a keyword", "if"],
		["another listed name with a suffix", "b$abcd1234"],
		["a suffix in capitals", "a$ABCD1234"],
		["a short suffix", "a$abc"],
	])("refuses a target that is %s instead of the listed name with a per-copy suffix", (_label, target) => {
		const error = thrown(() => morphSource("a;", new Map([["a", target]])));
		expect(error.message).toMatch(/"a" must map to "a" followed by "\$" and eight base36 characters/);
		expect(error.message).not.toContain(target === "a" ? "a$" : target);
	});

	it("cannot rename code sucrase does not parse", () => {
		expectUnavailable(() => morphSource("export const = ;", NAMES), /cannot parse/);
	});
});

describe("morphModuleMap", () => {
	const variants = new Map([["secretName", "secretName$abcd1234"]]);

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

	it("refuses a name no list could hold before it reads any module", () => {
		const map = forkMap({ "connectors/broken.js": "export const = ;" });
		expect(() => morphModuleMap(map, new Map([...variants, ["fluidToml", "fluidToml$abcd1234"]]))).toThrow(/"fluidToml" is reserved/);
	});

	it("refuses, listing every reason, any name it would have to skip", () => {
		const map = forkMap({ "app/a.ts": 'export const secretName = 1;\nexport const key = "secretName";' });
		const names = new Map([...variants, ["json", "json$abcd1234"]]);
		expect(() => morphModuleMap(map, names)).toThrow(/cannot rename[\s\S]*"secretName": appears in a string or template text in app\/a\.js[\s\S]*"json": a built-in name in this runtime/);
	});

	it("cannot rename a module sucrase does not parse, and names it", () => {
		const map = forkMap({ "connectors/broken.js": "export const = ;" });
		expectUnavailable(() => morphModuleMap(map, variants), /^connectors\/broken\.js: .*cannot parse/);
	});

	it("names the module when a target name is already taken", () => {
		const map = forkMap({ "app/a.ts": "export const secretName$abcd1234 = 1;\nexport const secretName = 2;" });
		const error = expectUnavailable(() => morphModuleMap(map, variants), /^app\/a\.js: .*already uses this copy's renamed name for "secretName"/);
		expect(error.message).not.toContain("abcd1234");
	});
});

describe("morphFork", () => {
	it("renames the usable names, skips the rest, and says which and why", () => {
		const map = forkMap({
			"app/a.ts": 'export function secretName() { return 1; }\nexport const otherName = (o: Record<string, unknown>) => o["otherName"];',
			"app/b.ts": 'import { secretName, otherName } from "./a.js";\nexport const thirdName = () => [secretName(), otherName({}), new URL("https://x.test/").searchParams];',
		});
		const result = morphFork(map, suffixed("secretName", "otherName", "thirdName", "searchParams"));
		expect(result.skipped).toEqual([
			{ name: "otherName", reason: "appears in a string or template text in app/a.js" },
			{ name: "searchParams", reason: "a built-in name in this runtime" },
		]);
		expect(result.usable).toEqual(suffixed("secretName", "thirdName"));
		expect(jsOf(result.map, "app/b.js")).toBe(
			'import { secretName$abcd1234, otherName } from "./a.js";\nexport const thirdName$abcd1234 = () => [secretName$abcd1234(), otherName({}), new URL("https://x.test/").searchParams];',
		);
	});

	it("keeps JSON modules, the generated entry, and the main module, and leaves its input alone", () => {
		const map = forkMap({ "app/a.ts": "export const secretName = 1;", "policies/c.json": '{ "limit": 3 }' });
		const before = structuredClone(map);
		const result = morphFork(map, suffixed("secretName"));
		expect(result.map.mainModule).toBe(ENTRY_MODULE);
		expect(result.map.modules[ENTRY_MODULE]).toEqual(map.modules[ENTRY_MODULE]);
		expect(result.map.modules["policies/c.json"]).toEqual({ json: { limit: 3 } });
		expect(jsOf(result.map, "app/a.js")).toContain("secretName$abcd1234");
		expect(map).toEqual(before);
	});

	it("only takes a fork module map, whose main module is the generated entry", () => {
		expect(() => morphFork({ ...forkMap({}), mainModule: "app/index.js" }, suffixed("secretName"))).toThrow(/main module/);
	});

	it("refuses a name no list could hold, and a target that is not a per-copy name", () => {
		expect(() => morphFork(forkMap({}), suffixed("fluidToml"))).toThrow(/"fluidToml" is reserved/);
		expect(() => morphFork(forkMap({}), new Map([["secretName", "other"]]))).toThrow(/"secretName" must map to "secretName" followed by/);
	});

	it("cannot make a copy when a module already uses a renamed name, and names the module", () => {
		const map = forkMap({ "app/a.ts": "export const secretName$abcd1234 = 1;\nexport const secretName = 2;" });
		const error = expectUnavailable(() => morphFork(map, suffixed("secretName")), /^app\/a\.js: .*already uses this copy's renamed name for "secretName"/);
		expect(error.message).not.toContain("abcd1234");
	});
});

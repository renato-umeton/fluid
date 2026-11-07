// Identifier and string tokens of a JavaScript module, read with sucrase's
// parser: it is already bundled into the Worker and is the only parser that
// runs there. Its token API is internal (no public entry point), so this
// adapter checks everything it relies on and fails loudly, rather than let a
// sucrase upgrade silently change what gets renamed. It imports the parser
// from sucrase's ES module build, the one the Worker bundle already holds for
// transform, so the bundle carries a single parser.
import { parse } from "sucrase/dist/esm/parser/index.js";
import { TokenType } from "sucrase/dist/esm/parser/tokenizer/types.js";
import { ENTRY_MODULE, type ModuleMap } from "../runtime/modules.ts";
import { PolymorphUnavailableError } from "./errors.ts";

export interface IdentifierToken {
	/** Offsets of the token in the source (end exclusive). */
	start: number;
	end: number;
	/** The identifier's name, with any unicode escapes decoded. */
	text: string;
}

export interface SourceTokens {
	/** Every identifier token in source order: bindings, references, property and member names, import and export names. */
	identifiers: IdentifierToken[];
	/** Decoded values of string literals, string module names, and template text, in source order. */
	strings: string[];
	/** Regular expression literals as text: character escapes decoded, any other escape read as a space. */
	regexes: string[];
}

// Defined with the other reasons a copy cannot be made (errors.ts); exported here too, where it was first.
export { PolymorphUnavailableError };

/** Reads the tokens of plain JavaScript (no TypeScript, no JSX). Throws PolymorphUnavailableError when it cannot. */
export const scanTokens = tokenScanner(parse, TokenType);

/**
 * How much text the renamer reads, so a copy fits in a 128 MB Worker:
 * sucrase holds about 48 bytes per source character while it parses one
 * module, and the tokens kept for every module add about 7 more. A JSON
 * module counts toward the same limits, since the skip step reads every key
 * and string of it. Stock's runtime is about 60 KB of JavaScript and 10 KB
 * of JSON.
 */
export const SCAN_LIMITS = { moduleChars: 256 * 1024, totalChars: 1024 * 1024 } as const;

/**
 * The tokens of every JS module a copy renames (all but the generated entry),
 * read once each, keyed by module path. Throws PolymorphUnavailableError,
 * naming the module where there is one, when the code and JSON are larger
 * than SCAN_LIMITS (checked before any module is parsed) or cannot be read.
 */
export function scanModuleMap(map: ModuleMap): Map<string, SourceTokens> {
	const modules = Object.entries(map.modules).flatMap(([path, module]) => (path !== ENTRY_MODULE && "js" in module ? [{ path, js: module.js }] : []));
	let total = 0;
	for (const [path, module] of Object.entries(map.modules)) {
		if (path === ENTRY_MODULE) continue;
		if ("js" in module) {
			if (module.js.length > SCAN_LIMITS.moduleChars) throw new PolymorphUnavailableError(`${path}: polymorph: the module has ${module.js.length} characters, more than the ${SCAN_LIMITS.moduleChars} characters the renamer reads in one module`);
			total += module.js.length;
			continue;
		}
		const size = jsonTextSize(module.json, SCAN_LIMITS.moduleChars);
		if (size > SCAN_LIMITS.moduleChars) throw new PolymorphUnavailableError(`${path}: polymorph: the module has more than the ${SCAN_LIMITS.moduleChars} characters of keys and strings the renamer reads in one module`);
		total += size;
	}
	if (total > SCAN_LIMITS.totalChars) throw new PolymorphUnavailableError(`polymorph: the fork has ${total} characters of JavaScript and JSON text, more than the ${SCAN_LIMITS.totalChars} characters of JavaScript and JSON text the renamer reads`);
	const scanned = new Map<string, SourceTokens>();
	for (const { path, js } of modules) {
		try {
			scanned.set(path, scanTokens(js));
		} catch (error) {
			if (error instanceof PolymorphUnavailableError) throw new PolymorphUnavailableError(`${path}: ${error.message}`, { cause: error });
			throw error;
		}
	}
	return scanned;
}

/**
 * The size of a JSON value as the skip step reads it: the characters of every
 * key and string, and one for every other value, so a long array of numbers
 * counts too. Every visit counts at least one, so counting stops soon after
 * passing limit.
 */
function jsonTextSize(value: unknown, limit: number): number {
	let size = 0;
	walkJson(value, (kind, text) => {
		size += kind === "other" ? 1 : Math.max(1, text.length);
		return size <= limit;
	});
	return size;
}

interface JsonCursor {
	container: unknown[] | Record<string, unknown>;
	/** An object's keys; null for an array. */
	keys: string[] | null;
	next: number;
}

/**
 * Visits a JSON value depth first in document order: each object key and
 * then its value, each array element, and every string. visit gets "other"
 * (and no text) for a number, boolean, null, array, or object, and returns
 * false to stop. Iterative, with one cursor per nesting level, so neither deep
 * nesting nor a long array costs more than that.
 */
export function walkJson(value: unknown, visit: (kind: "key" | "string" | "other", text: string) => boolean): void {
	const cursors: JsonCursor[] = [];
	const enter = (item: unknown): boolean => {
		if (typeof item === "string") return visit("string", item);
		if (Array.isArray(item)) cursors.push({ container: item, keys: null, next: 0 });
		else if (typeof item === "object" && item !== null) cursors.push({ container: item as Record<string, unknown>, keys: Object.keys(item), next: 0 });
		return visit("other", "");
	};
	if (!enter(value)) return;
	while (cursors.length > 0) {
		const cursor = cursors[cursors.length - 1]!;
		const { container, keys } = cursor;
		if (cursor.next >= (keys ?? (container as unknown[])).length) {
			cursors.pop();
			continue;
		}
		const index = cursor.next++;
		if (keys === null) {
			if (!enter((container as unknown[])[index])) return;
			continue;
		}
		const key = keys[index]!;
		if (!visit("key", key) || !enter((container as Record<string, unknown>)[key])) return;
	}
}

interface TokenKinds {
	name: number;
	string: number;
	template: number;
	regexp: number;
	eof: number;
}

type Parse = (input: string, isJSXEnabled: boolean, isTypeScriptEnabled: boolean, isFlowEnabled: boolean) => unknown;

/**
 * A token reader over a sucrase-style parser module. The module's exports and
 * its reading of a fixed sample are checked on first use rather than at
 * import, so a broken parser fails polymorph work without taking the Worker
 * down with it.
 */
export function tokenScanner(parseFn: unknown, tokenTypes: unknown): (js: string) => SourceTokens {
	let kinds: TokenKinds | null = null;
	const read = (js: string, checked: TokenKinds): SourceTokens => {
		const tokens = readTokens(js, runParser(parseFn as Parse, js), checked);
		// Sucrase keeps its last token array in module state until the next
		// parse; parsing an empty module lets the large one be collected now.
		runParser(parseFn as Parse, "");
		return tokens;
	};
	return (js) => {
		if (typeof js !== "string") throw new TypeError("scanTokens: source must be a string");
		if (kinds === null) {
			const checked = tokenKinds(parseFn, tokenTypes);
			checkSample(read(SAMPLE, checked));
			kinds = checked;
		}
		return read(js, kinds);
	};
}

function shapeError(detail: string): PolymorphUnavailableError {
	return new PolymorphUnavailableError(`polymorph: sucrase's parser output is not what the token adapter expects (${detail}); renaming would not be safe`);
}

function tokenKinds(parseFn: unknown, tokenTypes: unknown): TokenKinds {
	if (typeof parseFn !== "function") throw shapeError("parse is not a function");
	const table = (tokenTypes ?? {}) as Record<string, unknown>;
	const kinds = { name: table.name, string: table.string, template: table.template, regexp: table.regexp, eof: table.eof };
	for (const [key, value] of Object.entries(kinds)) {
		if (typeof value !== "number") throw shapeError(`TokenType.${key} is not a number`);
	}
	if (new Set(Object.values(kinds)).size !== Object.keys(kinds).length) throw shapeError("TokenType.name, string, template, regexp, and eof are not distinct");
	return kinds as TokenKinds;
}

function runParser(parseFn: Parse, js: string): unknown {
	try {
		return parseFn(js, false, false, false);
	} catch (error) {
		// A syntax sucrase does not support, nesting deeper than its recursion can
		// go, or a bug of its own: V8 may still run this code, so it is never the
		// fork's fault, only a reason this copy cannot be renamed.
		throw new PolymorphUnavailableError(`polymorph: sucrase cannot parse this JavaScript: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

function readTokens(js: string, parsed: unknown, kinds: TokenKinds): SourceTokens {
	const tokens = (parsed as { tokens?: unknown } | null)?.tokens;
	if (!Array.isArray(tokens) || tokens.length === 0) throw shapeError("parse() returned no token array");
	const identifiers: IdentifierToken[] = [];
	const strings: string[] = [];
	const regexes: string[] = [];
	let previousEnd = 0;
	for (const [index, token] of tokens.entries()) {
		const { type, start, end } = (token ?? {}) as { type?: unknown; start?: unknown; end?: unknown };
		if (typeof type !== "number" || typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end)) {
			throw shapeError(`token ${index} has no numeric type, start, and end`);
		}
		if (start < previousEnd || end < start || end > js.length) throw shapeError(`token ${index} spans ${start} to ${end}, out of order or outside the source`);
		previousEnd = end;
		const raw = js.slice(start, end);
		// A string module export or import name (export { a as "b" }) comes as a name token with its quotes: it is text.
		const quotedName = type === kinds.name && (raw[0] === '"' || raw[0] === "'");
		if (type === kinds.string || quotedName) strings.push(stringValue(raw, index));
		else if (type === kinds.name) identifiers.push({ start, end, text: identifierText(raw, index) });
		else if (type === kinds.template) strings.push(templateText(js, start, end, index));
		else if (type === kinds.regexp) regexes.push(regexText(raw, index));
	}
	if ((tokens[tokens.length - 1] as { type?: unknown }).type !== kinds.eof) throw shapeError("the last token is not the end of the file");
	return { identifiers, strings, regexes };
}

// An ECMAScript identifier name: ID_Start, "$", or "_", then ID_Continue, "$",
// or the two join controls (zero-width non-joiner and joiner).
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\p{Join_Control}]*$/u;

function identifierText(raw: string, index: number): string {
	const text = decodeEscapes(raw);
	if (!IDENTIFIER.test(text)) throw shapeError(`identifier token ${index} reads ${JSON.stringify(raw)}`);
	return text;
}

function stringValue(raw: string, index: number): string {
	const quote = raw[0];
	if (raw.length < 2 || (quote !== '"' && quote !== "'") || raw[raw.length - 1] !== quote) throw shapeError(`string token ${index} reads ${JSON.stringify(raw)}`);
	return decodeEscapes(raw.slice(1, -1));
}

/** Template text sits between a backquote or the "}" closing a substitution and a backquote or "${". */
function templateText(js: string, start: number, end: number, index: number): string {
	const opens = js[start - 1] === "`" || js[start - 1] === "}";
	const closes = js[end] === "`" || js.startsWith("${", end);
	if (!opens || !closes) throw shapeError(`template token ${index} at ${start} is not delimited by a template`);
	return decodeEscapes(js.slice(start, end));
}

const REGEX_ESCAPE = /\\(?:u\{([0-9A-Fa-f]+)\}|u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2})|[\s\S])/g;

/**
 * A regex literal as text. Character escapes are decoded; every other escape
 * (\d, \b, \k, ...) reads as a space, so the words around it, such as a named
 * group read back later as a property, stay whole.
 */
function regexText(raw: string, index: number): string {
	if (raw.length < 2 || raw[0] !== "/" || raw.lastIndexOf("/") === 0) throw shapeError(`regular expression token ${index} reads ${JSON.stringify(raw)}`);
	return raw.replace(REGEX_ESCAPE, (_match, braced?: string, four?: string, two?: string) =>
		braced === undefined && four === undefined && two === undefined ? " " : characterOf(braced, four ?? two),
	);
}

/** The character a \u{...} (braced) or a \uXXXX or \xXX (hex) escape names. */
function characterOf(braced: string | undefined, hex: string | undefined): string {
	if (braced === undefined) return String.fromCharCode(parseInt(hex ?? "", 16));
	const codePoint = parseInt(braced, 16);
	return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : REPLACEMENT_CHARACTER;
}

const ESCAPE = /\\(?:u\{([0-9A-Fa-f]+)\}|u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2})|(\r\n|[\s\S]))/g;
// A backslash before a line terminator continues the line and stands for nothing.
const LINE_TERMINATORS = ["\n", "\r", "\r\n", String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
const SINGLE_ESCAPES: Record<string, string> = {
	n: "\n",
	r: "\r",
	t: "\t",
	b: "\b",
	f: "\f",
	v: "\v",
	"0": "\0",
	...Object.fromEntries(LINE_TERMINATORS.map((terminator) => [terminator, ""])),
};
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

/** Decodes JavaScript escapes, so a name spelled with escapes in a string still counts as that name. */
function decodeEscapes(text: string): string {
	return text.replace(ESCAPE, (_match, braced?: string, four?: string, two?: string, other?: string) => {
		if (braced !== undefined || four !== undefined || two !== undefined) return characterOf(braced, four ?? two);
		return Object.hasOwn(SINGLE_ESCAPES, other!) ? SINGLE_ESCAPES[other!]! : other!;
	});
}

// A fixed sample covering every token the renamer relies on: import and
// export names (string names too), member names after "." and "?.", object
// keys and shorthand, computed keys, template text and substitutions, private
// class members, an escaped identifier, and a regular expression. If sucrase
// ever reads it differently, renaming stops.
const SAMPLE = 'import { a as b } from "./m.js";\nexport const c = { d: b?.e, f, [g]: `h${i.j}k`, "l": 1 };\nclass M { #n = 1; o() { return this.#n; } }\np\\u0071;\nexport { c as "v w" };\nconst r = /(?<q>s)\\d/g;\n';
const SAMPLE_IDENTIFIERS = ["a", "as", "b", "from", "c", "d", "b", "e", "f", "g", "i", "j", "M", "n", "o", "n", "pq", "c", "as", "r"];
const SAMPLE_STRINGS = ["./m.js", "h", "k", "l", "v w"];
const SAMPLE_REGEXES = ["/(?<q>s) /g"];

function checkSample({ identifiers, strings, regexes }: SourceTokens): void {
	const read = { identifiers: identifiers.map((token) => token.text), strings, regexes };
	if (JSON.stringify(read) !== JSON.stringify({ identifiers: SAMPLE_IDENTIFIERS, strings: SAMPLE_STRINGS, regexes: SAMPLE_REGEXES })) {
		throw shapeError(`a fixed sample read as ${JSON.stringify(read)}`);
	}
}

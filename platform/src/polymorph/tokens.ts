// Identifier and string tokens of a JavaScript module, read with sucrase's
// parser: it is already bundled into the Worker and is the only parser that
// runs there. Its token API is internal (no public entry point), so this
// adapter checks everything it relies on and fails loudly, rather than let a
// sucrase upgrade silently change what gets renamed.
import { parse } from "sucrase/dist/parser/index.js";
import { TokenType } from "sucrase/dist/parser/tokenizer/types.js";

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
	/** Decoded values of string literals and template text, in source order. */
	strings: string[];
}

/**
 * This fork cannot be renamed safely: the renamer cannot read its code (a
 * module sucrase does not parse or that nests deeper than the parser's stack,
 * more code than the renamer reads), or the parser no longer reads code the
 * way the renamer relies on. Callers run the plain fork and log the reason, so
 * a fork's owner only ever sees the errors that loading already reports.
 */
export class PolymorphUnavailableError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "PolymorphUnavailableError";
	}
}

/** Reads the tokens of plain JavaScript (no TypeScript, no JSX). Throws PolymorphUnavailableError when it cannot. */
export const scanTokens = tokenScanner(parse, TokenType);

interface TokenKinds {
	name: number;
	string: number;
	template: number;
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
	return (js) => {
		if (typeof js !== "string") throw new TypeError("scanTokens: source must be a string");
		if (kinds === null) {
			const checked = tokenKinds(parseFn, tokenTypes);
			checkSample(readTokens(SAMPLE, runParser(parseFn as Parse, SAMPLE), checked));
			kinds = checked;
		}
		return readTokens(js, runParser(parseFn as Parse, js), kinds);
	};
}

function shapeError(detail: string): PolymorphUnavailableError {
	return new PolymorphUnavailableError(`polymorph: sucrase's parser output is not what the token adapter expects (${detail}); renaming would not be safe`);
}

function tokenKinds(parseFn: unknown, tokenTypes: unknown): TokenKinds {
	if (typeof parseFn !== "function") throw shapeError("parse is not a function");
	const table = (tokenTypes ?? {}) as Record<string, unknown>;
	const kinds = { name: table.name, string: table.string, template: table.template, eof: table.eof };
	for (const [key, value] of Object.entries(kinds)) {
		if (typeof value !== "number") throw shapeError(`TokenType.${key} is not a number`);
	}
	if (new Set(Object.values(kinds)).size !== 4) throw shapeError("TokenType.name, string, template, and eof are not distinct");
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
	}
	if ((tokens[tokens.length - 1] as { type?: unknown }).type !== kinds.eof) throw shapeError("the last token is not the end of the file");
	return { identifiers, strings };
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
		if (braced !== undefined) {
			const codePoint = parseInt(braced, 16);
			return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : REPLACEMENT_CHARACTER;
		}
		if (four !== undefined) return String.fromCharCode(parseInt(four, 16));
		if (two !== undefined) return String.fromCharCode(parseInt(two, 16));
		return Object.hasOwn(SINGLE_ESCAPES, other!) ? SINGLE_ESCAPES[other!]! : other!;
	});
}

// A fixed sample covering every token the renamer relies on: import and
// export names (string names too), member names after "." and "?.", object
// keys and shorthand, computed keys, template text and substitutions, private
// class members, and an escaped identifier. If sucrase ever reads it
// differently, renaming stops.
const SAMPLE = 'import { a as b } from "./m.js";\nexport const c = { d: b?.e, f, [g]: `h${i.j}k`, "l": 1 };\nclass M { #n = 1; o() { return this.#n; } }\np\\u0071;\nexport { c as "v w" };\n';
const SAMPLE_IDENTIFIERS = ["a", "as", "b", "from", "c", "d", "b", "e", "f", "g", "i", "j", "M", "n", "o", "n", "pq", "c", "as"];
const SAMPLE_STRINGS = ["./m.js", "h", "k", "l", "v w"];

function checkSample({ identifiers, strings }: SourceTokens): void {
	const names = identifiers.map((token) => token.text);
	if (JSON.stringify(names) !== JSON.stringify(SAMPLE_IDENTIFIERS) || JSON.stringify(strings) !== JSON.stringify(SAMPLE_STRINGS)) {
		throw shapeError(`a fixed sample read as identifiers ${JSON.stringify(names)} and strings ${JSON.stringify(strings)}`);
	}
}

// Upstream's list of internal names that a polymorphic copy renames, and the
// checks that make renaming them safe for a given module map. Renaming
// touches identifier tokens only, so a listed name must never be a name the
// language, the runtime, or the platform reads, and never reach the code as
// text: a string, template text, or JSON key or value could be read back as a
// property name at run time, and that use would not be renamed.
import { ENTRY_MODULE, ForkCodeError, type ModuleMap } from "../runtime/modules.ts";
import { scanTokens } from "./tokens.ts";

/** Where stock publishes the list. */
export const POLYMORPH_LIST_PATH = "polymorph.json";

/** Parses polymorph.json: { version: 1, description?, names: string[] } with no name listed twice. */
export function parsePolymorphList(text: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${POLYMORPH_LIST_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${POLYMORPH_LIST_PATH} must be a JSON object`);
	const { version, names } = parsed as { version?: unknown; names?: unknown };
	if (version !== 1) throw new Error(`${POLYMORPH_LIST_PATH}: version must be 1, got ${JSON.stringify(version)}`);
	if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) throw new Error(`${POLYMORPH_LIST_PATH}: names must be an array of strings`);
	const seen = new Set<string>();
	for (const name of names as string[]) {
		if (seen.has(name)) throw new Error(`${POLYMORPH_LIST_PATH}: ${JSON.stringify(name)} is listed twice`);
		seen.add(name);
	}
	return [...seen];
}

const KEYWORDS = [
	"await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export",
	"extends", "false", "finally", "for", "function", "if", "implements", "import", "in", "instanceof", "interface", "let", "new", "null",
	"package", "private", "protected", "public", "return", "static", "super", "switch", "this", "throw", "true", "try", "typeof", "var",
	"void", "while", "with", "yield",
];

// Contextual keywords, with the TypeScript and Flow words sucrase's tokenizer
// knows: it gives some of them their own token types in some positions, and a
// name must be renamed wherever it appears or nowhere.
const CONTEXTUAL_KEYWORDS = [
	"abstract", "accessor", "as", "assert", "asserts", "async", "checks", "constructor", "declare", "exports", "from", "get", "global",
	"infer", "is", "keyof", "mixins", "module", "namespace", "of", "opaque", "out", "override", "proto", "readonly", "require",
	"satisfies", "set", "symbol", "type", "unique", "using",
];

const SPECIAL_NAMES = ["constructor", "prototype", "__proto__", "arguments", "eval", "undefined", "NaN", "Infinity"];

/** Names the language and the module system call by name on any object. */
const PROTOCOL_NAMES = ["then", "catch", "finally", "next", "done", "value", "return", "throw", "toJSON", "default", "__esModule"];

/** Names the platform's generated entry module reads from the fork, or passes in. */
const RUNTIME_CONTRACT_NAMES = ["ask", "env", "fluidToml", "forkCommit", "data", "llm", "newId", "LLM"];

/** Properties the built-ins put on instances rather than prototypes (errors, regex matches, template objects, property descriptors). */
const INSTANCE_PROPERTY_NAMES = [
	"length", "name", "message", "stack", "cause", "errors", "lastIndex", "index", "input", "groups", "indices", "raw",
	"writable", "enumerable", "configurable", "get", "set",
];

// Globals that exist in workerd but not in Node, so tests in Node and
// production in a Worker agree on what is reserved.
const WORKER_GLOBALS = ["self", "caches", "scheduler", "navigator", "HTMLRewriter", "WebSocketPair", "addEventListener", "removeEventListener", "dispatchEvent"];

const BUILT_INS = [
	"Object", "Function", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Math", "JSON", "Reflect", "Proxy", "Atomics",
	"Promise", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry", "RegExp", "Date", "Error", "AggregateError",
	"EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "ArrayBuffer", "SharedArrayBuffer", "DataView",
	"Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float16Array",
	"Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "Intl", "Iterator",
];

/** Own property names of the standard built-ins and their prototypes, including the shared typed array base and Intl's constructors. */
function builtInPropertyNames(): string[] {
	const global = globalThis as unknown as Record<string, unknown>;
	const objects = BUILT_INS.map((name) => global[name]).filter(isObject);
	objects.push(Object.getPrototypeOf(Int8Array));
	const intl = global.Intl;
	if (isObject(intl)) objects.push(...Object.getOwnPropertyNames(intl).map((key) => (intl as Record<string, unknown>)[key]).filter(isObject));
	return objects.flatMap((value) => {
		const prototype = (value as { prototype?: unknown }).prototype;
		return [...Object.getOwnPropertyNames(value), ...(isObject(prototype) ? Object.getOwnPropertyNames(prototype) : [])];
	});
}

function isObject(value: unknown): value is object {
	return (typeof value === "object" || typeof value === "function") && value !== null;
}

/** Names a list may never rename: renaming them would break the language, a built-in, or the runtime contract. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
	...KEYWORDS,
	...CONTEXTUAL_KEYWORDS,
	...SPECIAL_NAMES,
	...PROTOCOL_NAMES,
	...RUNTIME_CONTRACT_NAMES,
	...INSTANCE_PROPERTY_NAMES,
	...WORKER_GLOBALS,
	...Object.getOwnPropertyNames(globalThis),
	...builtInPropertyNames(),
]);

// Plain ASCII identifiers only: "$" separates a listed name from its per-copy
// suffix, so a tripwire can tell a renamed name from anything else.
const LISTABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Why renaming these names in this module map would not be safe, one plain
 * message per problem. A name that no module uses is fine (forks differ); it
 * is simply not renamed. The generated entry module is never renamed, so it
 * is not checked.
 */
export function listProblems(names: readonly string[], map: ModuleMap): string[] {
	const problems: string[] = [];
	const renamed: string[] = [];
	for (const name of names) {
		if (typeof name !== "string" || !LISTABLE.test(name)) {
			problems.push(`${JSON.stringify(name)} is not a valid identifier (letters, digits, and underscores, not starting with a digit; "$" marks renamed names)`);
		} else if (RESERVED_NAMES.has(name)) {
			problems.push(`${JSON.stringify(name)} is reserved (a keyword, a global, a property of a built-in, or a name of the runtime contract)`);
		} else {
			renamed.push(name);
		}
	}
	if (renamed.length === 0) return problems;
	for (const [path, module] of Object.entries(map.modules)) {
		if (path === ENTRY_MODULE) continue;
		if ("js" in module) {
			const words = wordsOf(moduleStrings(path, module.js));
			for (const name of renamed) if (words.has(name)) problems.push(`${JSON.stringify(name)} appears in a string or template text in ${path}`);
		} else {
			const { keys, strings } = jsonText(module.json);
			const keyWords = wordsOf(keys);
			const valueWords = wordsOf(strings);
			for (const name of renamed) {
				if (keyWords.has(name)) problems.push(`${JSON.stringify(name)} appears in a key in ${path}`);
				if (valueWords.has(name)) problems.push(`${JSON.stringify(name)} appears in a string value in ${path}`);
			}
		}
	}
	return problems;
}

/** String literal and template text values of a JS module. Code that does not parse is the fork's to fix. */
function moduleStrings(path: string, js: string): string[] {
	try {
		return scanTokens(js).strings;
	} catch (error) {
		if (error instanceof SyntaxError) throw new ForkCodeError(`${path}: ${error.message}`);
		throw error;
	}
}

/** Identifier-like words of the texts: the pieces a property name could be read back from at run time. */
function wordsOf(texts: readonly string[]): Set<string> {
	const words = new Set<string>();
	for (const text of texts) for (const word of text.match(/[A-Za-z0-9_$]+/g) ?? []) words.add(word);
	return words;
}

/** Every key and string value of a JSON value. Iterative, so deeply nested data cannot overflow the stack. */
function jsonText(value: unknown): { keys: string[]; strings: string[] } {
	const keys: string[] = [];
	const strings: string[] = [];
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const item = pending.pop();
		if (typeof item === "string") {
			strings.push(item);
		} else if (Array.isArray(item)) {
			for (const inner of item) pending.push(inner);
		} else if (item !== null && typeof item === "object") {
			for (const [key, inner] of Object.entries(item)) {
				keys.push(key);
				pending.push(inner);
			}
		}
	}
	return { keys, strings };
}

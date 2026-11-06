// Upstream's list of internal names that a polymorphic copy renames, and the
// checks that make renaming them safe for a given module map. Renaming
// touches identifier tokens only. So the list may never hold a name the
// language or the runtime contract reads (that is upstream's mistake, and
// fatal), and a copy skips, per name, what its runtime builds in and what
// reaches the fork's code as text: a string, template text, regular
// expression, or JSON key or value can be read back as a property name at run
// time, and that use would not be renamed.
import type { ModuleMap } from "../runtime/modules.ts";
import { PolymorphUnavailableError, SCAN_LIMITS, scanModuleMap, walkJson, type SourceTokens } from "./tokens.ts";

/** Where stock publishes the list. */
export const POLYMORPH_LIST_PATH = "polymorph.json";

/**
 * Parses polymorph.json: { version: 1, description?, names: string[] }, where
 * every name is listed once, is a plain identifier, and is not reserved. These
 * are upstream's mistakes, whatever a fork's code says, so any of them is
 * fatal, and all of them are reported at once.
 */
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
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const name of names as string[]) {
		const problem = seen.has(name) ? `${JSON.stringify(name)} is listed twice` : nameProblem(name);
		if (problem !== null) problems.push(problem);
		seen.add(name);
	}
	if (problems.length > 0) throw new Error(`${POLYMORPH_LIST_PATH}: ${problems.join("; ")}`);
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

/** Meta-properties: renaming the name after import. or new. would not even parse. */
const META_PROPERTY_NAMES = ["meta", "target"];

/** Names the language and the module system call by name on any object. */
const PROTOCOL_NAMES = ["then", "catch", "finally", "next", "done", "value", "return", "throw", "toJSON", "default", "__esModule"];

/** Names the platform's generated entry module reads from the fork, or passes in. */
const RUNTIME_CONTRACT_NAMES = ["ask", "env", "fluidToml", "forkCommit", "data", "llm", "newId", "LLM"];

/** Properties the language puts on instances rather than prototypes (errors, regex matches, template objects, property descriptors). */
const INSTANCE_PROPERTY_NAMES = [
	"length", "name", "message", "stack", "cause", "errors", "lastIndex", "index", "input", "groups", "indices", "raw",
	"writable", "enumerable", "configurable", "get", "set",
];

/**
 * Names a list may never hold, the same in every runtime: renaming them would
 * break the language or the runtime contract. Written out rather than read
 * from the running runtime, so a list passes or fails the same in tests and in
 * production; what a runtime adds is skipped per name (runtimeBuiltInNames).
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
	...KEYWORDS,
	...CONTEXTUAL_KEYWORDS,
	...SPECIAL_NAMES,
	...META_PROPERTY_NAMES,
	...PROTOCOL_NAMES,
	...RUNTIME_CONTRACT_NAMES,
	...INSTANCE_PROPERTY_NAMES,
]);

let builtInNames: ReadonlySet<string> | null = null;

/**
 * Every name the running runtime gives a meaning: the globals along the
 * global object's prototype chain (where workerd keeps fetch, URL, and the
 * other Web APIs), the properties of each global value and of its prototype,
 * along both prototype chains, and the prototypes of constructors that
 * namespaces such as Intl hold. Runtimes differ (workerd's V8 adds names
 * Node lacks), so these names are skipped where they exist rather than
 * refused everywhere. Worked out once per isolate.
 */
export function runtimeBuiltInNames(): ReadonlySet<string> {
	builtInNames ??= collectBuiltInNames();
	return builtInNames;
}

function collectBuiltInNames(): Set<string> {
	const names = new Set<string>();
	const visited = new WeakSet<object>();
	const addChain = (start: unknown): void => {
		for (let object = start; isObject(object) && !visited.has(object); object = prototypeOf(object)) {
			visited.add(object);
			for (const name of ownNames(object)) names.add(name);
		}
	};
	const addValue = (value: unknown): void => {
		addChain(value);
		addChain(dataProperty(value, "prototype"));
	};
	for (let scope: unknown = globalThis; isObject(scope) && scope !== Object.prototype; scope = prototypeOf(scope)) {
		for (const name of ownNames(scope)) {
			names.add(name);
			const value = readGlobal(name);
			addValue(value);
			// Namespaces such as Intl or WebAssembly hold constructors whose prototypes carry the methods.
			for (const member of isObject(value) ? ownNames(value) : []) {
				const inner = dataProperty(value, member);
				if (typeof inner === "function") addValue(inner);
			}
		}
	}
	return names;
}

function isObject(value: unknown): value is object {
	return (typeof value === "object" || typeof value === "function") && value !== null;
}

// Host objects may refuse to be read (a getter that checks its receiver, a
// proxy). The walk only collects names, so a value it cannot read simply
// adds nothing further.
function readGlobal(name: string): unknown {
	try {
		return (globalThis as Record<string, unknown>)[name];
	} catch {
		return undefined;
	}
}

/** A data property's value; accessors are never invoked, so reading a namespace runs none of its getters. */
function dataProperty(object: unknown, key: string): unknown {
	if (!isObject(object)) return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(object, key);
		return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function ownNames(object: object): string[] {
	try {
		return Object.getOwnPropertyNames(object);
	} catch {
		return [];
	}
}

function prototypeOf(object: object): unknown {
	try {
		return Object.getPrototypeOf(object);
	} catch {
		return null;
	}
}

// Plain ASCII identifiers only: "$" separates a listed name from its per-copy
// suffix, so a tripwire can tell a renamed name from anything else.
const LISTABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Why each of these names could never be listed (not a plain identifier, or reserved), one message per such name. */
export function nameProblems(names: Iterable<string>): string[] {
	return [...names].map(nameProblem).filter((problem): problem is string => problem !== null);
}

/** Why a name can never be renamed, whatever the module map, or null when it can be. */
function nameProblem(name: unknown): string | null {
	if (typeof name !== "string" || !LISTABLE.test(name)) {
		return `${JSON.stringify(name)} is not a valid identifier (letters, digits, and underscores, not starting with a digit; "$" marks renamed names)`;
	}
	if (RESERVED_NAMES.has(name)) return `${JSON.stringify(name)} is reserved (a keyword, or a name the language or the runtime contract reads)`;
	return null;
}

/**
 * Member names the runtime reads by name from objects the fork creates and
 * hands to it: stream sources, sinks, and transformers, event listener objects
 * and listener options, and WebCrypto algorithm parameters. No built-in
 * carries most of them, so the runtime walk cannot find them, yet renaming one
 * breaks the call that reads it. They get their own reason, whether or not a
 * runtime also builds them in, so the reason is the same in every runtime.
 */
const HOST_READ_NAMES: ReadonlySet<string> = new Set([
	"pull", "start", "cancel", "flush", "transform", "write", "close", "abort", "handleEvent", "passive", "once", "capture", "signal",
	"iv", "salt", "iterations", "namedCurve", "hash", "length", "name", "counter", "additionalData", "tagLength", "info",
]);

const BUILT_IN_REASON = "a built-in name in this runtime";
const HOST_READ_REASON = "a name the runtime reads from objects the fork creates";

export interface SkippedName {
	name: string;
	/** Every place the fork's text uses the name, for example "appears in a string or template text in app/x.js". */
	reason: string;
}

/**
 * The fork's own contract as text, by repo path: its tier 3 tests
 * (tests/user/manifest.json), its end-to-end scenarios (tests/user/e2e.json),
 * and fluid.toml. Requests and config bring these words to the fork's code as
 * data, which a renamed property would no longer find, so a copy skips them
 * like the text of its modules.
 */
export type ContractTexts = Readonly<Record<string, string>>;

/**
 * Splits one copy's names into those this module map can have renamed and
 * those it skips: names this runtime builds in, and names the fork's own text
 * uses (a string, template text, regular expression, or a JSON key or value,
 * and the words of its contract), where renaming the identifiers would leave
 * the text pointing at the old name. A skipped name is neither renamed nor
 * treated as a tripwire, so it costs the copy only that name. Whether a name
 * may be listed at all is for parsePolymorphList (and morphFork) to judge.
 * Pass the tokens scanModuleMap read when you have them, so each module is
 * read once.
 */
export function usableNames(
	names: ReadonlyMap<string, string>,
	map: ModuleMap,
	scanned: ReadonlyMap<string, SourceTokens> = scanModuleMap(map),
	contract: ContractTexts = {},
): { usable: Map<string, string>; skipped: SkippedName[] } {
	const reasons = new Map<string, string[]>();
	for (const name of names.keys()) {
		if (HOST_READ_NAMES.has(name)) reasons.set(name, [HOST_READ_REASON]);
		else if (runtimeBuiltInNames().has(name)) reasons.set(name, [BUILT_IN_REASON]);
	}
	for (const { name, reason } of textUses([...names.keys()], map, scanned, contract)) {
		const found = reasons.get(name) ?? [];
		found.push(reason);
		reasons.set(name, found);
	}
	const usable = new Map<string, string>();
	const skipped: SkippedName[] = [];
	for (const [name, variant] of names) {
		const found = reasons.get(name);
		if (found === undefined) usable.set(name, variant);
		else skipped.push({ name, reason: found.join("; ") });
	}
	return { usable, skipped };
}

/**
 * Every place one of the names reaches this module map or the fork's contract
 * as text, in module order and then contract order: as a whole word of a
 * string, template text, or regular expression, of a JSON key or string value,
 * or of a contract file that is not JSON. JS modules are read from their
 * scanned tokens, so the generated entry module, which is never renamed, is
 * not read.
 */
function textUses(names: readonly string[], map: ModuleMap, scanned: ReadonlyMap<string, SourceTokens>, contract: ContractTexts): SkippedName[] {
	const uses: SkippedName[] = [];
	if (names.length === 0) return uses;
	const listed = new Set(names);
	// The kinds of text in one module or file, each with the listed names found in it and the reason each gives.
	const record = (path: string, found: [Set<string>, string][]): void => {
		for (const name of names) for (const [inText, reason] of found) if (inText.has(name)) uses.push({ name, reason: `${reason} ${path}` });
	};
	for (const [path, module] of Object.entries(map.modules)) {
		if ("js" in module) {
			const tokens = scanned.get(path);
			if (tokens === undefined) continue;
			const inStrings = new Set<string>();
			const inRegexes = new Set<string>();
			for (const text of tokens.strings) addListedWords(text, listed, inStrings);
			for (const text of tokens.regexes) addListedWords(text, listed, inRegexes);
			record(path, [[inStrings, "appears in a string or template text in"], [inRegexes, "appears in a regular expression in"]]);
		} else {
			record(path, jsonUses(module.json, listed));
		}
	}
	for (const [path, text] of Object.entries(contract)) {
		if (text.length > SCAN_LIMITS.moduleChars) throw new PolymorphUnavailableError(`${path}: polymorph: the file has ${text.length} characters, more than the ${SCAN_LIMITS.moduleChars} characters the renamer reads in one file`);
		const json = path.endsWith(".json") ? parseJson(text) : null;
		if (json !== null) {
			record(path, jsonUses(json.value, listed));
			continue;
		}
		const inText = new Set<string>();
		addListedWords(text, listed, inText);
		record(path, [[inText, "appears in"]]);
	}
	return uses;
}

/** The listed names among the keys and among the string values of a JSON value. */
function jsonUses(value: unknown, listed: ReadonlySet<string>): [Set<string>, string][] {
	const inKeys = new Set<string>();
	const inValues = new Set<string>();
	walkJson(value, (kind, text) => {
		if (kind !== "other") addListedWords(text, listed, kind === "key" ? inKeys : inValues);
		return true;
	});
	return [[inKeys, "appears in a key in"], [inValues, "appears in a string value in"]];
}

/** A contract file's JSON, or null when it does not parse: then its words are read as plain text, which skips at least as much. */
function parseJson(text: string): { value: unknown } | null {
	try {
		return { value: JSON.parse(text) };
	} catch {
		return null;
	}
}

/** Identifier-like words: the pieces of a text a property name could be read back from at run time. */
const WORD = /[A-Za-z0-9_$]+/g;

/** Adds to found each listed name that is a whole word of text. One check per word, keeping no other word, so a large text costs no memory. */
function addListedWords(text: string, listed: ReadonlySet<string>, found: Set<string>): void {
	for (const [word] of text.matchAll(WORD)) if (listed.has(word)) found.add(word);
}

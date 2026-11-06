// Renames listed identifiers in a fork's module map to make one polymorphic
// copy. Only identifier tokens change; strings, comments, and layout stay as
// they are, so the copy behaves exactly like the plain fork (the gate checks
// that it does) while code written against the public names cannot find them.
import { ENTRY_MODULE, type LoaderModule, type ModuleMap } from "../runtime/modules.ts";
import { nameProblems, usableNames, type SkippedName } from "./list.ts";
import { VARIANT_PATTERN } from "./names.ts";
import { PolymorphUnavailableError, scanModuleMap, scanTokens, type IdentifierToken } from "./tokens.ts";

export { PolymorphUnavailableError } from "./tokens.ts";

export interface MorphedFork {
	/** The renamed module map. */
	map: ModuleMap;
	/** The names this copy renamed, and to what: the only names its tripwire may know. */
	usable: Map<string, string>;
	/** The names this copy left as they are, and why. */
	skipped: SkippedName[];
}

/**
 * One polymorphic copy of a fork: the loader's entry point. Reads each JS
 * module once, skips the names this runtime builds in and the names the fork's
 * own text uses, and renames the rest in every JS module except the generated
 * entry, which must be the map's main module and calls the fork only through
 * its default export and ask. JSON modules and mainModule stay as they are,
 * and the input map is not modified. Scan requests for tripwires with the
 * returned usable names only.
 *
 * Throws PolymorphUnavailableError when this fork cannot be renamed safely
 * (callers run the plain fork and log the reason), and a plain Error for a
 * module map or names that no fork or list could produce.
 */
export function morphFork(map: ModuleMap, variants: ReadonlyMap<string, string>): MorphedFork {
	if (map.mainModule !== ENTRY_MODULE) throw new Error(`morphFork: a fork module map's main module is ${ENTRY_MODULE}, got ${JSON.stringify(map.mainModule)}`);
	const problems = nameProblems(variants.keys());
	if (problems.length > 0) throw new Error(`morphFork: no list can hold these names: ${problems.join("; ")}`);
	checkTargets(variants);
	const scanned = scanModuleMap(map);
	const { usable, skipped } = usableNames(variants, map, scanned);
	const modules: Record<string, LoaderModule> = {};
	for (const [path, module] of Object.entries(map.modules)) {
		const tokens = scanned.get(path);
		modules[path] = tokens === undefined || !("js" in module) ? module : { js: renameModule(path, module.js, tokens.identifiers, usable) };
	}
	return { map: { mainModule: map.mainModule, modules }, usable, skipped };
}

/** morphFork for callers that need every name renamed: refuses, with each reason, when any name would be skipped. */
export function morphModuleMap(map: ModuleMap, names: ReadonlyMap<string, string>): ModuleMap {
	const { map: morphed, skipped } = morphFork(map, names);
	if (skipped.length > 0) {
		const reasons = skipped.map(({ name, reason }) => `${JSON.stringify(name)}: ${reason}`);
		throw new Error(`polymorph: cannot rename these names in this fork's modules (morphFork skips them instead):\n- ${reasons.join("\n- ")}`);
	}
	return morphed;
}

/**
 * Replaces every identifier token of one source whose name is a key of names
 * with its value: bindings, references, member names after "." and "?.",
 * object keys and shorthand, destructuring, class members, import and export
 * names, and identifiers inside template substitutions. It does not check what
 * the source's text says about those names; morphFork does.
 */
export function morphSource(js: string, names: ReadonlyMap<string, string>): string {
	checkTargets(names);
	return renameTokens(js, scanTokens(js).identifiers, names);
}

/**
 * A target must be its own name plus a per-copy suffix, as variantNames makes
 * them, so no keyword or other name can become a target and no two names can
 * share one. The message names only the listed name, never the target, which
 * may be a secret.
 */
function checkTargets(names: ReadonlyMap<string, string>): void {
	for (const [name, target] of names) {
		if (typeof target !== "string" || VARIANT_PATTERN.exec(target)?.[1] !== name) {
			throw new Error(`morphSource: ${JSON.stringify(name)} must map to ${JSON.stringify(name)} followed by "$" and eight base36 characters`);
		}
	}
}

/** Renames the identifier tokens of one source; when the source already uses a renamed name, this copy cannot be made. */
function renameTokens(js: string, identifiers: readonly IdentifierToken[], names: ReadonlyMap<string, string>): string {
	const targets = new Set(names.values());
	const taken = identifiers.find((token) => targets.has(token.text));
	if (taken) {
		// The renamed name is this copy's secret; the listed name it belongs to is public.
		const listed = VARIANT_PATTERN.exec(taken.text)![1];
		throw new PolymorphUnavailableError(`polymorph: the source already uses this copy's renamed name for ${JSON.stringify(listed)}; renaming into it would merge two names`);
	}
	let out = "";
	let copied = 0;
	for (const token of identifiers) {
		const renamed = names.get(token.text);
		if (renamed === undefined) continue;
		out += js.slice(copied, token.start) + renamed;
		copied = token.end;
	}
	return out + js.slice(copied);
}

function renameModule(path: string, js: string, identifiers: readonly IdentifierToken[], names: ReadonlyMap<string, string>): string {
	try {
		return renameTokens(js, identifiers, names);
	} catch (error) {
		if (error instanceof PolymorphUnavailableError) throw new PolymorphUnavailableError(`${path}: ${error.message}`, { cause: error });
		throw error;
	}
}

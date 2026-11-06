// Renames listed identifiers in a fork's module map to make one polymorphic
// copy. Only identifier tokens change; strings, comments, and layout stay as
// they are, so the copy behaves exactly like the plain fork (the gate checks
// that it does) while code written against the public names cannot find them.
import { ENTRY_MODULE, type LoaderModule, type ModuleMap } from "../runtime/modules.ts";
import { listProblems } from "./list.ts";
import { VARIANT_PATTERN } from "./names.ts";
import { PolymorphUnavailableError, scanTokens } from "./tokens.ts";

/**
 * Replaces every identifier token whose name is a key of names with its
 * value: bindings, references, member names after "." and "?.", object keys
 * and shorthand, destructuring, class members, import and export names, and
 * identifiers inside template substitutions. Each value must be its key, "$",
 * and eight base36 characters (as variantNames makes them). When the source
 * already uses one of those names, renaming into it would merge two names, so
 * this copy cannot be made.
 */
export function morphSource(js: string, names: ReadonlyMap<string, string>): string {
	checkTargets(names);
	const { identifiers } = scanTokens(js);
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

/**
 * A target must be its own name plus a per-copy suffix, so no keyword or other
 * name can become a target and no two names can share one. The message names
 * only the listed name, never the target, which may be a secret.
 */
function checkTargets(names: ReadonlyMap<string, string>): void {
	for (const [name, target] of names) {
		if (typeof target !== "string" || VARIANT_PATTERN.exec(target)?.[1] !== name) {
			throw new Error(`morphSource: ${JSON.stringify(name)} must map to ${JSON.stringify(name)} followed by "$" and eight base36 characters`);
		}
	}
}

/**
 * A renamed copy of a module map. Callers pass the usable names from
 * usableNames; as a last line of defense, any name that is still unsafe to
 * rename here is refused with every problem listProblems finds. Renames every
 * JS module except the generated entry (which calls the fork only through its
 * default export and ask) and keeps JSON modules and the main module as they
 * are. The input map is not modified.
 */
export function morphModuleMap(map: ModuleMap, names: ReadonlyMap<string, string>): ModuleMap {
	const problems = listProblems([...names.keys()], map);
	if (problems.length > 0) throw new Error(`polymorph: cannot rename this fork's modules safely (pass the usable names from usableNames):\n- ${problems.join("\n- ")}`);
	const modules: Record<string, LoaderModule> = {};
	for (const [path, module] of Object.entries(map.modules)) {
		modules[path] = path === ENTRY_MODULE || !("js" in module) ? module : { js: morphModule(path, module.js, names) };
	}
	return { mainModule: map.mainModule, modules };
}

function morphModule(path: string, js: string, names: ReadonlyMap<string, string>): string {
	try {
		return morphSource(js, names);
	} catch (error) {
		// Either way the error keeps its kind and its cause, and gains the module path.
		const message = `${path}: ${error instanceof Error ? error.message : String(error)}`;
		if (error instanceof PolymorphUnavailableError) throw new PolymorphUnavailableError(message, { cause: error });
		throw new Error(message, { cause: error });
	}
}

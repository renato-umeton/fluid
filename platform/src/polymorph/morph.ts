// Renames listed identifiers in a fork's module map to make one polymorphic
// copy. Only identifier tokens change; strings, comments, and layout stay as
// they are, so the copy behaves exactly like the plain fork (the gate checks
// that it does) while code written against the public names cannot find them.
import { ENTRY_MODULE, type LoaderModule, type ModuleMap } from "../runtime/modules.ts";
import { listProblems } from "./list.ts";
import { PolymorphUnavailableError, scanTokens } from "./tokens.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Replaces every identifier token whose name is a key of names with its
 * value: bindings, references, member names after "." and "?.", object keys
 * and shorthand, destructuring, class members, import and export names, and
 * identifiers inside template substitutions. Throws when a new name already
 * occurs in the source, since renaming into it would merge two names.
 */
export function morphSource(js: string, names: ReadonlyMap<string, string>): string {
	checkTargets(names);
	const { identifiers } = scanTokens(js);
	const targets = new Set(names.values());
	const taken = identifiers.find((token) => targets.has(token.text));
	if (taken) throw new Error(`morphSource: the source already uses ${JSON.stringify(taken.text)}, a renamed name; renaming into it would merge two names`);
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

function checkTargets(names: ReadonlyMap<string, string>): void {
	const owners = new Map<string, string>();
	for (const [name, target] of names) {
		if (typeof target !== "string" || !IDENTIFIER.test(target) || target === name) {
			throw new Error(`morphSource: ${JSON.stringify(name)} must map to a different valid identifier, got ${JSON.stringify(target)}`);
		}
		const owner = owners.get(target);
		if (owner !== undefined) throw new Error(`morphSource: ${JSON.stringify(owner)} and ${JSON.stringify(name)} both map to ${JSON.stringify(target)}`);
		owners.set(target, name);
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

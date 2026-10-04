// Static import check for model-written changes. Before a candidate change
// is loaded into an isolate, every import in the changed files must resolve
// to a module that will exist in the isolate: a file in the fork's tree or in
// the change itself, under the name the module map registers (foo.ts is
// loaded as foo.js, JSON files keep their name). A fork isolate has no
// packages, so bare specifiers are rejected too. The errors are written for
// the model to read and fix, so they name the file, the specifier, and what
// it resolved to.
import { isRuntimePath, moduleName, transformTs } from "../runtime/modules.ts";

const STATIC_IMPORT = /\b(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?["']([^"'\n]+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g;

/** Import specifiers in a module, in source order. TypeScript sources are type-stripped first, so type-only imports drop out. */
export function importSpecifiers(source: string, path?: string): string[] {
	const code = path?.endsWith(".ts") ? transformTs(source, path) : source;
	const found: { at: number; spec: string }[] = [];
	for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
		for (const match of code.matchAll(pattern)) found.push({ at: match.index ?? 0, spec: match[1]! });
	}
	return found.sort((a, b) => a.at - b.at).map((f) => f.spec);
}

/** Repository path a relative specifier points at from `fromPath`, or null when it leaves the repository. */
export function resolveSpecifier(fromPath: string, specifier: string): string | null {
	const parts = fromPath.split("/").slice(0, -1);
	for (const segment of specifier.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (parts.length === 0) return null;
			parts.pop();
		} else {
			parts.push(segment);
		}
	}
	return parts.join("/");
}

/**
 * Checks the imports of every changed runtime file against the modules the
 * isolate will have (tree plus change). Returns one readable error per
 * problem; an empty list means every import resolves.
 */
export function checkImports(changed: Record<string, string>, tree: Record<string, string>): string[] {
	const merged = { ...tree, ...changed };
	const modules = new Set(Object.keys(merged).filter(isRuntimePath).map(moduleName));
	const errors: string[] = [];
	for (const [path, source] of Object.entries(changed)) {
		if (!isRuntimePath(path) || path.endsWith(".json")) continue;
		let specifiers: string[];
		try {
			specifiers = importSpecifiers(source, path);
		} catch (error) {
			errors.push(`${path} does not parse: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		for (const spec of new Set(specifiers)) {
			const problem = importProblem(path, spec, modules);
			if (problem) errors.push(problem);
		}
	}
	return errors;
}

function importProblem(path: string, spec: string, modules: Set<string>): string | null {
	if (!spec.startsWith("./") && !spec.startsWith("../")) {
		return `${path} imports "${spec}", which is not a relative path; a fork isolate has no packages, so import only files of this fork with "./" or "../" and a ".js" extension`;
	}
	const target = resolveSpecifier(path, spec);
	if (target === null) return `${path} imports "${spec}", which points outside the repository`;
	if (modules.has(target)) return null;
	if (target.endsWith(".ts") && modules.has(moduleName(target))) {
		return `${path} imports "${spec}"; modules are loaded under their .js names, so write "${spec.slice(0, -3)}.js"`;
	}
	const dir = target.split("/").slice(0, -1).join("/");
	const nearby = [...modules].filter((m) => m.startsWith(`${dir}/`) && !m.slice(dir.length + 1).includes("/")).sort().slice(0, 12);
	return `${path} imports "${spec}", which resolves to ${target}; no such file is in the fork or in this change. Write that file in the same change (as ${target.replace(/\.js$/, ".ts")}) or import an existing module${nearby.length ? ` (in ${dir}/: ${nearby.map((m) => m.slice(dir.length + 1)).join(", ")})` : ""}`;
}

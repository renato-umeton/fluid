// Writes a Worker Loader module map to disk so Node can import the same
// transformed modules an isolate would run.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModuleMap } from "../../src/runtime/modules.ts";

export async function materialize<T>(map: ModuleMap, outDir: string, entry: string, skip: string[] = []): Promise<T> {
	rmSync(outDir, { recursive: true, force: true });
	for (const [name, module] of Object.entries(map.modules)) {
		if (skip.includes(name)) continue;
		const target = join(outDir, name);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, "js" in module ? module.js : JSON.stringify(module.json));
	}
	return (await import(/* @vite-ignore */ join(outDir, entry))) as T;
}

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { STOCK_ROOT } from "../helpers/synthetic.js";

const RUNTIME_DIRS = ["app", "intent", "policies", "connectors"];
const runtimeFiles = RUNTIME_DIRS.flatMap((dir) =>
  readdirSync(join(STOCK_ROOT, dir)).filter((f) => f.endsWith(".ts")).map((f) => `${dir}/${f}`),
);
const importsOf = (source: string) => [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);

describe("runtime modules load in a Workers isolate", () => {
  it.each(runtimeFiles)("%s uses only relative .js or .json imports and no Node APIs", (file) => {
    const source = readFileSync(join(STOCK_ROOT, file), "utf8");
    for (const specifier of importsOf(source)) expect(specifier).toMatch(/^\.\.?\/.+\.(js|json)$/);
    expect(source).not.toMatch(/\b(require\(|process\.|Buffer\.|__dirname)/);
  });

  it("bundles to a single ES module whose default export answers", async () => {
    const result = await build({
      entryPoints: [join(STOCK_ROOT, "app", "index.ts")],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      write: false,
    });
    const code = result.outputFiles[0]!.text;
    expect(code).not.toMatch(/^\s*import\s/m);
    const file = join(mkdtempSync(join(tmpdir(), "fluid-stock-")), "app.js");
    writeFileSync(file, code);
    const mod = await import(pathToFileURL(file).href);
    const card = await mod.default.ask({ question: "Is Morphinex on formulary?", context: { documentType: "budget" } }, {});
    expect(card.mode).toBe("administrative");
  });
});

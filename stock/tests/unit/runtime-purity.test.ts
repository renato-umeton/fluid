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

const NODE_BUILTINS = [
  "assert", "async_hooks", "buffer", "child_process", "cluster", "crypto", "dgram", "dns", "events", "fs", "fs/promises",
  "http", "http2", "https", "module", "net", "os", "path", "perf_hooks", "process", "querystring", "readline", "stream",
  "string_decoder", "timers", "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
];

/** Every module specifier: static imports and re-exports (with or without bindings) and dynamic import(). */
function specifiersOf(source: string): string[] {
  const patterns = [
    /\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((m) => m[1]!));
}

/** Reasons a runtime module would not load, or would not stay pure, in a Workers isolate. */
function purityViolations(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
  const problems: string[] = [];
  for (const specifier of specifiersOf(code)) {
    if (!/^\.\.?\/.+\.(js|json)$/.test(specifier)) problems.push(`non-relative or extensionless import "${specifier}"`);
  }
  if (/\bimport\s*\(/.test(code)) problems.push("dynamic import()");
  if (/\brequire\s*\(|\brequire\b\s*\.|\bmodule\.exports\b/.test(code)) problems.push("require");
  if (/\bprocess\b/.test(code)) problems.push("process");
  if (/\bfetch\s*\(/.test(code)) problems.push("fetch(");
  if (/\b(Buffer|__dirname|__filename|globalThis\.process)\b/.test(code)) problems.push("Node global");
  const quoted = [...code.matchAll(/["'`]([^"'`\n]+)["'`]/g)].map((m) => m[1]!);
  for (const literal of quoted) {
    if (/^node:/.test(literal) || NODE_BUILTINS.includes(literal)) problems.push(`Node module name "${literal}"`);
  }
  return problems;
}

describe("purity checker", () => {
  it.each([
    ['import "node:fs";', "side-effect import"],
    ["import './side-effect';", "extensionless side-effect import"],
    ['import fs from "fs";', "bare Node module"],
    ['export * from "node:path";', "re-export from Node"],
    ['const m = await import("./x.js");', "dynamic import"],
    ["const fs = require('fs');", "require"],
    ["const env = process.env.SECRET;", "process"],
    ['await fetch("https://example.com");', "fetch("],
    ["const b = Buffer.from('x');", "Buffer"],
    ['const name = "child_process";', "Node module name in a string"],
  ])("flags %s (%s)", (source) => {
    expect(purityViolations(source)).not.toEqual([]);
  });

  it("accepts relative .js and .json imports", () => {
    expect(purityViolations('import { a } from "./a.js";\nimport raw from "../p/x.json";\nimport type { T } from "./t.js";')).toEqual([]);
  });

  it("ignores words in comments", () => {
    expect(purityViolations("// the gate may process this later\n/* fetch( */\nconst x = 1;")).toEqual([]);
  });
});

describe("runtime modules load in a Workers isolate", () => {
  it.each(runtimeFiles)("%s uses only relative .js or .json imports and no Node APIs", (file) => {
    expect(purityViolations(readFileSync(join(STOCK_ROOT, file), "utf8"))).toEqual([]);
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

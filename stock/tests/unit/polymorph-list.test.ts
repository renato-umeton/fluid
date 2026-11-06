// Upstream's own check of polymorph.json, the internal names that each running
// copy of a fork renames with a secret suffix. Renaming touches identifiers
// only, so a listed name must reach runtime code only as an identifier: never
// as text (strings, regular expressions, data, the probe suites) and never as
// part of a contract that something outside the fork's code reads by name.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { loadSyntheticData, readStockFile, STOCK_ROOT } from "../helpers/synthetic.js";

const list = JSON.parse(readStockFile("polymorph.json")) as { version: unknown; description: unknown; names: string[] };
const names = list.names;

const RUNTIME_DIRS = ["app", "intent", "policies", "connectors"];
const runtimeFiles = RUNTIME_DIRS.flatMap((dir) =>
  readdirSync(join(STOCK_ROOT, dir), { recursive: true, encoding: "utf8" }).map((file) => `${dir}/${file}`),
);
const sourceFiles = runtimeFiles.filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"));
const jsonFiles = runtimeFiles.filter((file) => file.endsWith(".json"));

const PROBE_FILES = [
  "tests/invariants/manifest.json",
  "tests/functional/manifest.json",
  "tests/e2e/manifest.json",
  "overlays/demo-release/invariants.json",
];

/** Names the platform and the browser bundle import from stock by name. */
const PLATFORM_IMPORTS = [
  "readForkConfig",
  "effectiveTau",
  "scheduleContext",
  "normalizeRequest",
  "MODE_CONTRACTS",
  "SYNTHETIC_NOTICE",
  "STOCK_MIN_TAU",
  "STOCK_TAG",
];

/** True when the TypeScript scanner reads the whole text as one identifier, so it is neither a keyword nor anything else. */
function isPlainIdentifier(text: string): boolean {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  return scanner.scan() === ts.SyntaxKind.Identifier && scanner.scan() === ts.SyntaxKind.EndOfFileToken;
}

/**
 * Identifiers, decoded string contents (string literals, string module names,
 * and template text), and regular expression literals of a TypeScript source,
 * found by walking the TypeScript parser's syntax tree, which tells a regular
 * expression from a division and a template from a block the way the
 * language does.
 */
function readSource(text: string): { identifiers: Set<string>; strings: string[]; regexes: string[] } {
  const identifiers = new Set<string>();
  const strings: string[] = [];
  const regexes: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) strings.push(node.text);
    else if (ts.isRegularExpressionLiteral(node)) regexes.push(regexText(node.text));
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("source.ts", text, ts.ScriptTarget.Latest, true));
  return { identifiers, strings, regexes };
}

/** A regex literal as the platform reads it: character escapes decoded, any other escape (\d, \b, ...) read as a space. */
function regexText(raw: string): string {
  return raw.replace(/\\(?:u\{([0-9A-Fa-f]+)\}|u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2})|[\s\S])/g, (_match, braced?: string, four?: string, two?: string) => {
    const hex = braced ?? four ?? two;
    return hex === undefined ? " " : String.fromCodePoint(parseInt(hex, 16));
  });
}

/** Identifier-like words of a text: the pieces a name could be read back from at run time. */
function wordsIn(text: string): string[] {
  return text.match(/[A-Za-z0-9_$]+/g) ?? [];
}

/** Every key and every string value of a JSON value, at any depth. */
function jsonText(value: unknown, keys: string[] = [], strings: string[] = []): { keys: string[]; strings: string[] } {
  if (typeof value === "string") strings.push(value);
  else if (Array.isArray(value)) value.forEach((item) => jsonText(item, keys, strings));
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.push(key);
      jsonText(item, keys, strings);
    }
  }
  return { keys, strings };
}

/** Where a name shows up as a key or as a word of a string value in JSON data. */
function jsonMentions(where: string, value: unknown): string[] {
  const { keys, strings } = jsonText(value);
  const mentions: string[] = [];
  for (const name of names) {
    if (keys.some((key) => wordsIn(key).includes(name))) mentions.push(`${name}: key in ${where}`);
    const text = strings.find((s) => wordsIn(s).includes(name));
    if (text !== undefined) mentions.push(`${name}: string value in ${where}: ${JSON.stringify(text.slice(0, 80))}`);
  }
  return mentions;
}

/** Property names declared anywhere in a TypeScript source (interface members and type literal members, at any depth). */
function declaredProperties(path: string): Set<string> {
  const source = ts.createSourceFile(path, readStockFile(path), ts.ScriptTarget.Latest, true);
  const properties = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isPropertySignature(node) || ts.isMethodSignature(node)) && ts.isIdentifier(node.name)) properties.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return properties;
}

/** Names a TypeScript module exports, including re-exports and "default". */
function exportedNames(path: string): Set<string> {
  const source = ts.createSourceFile(path, readStockFile(path), ts.ScriptTarget.Latest, true);
  const exported = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) exported.add("default");
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) exported.add(element.name.text);
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) exported.add(declaration.name.text);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      exported.add(statement.name.text);
    }
  }
  return exported;
}

/** Globals and the own properties of the standard built-ins and their prototypes (Math.floor, Array.prototype.map, ...). */
function builtInNames(): Set<string> {
  const builtIns: unknown[] = [
    Object, Function, Array, String, Number, Boolean, Symbol, BigInt, Math, JSON, Reflect, Promise, Map, Set, WeakMap, WeakSet,
    RegExp, Date, Error, ArrayBuffer, DataView, Intl, Object.getPrototypeOf(Uint8Array),
  ];
  const out = new Set(Object.getOwnPropertyNames(globalThis));
  for (const builtIn of builtIns) {
    for (const name of Object.getOwnPropertyNames(builtIn)) out.add(name);
    const prototype = (builtIn as { prototype?: unknown }).prototype;
    if (typeof prototype === "object" && prototype !== null) for (const name of Object.getOwnPropertyNames(prototype)) out.add(name);
  }
  return out;
}

describe("source reader", () => {
  it("reads identifiers, decoded strings, and template text at any nesting", () => {
    const { identifiers, strings } = readSource("const r\\u0061w = { k: 'a\\u0062c' };\nconst t = `x${{ n: `in${raw.k}ner` }.n}y`;");
    expect([...identifiers]).toEqual(["raw", "k", "t", "n"]);
    expect(strings).toEqual(["abc", "x", "in", "ner", "y"]);
  });

  it("tells regular expressions from divisions, including after a non-null assertion", () => {
    const { identifiers, strings, regexes } = readSource("const a = b! / c; const d = e.default / 2; const f = /[\"'`]${}/g.test(\"s\"); const g = !/x/.test(h);");
    expect([...identifiers]).toEqual(["a", "b", "c", "d", "e", "default", "f", "test", "g", "h"]);
    expect(strings).toEqual(["s"]);
    expect(regexes).toEqual(["/[\"'`]${}/g", "/x/"]);
  });

  it("reads a regular expression after a parenthesized condition, quote and all, without losing the string after it", () => {
    expect(readSource("if (a) /'/.test(b); const s = 'evidence';")).toEqual({ identifiers: new Set(["a", "test", "b", "s"]), strings: ["evidence"], regexes: ["/'/"] });
  });

  it("reads a regular expression's escapes as word breaks, so a named group stays a whole word", () => {
    expect(readSource("const m = /(?<weightKg>\\d+) kg/.exec(t);").regexes).toEqual(["/(?<weightKg> +) kg/"]);
  });

  it("reads string module names as strings", () => {
    expect(readSource('const a = 1; export { a as "some name" };').strings).toEqual(["some name"]);
  });

  it("ignores comments", () => {
    expect(readSource("// \"hidden\"\n/* `also` */ const x = 1;")).toEqual({ identifiers: new Set(["x"]), strings: [], regexes: [] });
  });

  it("reads reserved and contextual keywords as keywords, not identifiers", () => {
    expect(["if", "let", "yield", "type", "of", "from", "classify", "clamp01", "a b"].map(isPlainIdentifier)).toEqual([
      false, false, false, false, false, false, true, true, false,
    ]);
  });
});

describe("polymorph.json", () => {
  it("is version 1 with a description and a sorted list without duplicates", () => {
    expect(list.version).toBe(1);
    expect(typeof list.description === "string" && list.description.trim() !== "").toBe(true);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
  });

  it("lists researchNeedsAttestation", () => {
    expect(names).toContain("researchNeedsAttestation");
  });

  it("lists only plain identifiers that are not keywords", () => {
    // "$" separates a name from its per-copy suffix, so no listed name may contain one.
    expect(names.filter((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !isPlainIdentifier(name))).toEqual([]);
  });

  it("lists no global and no property of a standard built-in", () => {
    const builtIns = builtInNames();
    expect(names.filter((name) => builtIns.has(name))).toEqual([]);
  });
});

describe("listed names are internal identifiers of the runtime", () => {
  const scanned = sourceFiles.map((file) => ({ file, ...readSource(readStockFile(file)) }));

  it("finds the runtime sources", () => {
    expect(sourceFiles).toContain("app/index.ts");
    expect(jsonFiles).toContain("policies/registry.json");
  });

  it("uses every listed name as an identifier in runtime code", () => {
    const identifiers = new Set(scanned.flatMap((s) => [...s.identifiers]));
    expect(names.filter((name) => !identifiers.has(name))).toEqual([]);
  });

  it("never has a listed name in a string, template text, or regular expression of runtime code", () => {
    const mentions = scanned.flatMap(({ file, strings, regexes }) =>
      [...strings, ...regexes].flatMap((text) => wordsIn(text).filter((word) => names.includes(word)).map((name) => `${name}: ${file}: ${JSON.stringify(text)}`)),
    );
    expect(mentions).toEqual([]);
  });

  it("never has a listed name as a key or in a string value of runtime JSON", () => {
    expect(jsonFiles.flatMap((file) => jsonMentions(file, JSON.parse(readStockFile(file))))).toEqual([]);
  });

  it("never has a listed name as a key or in a string value of the synthetic data", () => {
    expect(jsonMentions("synthetic data", loadSyntheticData())).toEqual([]);
  });

  it("never has a listed name in the probe suites or the demo overlay", () => {
    expect(PROBE_FILES.flatMap((file) => jsonMentions(file, JSON.parse(readStockFile(file))))).toEqual([]);
  });
});

describe("listed names stay out of every contract read by name", () => {
  it("lists no field of the request, card, ledger, or env shapes", () => {
    const fields = declaredProperties("app/types.ts");
    for (const field of ["question", "chartOpen", "patientId", "label", "role", "answer_id", "computed_dose", "publisher", "fork_commit", "fluidToml", "newId", "ask"]) {
      expect(fields).toContain(field);
    }
    expect(names.filter((name) => fields.has(name))).toEqual([]);
  });

  it("lists nothing app/types.ts or app/toml.ts exports (the gate's runner imports them from upstream)", () => {
    const exported = new Set([...exportedNames("app/types.ts"), ...exportedNames("app/toml.ts")]);
    expect(exported).toContain("parseToml");
    expect(exported).toContain("MODES");
    expect(names.filter((name) => exported.has(name))).toEqual([]);
  });

  it("lists nothing app/index.ts exports or the platform imports by name", () => {
    const exported = new Set([...exportedNames("app/index.ts"), ...PLATFORM_IMPORTS]);
    expect(exported).toContain("ask");
    expect(exported).toContain("default");
    expect(names.filter((name) => exported.has(name))).toEqual([]);
  });
});

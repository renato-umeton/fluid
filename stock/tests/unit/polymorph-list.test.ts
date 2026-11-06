// Upstream's own check of polymorph.json, the internal names that each running
// copy of a fork renames with a secret suffix. Renaming touches identifiers
// only, so a listed name must reach runtime code only as an identifier: never
// as text (strings, data, the probe suites) and never as part of a contract
// that something outside the fork's code reads by name.
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

const STRING_TOKENS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

/** Tokens that can end a value: a "/" after one of them divides instead of starting a regular expression. */
const VALUE_END = new Set([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.PlusPlusToken,
  ts.SyntaxKind.MinusMinusToken,
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.SuperKeyword,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
]);

function isKeyword(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword;
}

/** Keywords that are not reserved words (as, from, of, type, let, static, ...): in code they are usually names. */
function isNameLikeKeyword(kind: ts.SyntaxKind): boolean {
  return kind > ts.SyntaxKind.LastReservedWord && kind <= ts.SyntaxKind.LastKeyword;
}

/** True when the TypeScript scanner reads the whole text as one identifier, so it is neither a keyword nor anything else. */
function isPlainIdentifier(text: string): boolean {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  return scanner.scan() === ts.SyntaxKind.Identifier && scanner.scan() === ts.SyntaxKind.EndOfFileToken;
}

/**
 * Identifiers and decoded string contents (string literals and template text)
 * of a TypeScript source, read with the TypeScript scanner. On its own the
 * scanner cannot tell a regular expression from a division, or a template
 * continuation from a closing brace, so this tracks those two contexts the way
 * the parser would.
 */
function scanSource(text: string): { identifiers: Set<string>; strings: string[] } {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const identifiers = new Set<string>();
  const strings: string[] = [];
  const openBraces: ("block" | "substitution")[] = [];
  let afterValue = false;
  let afterDot = false;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if ((kind === ts.SyntaxKind.SlashToken || kind === ts.SyntaxKind.SlashEqualsToken) && !afterValue) kind = scanner.reScanSlashToken();
    if (kind === ts.SyntaxKind.CloseBraceToken && openBraces.pop() === "substitution") kind = scanner.reScanTemplateToken(false);
    if (kind === ts.SyntaxKind.OpenBraceToken) openBraces.push("block");
    if (kind === ts.SyntaxKind.TemplateHead || kind === ts.SyntaxKind.TemplateMiddle) openBraces.push("substitution");
    if (kind === ts.SyntaxKind.Identifier) identifiers.add(scanner.getTokenValue());
    if (STRING_TOKENS.has(kind)) strings.push(scanner.getTokenValue());
    // A keyword after "." is a property name, a keyword that is not a reserved
    // word is usually a name, and a "!" after a value is a non-null assertion.
    if (kind !== ts.SyntaxKind.ExclamationToken) afterValue = VALUE_END.has(kind) || isNameLikeKeyword(kind) || (afterDot && isKeyword(kind));
    afterDot = kind === ts.SyntaxKind.DotToken || kind === ts.SyntaxKind.QuestionDotToken;
  }
  return { identifiers, strings };
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

describe("source scanner", () => {
  it("reads identifiers, decoded strings, and template text at any nesting", () => {
    const { identifiers, strings } = scanSource("const r\\u0061w = { k: 'a\\u0062c' };\nconst t = `x${{ n: `in${raw.k}ner` }.n}y`;");
    expect([...identifiers]).toEqual(["raw", "k", "t", "n"]);
    expect(strings).toEqual(["abc", "x", "in", "ner", "y"]);
  });

  it("tells regular expressions from divisions, including after a non-null assertion", () => {
    const { identifiers, strings } = scanSource("const a = b! / c; const d = e.default / 2; const f = /[\"'`]${}/g.test(\"s\"); const g = !/x/.test(h);");
    expect([...identifiers]).toEqual(["a", "b", "c", "d", "e", "f", "test", "g", "h"]);
    expect(strings).toEqual(["s"]);
  });

  it("ignores comments", () => {
    expect(scanSource("// \"hidden\"\n/* `also` */ const x = 1;")).toEqual({ identifiers: new Set(["x"]), strings: [] });
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
  const scanned = sourceFiles.map((file) => ({ file, ...scanSource(readStockFile(file)) }));

  it("finds the runtime sources", () => {
    expect(sourceFiles).toContain("app/index.ts");
    expect(jsonFiles).toContain("policies/registry.json");
  });

  it("uses every listed name as an identifier in runtime code", () => {
    const identifiers = new Set(scanned.flatMap((s) => [...s.identifiers]));
    expect(names.filter((name) => !identifiers.has(name))).toEqual([]);
  });

  it("never has a listed name in a string or template text of runtime code", () => {
    const mentions = scanned.flatMap(({ file, strings }) =>
      strings.flatMap((text) => wordsIn(text).filter((word) => names.includes(word)).map((name) => `${name}: ${file}: ${JSON.stringify(text)}`)),
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

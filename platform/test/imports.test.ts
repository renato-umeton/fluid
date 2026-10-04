import { describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import { checkImports, importSpecifiers, resolveSpecifier } from "../src/agents/imports.ts";

const files = stockSource.files as Record<string, string>;

describe("importSpecifiers", () => {
	it("finds static, re-export, side-effect, and literal dynamic imports", () => {
		const code = 'import a from "./a.js";\nimport {\n  b,\n  c\n} from "../b.js";\nimport "./side.js";\nexport * from "./re.js";\nexport { d } from "./d.js";\nconst m = await import("./dyn.js");\n';
		expect(importSpecifiers(code)).toEqual(["./a.js", "../b.js", "./side.js", "./re.js", "./d.js", "./dyn.js"]);
	});

	it("ignores type-only imports once types are stripped", () => {
		expect(importSpecifiers('import type { X } from "./types.js";\nimport { y } from "./y.js";\nexport const z: X = y;', "m.ts")).toEqual(["./y.js"]);
	});
});

describe("resolveSpecifier", () => {
	it.each([
		["app/cards.ts", "./cards.base.js", "app/cards.base.js"],
		["app/cards.ts", "../policies/research.js", "policies/research.js"],
		["connectors/x/y.ts", "../../app/types.js", "app/types.js"],
	])("%s + %s -> %s", (from, spec, expected) => {
		expect(resolveSpecifier(from, spec)).toBe(expected);
	});

	it("returns null for a path above the repository root", () => {
		expect(resolveSpecifier("app/a.ts", "../../x.js")).toBeNull();
	});
});

describe("checkImports", () => {
	it("passes stock as published", () => {
		const runtime = Object.fromEntries(Object.entries(files).filter(([p]) => /^(app|intent|policies|connectors)\//.test(p)));
		expect(checkImports(runtime, runtime)).toEqual([]);
	});

	it("reports the live failure: a wrapper importing a file that does not exist", () => {
		const change = { "app/cards.ts": 'import { buildCard as base } from "./cards.base.js";\nexport async function buildCard(i: unknown) { return base(i); }\n' };
		const errors = checkImports(change, files);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('app/cards.ts imports "./cards.base.js"');
		expect(errors[0]).toContain("app/cards.base.js");
	});

	it("accepts an import of a file written in the same change, mapping .js to .ts", () => {
		const change = {
			"app/cards.ts": 'import { buildCard as base } from "./cards.base.js";\nexport const buildCard = base;\n',
			"app/cards.base.ts": files["app/cards.ts"]!,
		};
		expect(checkImports(change, files)).toEqual([]);
	});

	it("accepts JSON module imports by their own name", () => {
		expect(checkImports({ "policies/extra.ts": 'import data from "./registry.json" with { type: "json" };\nexport default data;\n' }, files)).toEqual([]);
	});

	it("rejects package imports, which a fork isolate cannot load", () => {
		const errors = checkImports({ "app/x.ts": 'import _ from "lodash";\nexport default _;\n' }, files);
		expect(errors[0]).toContain('"lodash"');
	});

	it("rejects a .ts specifier, because modules are registered under .js names", () => {
		const errors = checkImports({ "app/x.ts": 'import { buildCard } from "./cards.ts";\nexport default buildCard;\n' }, files);
		expect(errors[0]).toContain("./cards.js");
	});

	it("only checks the changed files", () => {
		const tree = { ...files, "app/broken.ts": 'import x from "./missing.js";\n' };
		expect(checkImports({ "app/ok.ts": 'import { buildCard } from "./cards.js";\nexport default buildCard;\n' }, tree)).toEqual([]);
	});

	it("reports a file that does not parse instead of throwing", () => {
		const errors = checkImports({ "app/x.ts": "export const = ;" }, files);
		expect(errors[0]).toContain("app/x.ts");
	});
});

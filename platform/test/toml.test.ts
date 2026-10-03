import { describe, expect, it } from "vitest";
import { formatTomlValue, parseToml, setTomlValue } from "../src/lib/toml.ts";
import stockSource from "../src/generated/stock-source.json";

const STOCK_TOML = (stockSource.files as Record<string, string>)["fluid.toml"]!;

describe("parseToml", () => {
	it("reads the stock fluid.toml", () => {
		expect(parseToml(STOCK_TOML)).toMatchObject({ stock_tag: "v1.0.0", thresholds: { tau: 0.85 }, preferences: { auto_upgrade: false } });
	});

	it("keeps # inside strings", () => {
		expect(parseToml('name = "a#b" # comment')).toEqual({ name: "a#b" });
	});

	it("rejects unsupported values", () => {
		expect(() => parseToml("x = [1, 2]")).toThrow(/line 1: unsupported value/);
	});
});

describe("setTomlValue", () => {
	it("changes an existing value and keeps its comment", () => {
		const out = setTomlValue(STOCK_TOML, "thresholds", "tau", 0.9);
		expect(out).toContain("tau = 0.9            # user may raise");
		expect(parseToml(out)).toMatchObject({ thresholds: { tau: 0.9 } });
	});

	it("adds a key to an existing section", () => {
		const out = setTomlValue(STOCK_TOML, "preferences", "persona", "hospitalist-researcher");
		expect(parseToml(out)).toMatchObject({ preferences: { persona: "hospitalist-researcher", harvest_opt_in: false } });
	});

	it("adds a new section at the end", () => {
		const out = setTomlValue(STOCK_TOML, "profile", "display_name", "Dr. Ellery");
		expect(parseToml(out).profile).toEqual({ display_name: "Dr. Ellery" });
	});

	it("sets a top-level key before the first section", () => {
		const out = setTomlValue(STOCK_TOML, null, "stock_tag", "v1.1.0");
		expect(parseToml(out)).toMatchObject({ stock_tag: "v1.1.0", thresholds: { tau: 0.85 } });
	});

	it("adds a new top-level key before the first section", () => {
		const out = setTomlValue("[a]\nx = 1\n", null, "y", 2);
		expect(parseToml(out)).toEqual({ y: 2, a: { x: 1 } });
	});

	it("leaves the rest of the file unchanged", () => {
		const out = setTomlValue(STOCK_TOML, "preferences", "harvest_opt_in", false);
		expect(out.split("\n").filter((l) => !l.includes("harvest_opt_in"))).toEqual(STOCK_TOML.split("\n").filter((l) => !l.includes("harvest_opt_in")));
	});

	it("refuses strings that would break the file", () => {
		expect(() => formatTomlValue('a"b')).toThrow(/quotes/);
	});

	it("refuses invalid keys", () => {
		expect(() => setTomlValue(STOCK_TOML, null, "a b", 1)).toThrow(/invalid key/);
	});
});

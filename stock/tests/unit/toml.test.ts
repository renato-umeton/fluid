import { describe, expect, it } from "vitest";
import { parseToml } from "../../app/toml.js";

describe("parseToml", () => {
  it("parses top-level keys, sections, numbers, booleans and comments", () => {
    const parsed = parseToml(`
stock_tag = "v1.0.0"   # pinned release
[thresholds]
tau = 0.9
[preferences]
auto_upgrade = false
harvest_opt_in = true
`);
    expect(parsed).toEqual({
      stock_tag: "v1.0.0",
      thresholds: { tau: 0.9 },
      preferences: { auto_upgrade: false, harvest_opt_in: true },
    });
  });

  it("keeps a hash inside a quoted string", () => {
    expect(parseToml(`name = "a # b"`)).toEqual({ name: "a # b" });
  });

  it("fails fast with the line number on malformed input", () => {
    expect(() => parseToml("tau 0.85")).toThrow(/line 1/);
  });
});

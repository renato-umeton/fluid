import { describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";

const files = stockSource.files as Record<string, string>;

describe("published stock", () => {
	it("carries upstream's polymorph name list", () => {
		expect(typeof files["polymorph.json"]).toBe("string");
		expect(JSON.parse(files["polymorph.json"]!).names).toContain("researchNeedsAttestation");
	});
});

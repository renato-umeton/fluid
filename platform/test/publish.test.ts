import { describe, expect, it } from "vitest";
import { unrecordedStockTags } from "../src/stock/publish.ts";

describe("unrecordedStockTags", () => {
	it("lists the stock tags the fleet has not recorded, oldest first", () => {
		expect(unrecordedStockTags(["v1.8.0", "v1.2.0", "v1.1.0", "v1.0.0"], ["v1.0.0"])).toEqual(["v1.1.0", "v1.2.0", "v1.8.0"]);
	});

	it("lists every tag when the fleet is new and stock already holds releases", () => {
		expect(unrecordedStockTags(["v1.1.0", "v1.0.0"], [])).toEqual(["v1.0.0", "v1.1.0"]);
	});

	it("lists nothing when the fleet already knows every tag", () => {
		expect(unrecordedStockTags(["v1.1.0", "v1.0.0"], ["v1.0.0", "v1.1.0"])).toEqual([]);
	});
});

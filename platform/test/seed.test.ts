import { describe, expect, it } from "vitest";
import { pickSeedBaseTag } from "../src/workflows/fleet.ts";

describe("pickSeedBaseTag", () => {
	it("pins seeded forks to the newest release whose floor is not tightened yet", () => {
		expect(pickSeedBaseTag([{ tag: "v1.7.0", tightened: true }, { tag: "v1.6.0", tightened: true }, { tag: "v1.5.0", tightened: false }])).toBe("v1.5.0");
	});

	it("uses the latest release on a fresh account", () => {
		expect(pickSeedBaseTag([{ tag: "v1.1.0", tightened: false }, { tag: "v1.0.0", tightened: false }])).toBe("v1.1.0");
	});

	it("falls back to the newest tag when every release is tightened", () => {
		expect(pickSeedBaseTag([{ tag: "v1.3.0", tightened: true }])).toBe("v1.3.0");
		expect(pickSeedBaseTag([])).toBeNull();
	});
});

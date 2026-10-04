import { describe, expect, it } from "vitest";
import { landedEarlier } from "../src/yellow/landing.ts";

const C = "c".repeat(40);
const P = "p".repeat(40);

describe("landedEarlier", () => {
	it("a retried merge step finds main already at the gated commit with no yellow run for it: it landed and still needs its soak", () => {
		expect(landedEarlier({ mainHead: C, commit: C, healthCommit: P })).toBe(true);
		expect(landedEarlier({ mainHead: C, commit: C, healthCommit: null })).toBe(true);
	});

	it("a commit whose yellow run already exists, or that main only contains, did not just land", () => {
		expect(landedEarlier({ mainHead: C, commit: C, healthCommit: C })).toBe(false);
		expect(landedEarlier({ mainHead: P, commit: C, healthCommit: null })).toBe(false);
	});
});

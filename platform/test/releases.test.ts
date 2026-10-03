import { describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import { cleanNotes, demoReleaseFiles, pinnedTagOf, releaseMetadata, releaseMetadataPath, SAFETY_GRACE_DAYS } from "../src/stock/releases.ts";

const files = stockSource.files as Record<string, string>;

describe("releaseMetadata", () => {
	it("gives a safety release a grace period from its date", () => {
		const meta = releaseMetadata({ tag: "v1.1.0", notes: "Tightens the floor", safety: true, date: new Date("2026-10-03T00:00:00Z") });
		expect(meta).toMatchObject({ safety: true, graceDays: SAFETY_GRACE_DAYS, graceUntil: "2026-10-17T00:00:00.000Z" });
	});

	it("gives a feature release no grace period", () => {
		expect(releaseMetadata({ tag: "v1.2.0" })).toMatchObject({ safety: false, graceDays: null, graceUntil: null });
	});

	it("stores metadata under releases/", () => {
		expect(releaseMetadataPath("v1.1.0")).toBe("releases/v1.1.0.json");
	});

	it("strips control characters from notes and bounds them", () => {
		expect(cleanNotes("a\u0000b\u001bc\nd")).toBe("abc\nd");
		expect(cleanNotes("x".repeat(5000))).toHaveLength(2000);
	});
});

describe("demoReleaseFiles", () => {
	it("rewords the multi-intent framing line and nothing else", () => {
		const { files: next, changed } = demoReleaseFiles(files);
		expect(changed).toEqual(["app/cards.ts"]);
		const before = files["app/cards.ts"]!.split("\n");
		const after = next["app/cards.ts"]!.split("\n");
		const diff = before.filter((line, i) => line !== after[i]);
		expect(diff).toHaveLength(1);
		expect(diff[0]).toContain("is below the threshold");
	});

	it("produces a different line again on the next release", () => {
		const once = demoReleaseFiles(files).files;
		const twice = demoReleaseFiles(once).files;
		expect(twice["app/cards.ts"]).not.toBe(once["app/cards.ts"]);
	});
});

describe("pinnedTagOf", () => {
	it("reads stock_tag", () => {
		expect(pinnedTagOf('stock_tag = "v1.1.0"\n')).toBe("v1.1.0");
		expect(pinnedTagOf(null)).toBeNull();
	});
});

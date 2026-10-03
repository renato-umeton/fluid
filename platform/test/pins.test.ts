import { describe, expect, it } from "vitest";
import { checkPin, ForkCodeError, isForkCaused, isReleaseTag, latestSafetyTag, StockTagError } from "../src/gate/pins.ts";
import { RefNotFoundError } from "../src/runtime/refs.ts";

const release = (tag: string, safety: boolean) => ({ tag, safety });

describe("isReleaseTag", () => {
	it.each(["v1.0.0", "v1.10.2", "v12.0.0"])("accepts %s", (tag) => expect(isReleaseTag(tag)).toBe(true));
	it.each(["main", "work/x", "a".repeat(40), "0123456789abcdef0123456789abcdef01234567", "v1.2", "v1.2.0-rc.1", "refs/tags/v1.2.0", " v1.2.0", ""])("rejects %j", (tag) =>
		expect(isReleaseTag(tag)).toBe(false),
	);
	it("rejects non-strings", () => expect(isReleaseTag(1 as unknown as string)).toBe(false));
});

describe("latestSafetyTag", () => {
	it("picks the newest safety release by semantic version", () => {
		expect(latestSafetyTag([release("v1.1.0", true), release("v1.10.0", true), release("v1.9.0", true), release("v1.11.0", false)])).toBe("v1.10.0");
	});
	it("is null without safety releases", () => expect(latestSafetyTag([release("v1.2.0", false)])).toBeNull());
});

describe("checkPin", () => {
	const releases = [release("v1.1.0", true), release("v1.2.0", false), release("v1.3.0", true), release("v1.4.0", false)];

	it("accepts a pin equal to main's when it meets the safety floor", () => {
		expect(checkPin({ pinned: "v1.3.0", mainPin: "v1.3.0", releases })).toEqual({ ok: true, floor: "v1.3.0" });
	});

	it("accepts moving forward", () => {
		expect(checkPin({ pinned: "v1.4.0", mainPin: "v1.3.0", releases }).ok).toBe(true);
	});

	it("refuses a pin older than main's", () => {
		const result = checkPin({ pinned: "v1.3.0", mainPin: "v1.4.0", releases });
		expect(result).toMatchObject({ ok: false, floor: "v1.4.0" });
		expect(result.ok ? "" : result.reason).toContain("older than main");
	});

	it("refuses a pin below the latest safety release", () => {
		const result = checkPin({ pinned: "v1.2.0", mainPin: "v1.2.0", releases });
		expect(result).toMatchObject({ ok: false, floor: "v1.3.0" });
		expect(result.ok ? "" : result.reason).toContain("safety release v1.3.0");
	});

	it("compares versions numerically, not as text", () => {
		expect(checkPin({ pinned: "v1.10.0", mainPin: "v1.9.0", releases: [] }).ok).toBe(true);
		expect(checkPin({ pinned: "v1.9.0", mainPin: "v1.10.0", releases: [] }).ok).toBe(false);
	});

	it("uses only the safety floor when main has no readable pin", () => {
		expect(checkPin({ pinned: "v1.3.0", mainPin: null, releases }).ok).toBe(true);
		expect(checkPin({ pinned: "v1.1.0", mainPin: null, releases }).ok).toBe(false);
	});
});

describe("isForkCaused", () => {
	it("treats a missing fork ref, an unusable pin, and fork code that does not build as the fork's fault", () => {
		expect(isForkCaused(new RefNotFoundError("work/x"))).toBe(true);
		expect(isForkCaused(new StockTagError("main", "not a release tag"))).toBe(true);
		expect(isForkCaused(new ForkCodeError("fork has no app/index.ts"))).toBe(true);
	});

	it("treats everything else as infrastructure, to be retried", () => {
		expect(isForkCaused(new Error("Artifacts unavailable"))).toBe(false);
		expect(isForkCaused(new TypeError("fetch failed"))).toBe(false);
		expect(isForkCaused("boom")).toBe(false);
	});
});

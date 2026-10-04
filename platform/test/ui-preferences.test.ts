import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCENTS, DEFAULT_UI_PREFERENCES, FONT_STACKS, UI_LIMITS, UI_PREFERENCES_PATH, WIDGETS, parseUiPreferences, validateUiPreferences } from "../src/ui/preferences.ts";

describe("validateUiPreferences", () => {
	it("accepts a full, valid preferences object", () => {
		const prefs = { font: "palatino", density: "compact", accent: "violet", tabs: [{ title: "Charts", widgets: ["answers-by-intent", "gate-history"] }] };
		expect(validateUiPreferences(prefs)).toEqual({ ok: true, preferences: prefs });
	});

	it("accepts an empty object (every key is optional)", () => {
		expect(validateUiPreferences({})).toEqual({ ok: true, preferences: {} });
	});

	it.each([
		[[], "must be a JSON object"],
		[{ font: "Comic Sans" }, "font must be one of"],
		[{ density: "tiny" }, "density must be"],
		[{ accent: "#ff0000" }, "accent must be one of"],
		[{ script: "alert(1)" }, 'unknown key "script"'],
		[{ tabs: {} }, "tabs must be an array"],
		[{ tabs: Array.from({ length: 5 }, (_, i) => ({ title: `T${i}`, widgets: ["override-rate"] })) }, "at most 4"],
		[{ tabs: [{ title: "", widgets: ["override-rate"] }] }, "title must be 1 to 40"],
		[{ tabs: [{ title: "x".repeat(41), widgets: ["override-rate"] }] }, "title must be 1 to 40"],
		[{ tabs: [{ title: "Bad\u0007", widgets: ["override-rate"] }] }, "plain text"],
		[{ tabs: [{ title: "<b>x</b>", widgets: ["override-rate"] }] }, "plain text"],
		[{ tabs: [{ title: "T", widgets: [] }] }, "1 to 6 widgets"],
		[{ tabs: [{ title: "T", widgets: Array(7).fill("override-rate") }] }, "1 to 6 widgets"],
		[{ tabs: [{ title: "T", widgets: ["pie-of-everything"] }] }, "widget must be one of"],
		[{ tabs: [{ title: "T", widgets: ["override-rate", "override-rate"] }] }, "more than once"],
		[{ tabs: [{ title: "T", widgets: ["override-rate"], html: "<script>" }] }, 'unknown key "html"'],
		[{ tabs: [{ title: "A", widgets: ["override-rate"] }, { title: "a", widgets: ["gate-history"] }] }, "same title"],
	])("rejects %j", (value, message) => {
		const result = validateUiPreferences(value);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.join("; ")).toContain(message);
	});
});

describe("parseUiPreferences", () => {
	it("treats a missing file as the defaults", () => {
		expect(parseUiPreferences(null)).toEqual({ ok: true, preferences: {}, present: false });
	});

	it("reports invalid JSON", () => {
		const result = parseUiPreferences("{font:");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors[0]).toContain("not valid JSON");
	});

	it("rejects an oversized file before parsing it", () => {
		const result = parseUiPreferences(" ".repeat(UI_LIMITS.maxBytes + 1));
		expect(result.ok).toBe(false);
	});

	it("parses a valid file", () => {
		expect(parseUiPreferences('{"font":"georgia"}')).toEqual({ ok: true, preferences: { font: "georgia" }, present: true });
	});
});

describe("allowlists", () => {
	it("uses web-safe font stacks only, never a web font URL", () => {
		for (const stack of Object.values(FONT_STACKS)) {
			expect(stack).not.toMatch(/url\(|@import|https?:/);
			expect(stack).toMatch(/(serif|sans-serif|monospace|system-ui)$/);
		}
		expect(FONT_STACKS.palatino).toBe('"Palatino Linotype", "Book Antiqua", Palatino, serif');
	});

	it("has a style rule for every font, accent, and density the schema allows", () => {
		const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
		for (const font of Object.keys(FONT_STACKS)) expect(css).toContain(`[data-font="${font}"]`);
		for (const accent of ACCENTS) expect(css).toContain(`[data-accent="${accent}"]`);
		expect(css).toContain('[data-density="compact"]');
	});

	it("keeps the browser's copy of the allowlists in step with the platform", async () => {
		const ui = await import("../public/js/ui-prefs.js");
		expect(Object.keys(ui.FONT_LABELS).sort()).toEqual(Object.keys(FONT_STACKS).sort());
		expect([...ui.ACCENT_KEYS].sort()).toEqual([...ACCENTS].sort());
		expect(Object.keys(ui.WIDGET_LABELS).sort()).toEqual([...WIDGETS].sort());
	});

	it("exposes the file path and defaults", () => {
		expect(UI_PREFERENCES_PATH).toBe("ui/preferences.json");
		expect(validateUiPreferences(DEFAULT_UI_PREFERENCES).ok).toBe(true);
	});
});

describe("browser sanitizePreferences", () => {
	it("keeps only allowlisted values, whatever the platform sent", async () => {
		const ui = await import("../public/js/ui-prefs.js");
		expect(ui.sanitizePreferences({ font: "url(x)", accent: "teal", density: "compact", tabs: [{ title: "Charts", widgets: ["override-rate", "script"] }, { title: "", widgets: ["gate-history"] }], extra: 1 }))
			.toEqual({ accent: "teal", density: "compact", tabs: [{ title: "Charts", widgets: ["override-rate"] }] });
	});
});

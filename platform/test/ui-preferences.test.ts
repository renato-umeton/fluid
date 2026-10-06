import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCENTS, DEFAULT_UI_PREFERENCES, FONT_STACKS, LOOKS, UI_LIMITS, UI_PREFERENCES_PATH, WIDGETS, parseUiPreferences, uiPreferencesJson, validateUiPreferences } from "../src/ui/preferences.ts";

describe("validateUiPreferences", () => {
	it("accepts a full, valid preferences object", () => {
		const prefs = { font: "palatino", density: "compact", accent: "violet", tabs: [{ title: "Charts", widgets: ["answers-by-intent", "gate-history"] }] };
		expect(validateUiPreferences(prefs)).toEqual({ ok: true, preferences: prefs });
	});

	it.each(["standard", "crimson", "luna-xp"])("accepts the %s look", (look) => {
		expect(validateUiPreferences({ look, accent: "teal" })).toEqual({ ok: true, preferences: { look, accent: "teal" } });
	});

	it("writes the look first in the canonical file", () => {
		expect(Object.keys(JSON.parse(uiPreferencesJson({ font: "mono", look: "crimson" })))).toEqual(["look", "font"]);
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
		[{ look: "st-jude" }, "look must be one of"],
		[{ look: 7 }, "look must be one of"],
		[{ look: ["crimson"] }, "look must be one of"],
		[{ theme: "dark" }, 'unknown key "theme"'],
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
		for (const look of LOOKS.filter((l) => l !== "standard")) {
			expect(css).toContain(`:root[data-look="${look}"]`);
			expect(css).toContain(`:root[data-look="${look}"][data-theme="dark"]`);
			expect(css).toContain(`:root[data-look="${look}"]:not([data-theme="light"])`);
		}
	});

	it("never changes the mode colors or loads anything in a look", () => {
		const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
		const looks = css.slice(css.indexOf("/* Looks:"), css.indexOf("/* Web-safe font stacks only"));
		expect(looks.length).toBeGreaterThan(0);
		expect(looks).not.toMatch(/--(clinical|research|administrative|multi)\b/);
		expect(looks).not.toMatch(/url\(|@import|@font-face/);
		expect(looks).not.toMatch(/\.card\b|\.badge\b/);
	});

	it("keeps the browser's copy of the allowlists in step with the platform", async () => {
		const ui = await import("../public/js/ui-prefs.js");
		expect(Object.keys(ui.FONT_LABELS).sort()).toEqual(Object.keys(FONT_STACKS).sort());
		expect([...ui.ACCENT_KEYS].sort()).toEqual([...ACCENTS].sort());
		expect(Object.keys(ui.WIDGET_LABELS).sort()).toEqual([...WIDGETS].sort());
		expect(Object.keys(ui.LOOK_LABELS).sort()).toEqual([...LOOKS].sort());
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

	it("keeps a known look and drops an unknown one", async () => {
		const ui = await import("../public/js/ui-prefs.js");
		expect(ui.sanitizePreferences({ look: "luna-xp" })).toEqual({ look: "luna-xp" });
		expect(ui.sanitizePreferences({ look: "st-jude" })).toEqual({});
		expect(ui.sanitizePreferences({ look: { toString: () => "crimson" } })).toEqual({});
	});

	it("sets data-look on the root, and clears it for the standard look", async () => {
		const ui = await import("../public/js/ui-prefs.js");
		const attrs = new Map<string, string>();
		const root = { setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k) };
		ui.applyUiPreferences(root, { look: "crimson", accent: "blue" });
		expect(Object.fromEntries(attrs)).toEqual({ "data-look": "crimson", "data-accent": "blue" });
		ui.applyUiPreferences(root, { look: "standard" });
		expect(attrs.size).toBe(0);
	});

	it("describes the look for the rail", async () => {
		const ui = await import("../public/js/ui-prefs.js");
		expect(ui.describePreferences({ look: "luna-xp", font: "georgia" })).toBe("Luna XP look, Georgia font");
		expect(ui.describePreferences({ look: "standard" })).toBe("");
	});
});

describe("browser uiChanges (what a merged customization changed)", () => {
	it("lists the new look and the added tab with its index", async () => {
		const ui = await import("../public/js/ui-prefs.js");
		const before = { tabs: [{ title: "Mine", widgets: ["override-rate"] }] };
		const after = { look: "crimson", tabs: [{ title: "Mine", widgets: ["override-rate"] }, { title: "Charts", widgets: ["gate-history"] }] };
		expect(ui.uiChanges(before, after)).toEqual({ lines: ["Crimson look", 'new tab "Charts"'], newTabs: [{ title: "Charts", index: 1 }] });
	});

	it("reports nothing when nothing changed", async () => {
		const ui = await import("../public/js/ui-prefs.js");
		expect(ui.uiChanges({ font: "mono" }, { font: "mono" })).toEqual({ lines: [], newTabs: [] });
		expect(ui.uiChanges({ look: "crimson" }, {}).lines).toEqual(["Standard look"]);
	});
});

describe("browser mergeOutcome (the Customize success line)", () => {
	const changes = { lines: ["Crimson look", 'new tab "Charts"'], newTabs: [{ title: "Charts", index: 0 }] };

	it.each([
		[{ status: "running", yellow: { runId: "y1", health: "yellow" } }, "yellow", /^Merged to main, live in yellow: Crimson look, new tab "Charts"\./, true],
		[{ status: "running", yellow: { runId: "y1", health: "cancelled" } }, "yellow", /live in yellow/, true],
		[{ status: "passed", yellow: { runId: "y1", health: "green" } }, "applied", /^Applied: Crimson look, new tab "Charts"\.$/, true],
		[{ status: "passed" }, "applied", /^Applied:/, true],
		[{ status: "failed", yellow: { runId: "y1", health: "rolled_back" } }, "rolled_back", /^Rolled back:.*Crimson look/, false],
		[{ status: "failed", yellow: { runId: "y1", health: "yellow", failure: {} } }, "failed", /^The yellow soak failed/, false],
	])("%j is %s", async (run, state, text, open) => {
		const ui = await import("../public/js/ui-prefs.js");
		const out = ui.mergeOutcome(run, changes);
		expect(out.state).toBe(state);
		expect(out.text).toMatch(text);
		expect(out.open).toBe(open);
	});

	it("says so when the preferences were already like this", async () => {
		const ui = await import("../public/js/ui-prefs.js");
		expect(ui.mergeOutcome({ status: "passed" }, { lines: [], newTabs: [] }).text).toBe("Applied. Your look and tabs were already like this.");
	});
});

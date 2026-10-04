import { describe, expect, it } from "vitest";
import { matchRecipe, replanOnMovedMain } from "../src/agents/recipes.ts";
import { parseUiRequest, uiChange } from "../src/agents/ui-recipe.ts";
import { suggestTests, validateProbe } from "../src/agents/suggester.ts";
import { WIDGETS, parseUiPreferences } from "../src/ui/preferences.ts";

const USER_REQUEST = "Always use palatino lino type kind of fonts and add a tab with charts";

describe("parseUiRequest", () => {
	it("maps the exact user request to the palatino stack and a default chart tab", () => {
		const m = parseUiRequest(USER_REQUEST)!;
		expect(m.font).toBe("palatino");
		expect(m.tab).toEqual({ title: "Charts", widgets: [...WIDGETS] });
		expect(m.notes.map((n) => n.phrase)).toEqual(["palatino lino type kind of fonts", "a tab with charts"]);
		expect(m.notes[0]!.mapped).toContain("Palatino Linotype");
	});

	it.each([
		["Switch to a Georgia typeface", { font: "georgia" }],
		["Use a serif font", { font: "georgia" }],
		["I want a sans-serif font like Optima", { font: "humanist-sans" }],
		["Use a monospace font", { font: "mono" }],
		["Use the system font", { font: "system" }],
		["Make the layout compact", { density: "compact" }],
		["More whitespace please, a comfortable layout", { density: "comfortable" }],
		["Make the accent color purple", { accent: "violet" }],
		["Use teal for buttons and links", { accent: "teal" }],
	])("%s", (request, expected) => {
		expect(parseUiRequest(request)).toMatchObject(expected);
	});

	it("picks the widgets a request names", () => {
		expect(parseUiRequest("Add a dashboard tab showing my override rate and confidence")!.tab).toEqual({ title: "Dashboard", widgets: ["confidence-distribution", "override-rate"] });
	});

	it("uses a title the request names", () => {
		expect(parseUiRequest('Add a tab called "My stats" with charts of gate results')!.tab).toEqual({ title: "My stats", widgets: ["gate-history"] });
	});

	it.each(["Lower my confidence threshold to 0.6", "Add a REDCap connector", "Make research answers shorter", "Change the colors"])("returns null for %s", (request) => {
		expect(parseUiRequest(request)).toBeNull();
	});
});

describe("matchRecipe for UI requests", () => {
	it("routes the user's request to the ui recipe, not the model", () => {
		expect(matchRecipe(USER_REQUEST)).toEqual({ kind: "ui" });
	});

	it("keeps tau and REDCap requests on their recipes", () => {
		expect(matchRecipe("Raise my confidence threshold to 0.9")).toMatchObject({ kind: "tau" });
		expect(matchRecipe("Add a REDCap connector so research mode reports enrollment")).toEqual({ kind: "redcap" });
	});
});

describe("uiChange", () => {
	it("writes a valid ui/preferences.json and explains the mapping", () => {
		const change = uiChange(null, USER_REQUEST);
		expect(Object.keys(change.files)).toEqual(["ui/preferences.json"]);
		const parsed = parseUiPreferences(change.files["ui/preferences.json"]!);
		expect(parsed).toMatchObject({ ok: true, preferences: { font: "palatino", tabs: [{ title: "Charts" }] } });
		expect(change.recipe).toBe("ui");
		expect(change.modes_affected).toEqual([]);
		expect(change.mapped).toHaveLength(2);
		expect(change.purpose).toContain("never change answer cards");
	});

	it("keeps existing preferences and replaces a tab with the same title", () => {
		const before = JSON.stringify({ density: "compact", tabs: [{ title: "Charts", widgets: ["override-rate"] }, { title: "Other", widgets: ["gate-history"] }] });
		const out = JSON.parse(uiChange(before, USER_REQUEST).files["ui/preferences.json"]!);
		expect(out.density).toBe("compact");
		expect(out.tabs.map((t: { title: string }) => t.title)).toEqual(["Charts", "Other"]);
		expect(out.tabs[0].widgets).toHaveLength(6);
	});

	it("refuses a fifth tab with a clear message", () => {
		const before = JSON.stringify({ tabs: ["A", "B", "C", "D"].map((title) => ({ title, widgets: ["override-rate"] })) });
		expect(() => uiChange(before, USER_REQUEST)).toThrow(/already has 4 extra tabs/);
	});

	it("says so when the fork already has these preferences", () => {
		const first = uiChange(null, "Use a Georgia font").files["ui/preferences.json"]!;
		expect(() => uiChange(first, "Use a Georgia font")).toThrow(/already/);
	});

	it("replaces an unreadable file instead of building on it", () => {
		expect(parseUiPreferences(uiChange("{oops", "Use a Georgia font").files["ui/preferences.json"]!)).toMatchObject({ ok: true, preferences: { font: "georgia" } });
	});
});

describe("ui recipe follow-ups", () => {
	it("suggests a tier 3 config probe on ui/preferences.json asserting the preference", () => {
		const change = uiChange(null, USER_REQUEST);
		const [s, ...rest] = suggestTests({ change, intentId: "int_1", invariants: null });
		expect(rest).toEqual([]);
		expect(s!.probe).toMatchObject({ kind: "config", file: "ui/preferences.json" });
		expect(s!.probe.assert).toEqual([
			{ path: "font", equals: "palatino" },
			{ path: "tabs", some: { path: "title", equals: "Charts" } },
		]);
		expect(validateProbe(s!.probe)).toBeNull();
	});

	it("reapplies the recipe when main moved", () => {
		const change = uiChange(null, USER_REQUEST);
		const current = { "ui/preferences.json": JSON.stringify({ accent: "teal" }) };
		const out = replanOnMovedMain({ change, request: USER_REQUEST, before: {}, current, protocols: [] });
		expect("files" in out && JSON.parse(out.files["ui/preferences.json"]!)).toMatchObject({ accent: "teal", font: "palatino" });
	});
});

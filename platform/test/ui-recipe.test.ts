import { describe, expect, it } from "vitest";
import { matchRecipe, replanOnMovedMain } from "../src/agents/recipes.ts";
import { UI_RULES, parseUiRequest, uiChange } from "../src/agents/ui-recipe.ts";
import { suggestTests, validateProbe } from "../src/agents/suggester.ts";
import { UI_LIMITS, WIDGETS, parseUiPreferences } from "../src/ui/preferences.ts";

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

const ST_JUDE = "I want the St. Jude Children's Research Hospital look and feel";
const CHART_PAGE = "add a page of charts";
const XP = "make the look and feel like it is 2001 and we run on windows xp";

describe("look requests", () => {
	it("maps a St. Jude request to the crimson look, colors only", () => {
		const m = parseUiRequest(ST_JUDE)!;
		expect(m).toMatchObject({ look: "crimson" });
		expect(m.accent).toBeUndefined();
		expect(m.notes).toHaveLength(1);
		expect(m.notes[0]!.phrase).toBe("St. Jude Children's Research Hospital look and feel");
		expect(m.notes[0]!.mapped).toContain('look "crimson"');
		expect(m.notes[0]!.mapped).toContain("no logos");
	});

	it("maps a Windows XP request to the luna-xp look", () => {
		const m = parseUiRequest(XP)!;
		expect(m).toMatchObject({ look: "luna-xp" });
		expect(m.notes).toHaveLength(1);
		expect(m.notes[0]!.mapped).toContain('look "luna-xp"');
	});

	it("maps a page of charts to a chart tab and says page became tab", () => {
		const m = parseUiRequest(CHART_PAGE)!;
		expect(m.tab).toEqual({ title: "Charts", widgets: [...WIDGETS] });
		expect(m.notes[0]!.mapped).toContain("page");
	});

	it.each([
		["Use the crimson theme", "crimson"],
		["Give me a retro look", "luna-xp"],
		["Make it look like the early 2000s", "luna-xp"],
		["Y2K style please", "luna-xp"],
		["Go back to the default look", "standard"],
		["Reset the look", "standard"],
	])("%s", (request, look) => {
		expect(parseUiRequest(request)).toMatchObject({ look });
	});

	it("does not read xp inside another word as Windows XP", () => {
		expect(parseUiRequest("Make the layout expanded and compact")?.look).toBeUndefined();
	});

	it("treats look, feel, style, skin, and brand words as color context", () => {
		expect(parseUiRequest("make the look red")).toMatchObject({ accent: "rose" });
		expect(parseUiRequest("a green style")).toMatchObject({ accent: "green" });
		expect(parseUiRequest("blue branding")).toMatchObject({ accent: "blue" });
	});

	it("keeps an explicit color next to a look as the accent", () => {
		expect(parseUiRequest("Windows XP look with violet buttons")).toMatchObject({ look: "luna-xp", accent: "violet" });
		expect(parseUiRequest("Use the crimson look")!.accent).toBeUndefined();
	});

	it.each([ST_JUDE, CHART_PAGE, XP])("routes %s to the ui recipe", (request) => {
		expect(matchRecipe(request)).toEqual({ kind: "ui" });
	});

	it("writes the look into ui/preferences.json and keeps other preferences", () => {
		const before = JSON.stringify({ font: "georgia", tabs: [{ title: "Mine", widgets: ["override-rate"] }] });
		const crimson = uiChange(before, ST_JUDE);
		expect(JSON.parse(crimson.files["ui/preferences.json"]!)).toEqual({ look: "crimson", font: "georgia", tabs: [{ title: "Mine", widgets: ["override-rate"] }] });
		expect(crimson.mapped![0]).toMatch(/^"St\. Jude Children's Research Hospital look and feel" -> look "crimson"/);
		expect(parseUiPreferences(uiChange(null, XP).files["ui/preferences.json"]!)).toMatchObject({ ok: true, preferences: { look: "luna-xp" } });
		expect(parseUiPreferences(uiChange(null, CHART_PAGE).files["ui/preferences.json"]!)).toMatchObject({ ok: true, preferences: { tabs: [{ title: "Charts", widgets: [...WIDGETS] }] } });
	});

	it("says there is nothing to change when the look is already standard", () => {
		expect(() => uiChange("{}", "Reset the look")).toThrow(/already/);
		expect(JSON.parse(uiChange('{"look":"crimson"}', "Reset the look").files["ui/preferences.json"]!)).toEqual({ look: "standard" });
	});

	it("suggests a config probe that asserts the look", () => {
		const [s] = suggestTests({ change: uiChange(null, XP), intentId: "int_1", invariants: null });
		expect(s!.probe.assert).toEqual([{ path: "look", equals: "luna-xp" }]);
	});
});

/** Requests about answer content that mention a look word in passing; they are code changes, not looks. */
const NOT_LOOKS = [
	"Make clinical answers cite the 2001 ACC/AHA guideline",
	"Answer questions about protocol IRB-2001-0042",
	"Show patients enrolled since 2001 in a view",
	"Add the XP score to research answers",
	"Show retro dosing history in clinical answers",
	"Add a dosing section for St. Jude protocols",
	"Use the default style for answer citations",
	"Show brand and generic names, with generics in green",
	"Add a section on dosing trends to research answers",
];

describe("requests about answer content stay with the model", () => {
	it.each(NOT_LOOKS)("%s is not a UI preference", (request) => {
		expect(parseUiRequest(request)).toBeNull();
		expect(matchRecipe(request)).toBeNull();
	});

	it("needs look context for era and brand words, but not for Windows XP", () => {
		expect(parseUiRequest("Make it feel like 2001")).toMatchObject({ look: "luna-xp" });
		expect(parseUiRequest("Switch to Windows XP")).toMatchObject({ look: "luna-xp" });
		expect(parseUiRequest("Use crimson buttons")).toMatchObject({ accent: "rose" });
		expect(parseUiRequest("Use crimson buttons")!.look).toBeUndefined();
		expect(parseUiRequest("Use brand colors in red")).toMatchObject({ accent: "rose" });
	});

	it("keeps chart tabs that name answers as data", () => {
		expect(parseUiRequest("Add a tab with charts of answers by intent")!.tab).toEqual({ title: "Charts", widgets: ["answers-by-intent"] });
	});
});

/** A look plus a chart tab about answers: the content words belong to the tab, not the look. */
const LOOK_AND_TAB: [string, string, string[]][] = [
	["Make it look like Windows XP and add a tab with charts of answers by intent", "luna-xp", ["answers-by-intent"]],
	["Add a tab with charts of my answers and make it look like Windows XP", "luna-xp", ["answers-by-intent"]],
	["St. Jude look and a page with answer charts", "crimson", ["answers-by-intent"]],
	["Windows XP look, plus a dashboard of citations and confidence", "luna-xp", ["confidence-distribution", "sources-by-kind"]],
];

describe("a look combined with a chart tab", () => {
	it.each(LOOK_AND_TAB)("%s maps both the look and the tab", (request, look, widgets) => {
		const m = parseUiRequest(request)!;
		expect(m.look).toBe(look);
		expect(m.tab?.widgets).toEqual(widgets);
		expect(matchRecipe(request)).toEqual({ kind: "ui" });
	});

	it("does not count an answers view as answer content", () => {
		expect(parseUiRequest("Give the UI a St. Jude look and feel for my answers view")).toMatchObject({ look: "crimson" });
	});

	it("counts colors and palette as look context", () => {
		expect(parseUiRequest("Use St Jude colors")).toMatchObject({ look: "crimson" });
		expect(parseUiRequest("Use St Jude colors")!.accent).toBeUndefined();
		expect(parseUiRequest("A retro palette please")).toMatchObject({ look: "luna-xp" });
	});

	it.each(["Use St. Jude colors in clinical answers", "Cite St. Jude protocols in a retro color scheme for answers"])("still keeps %s away from looks", (request) => {
		expect(parseUiRequest(request)).toBeNull();
		expect(matchRecipe(request)).toBeNull();
	});
});

/** Look words in a clause that is not about the look: the look context must be in the same clause. */
const OTHER_CLAUSE = [
	"Add the 2001 cutoff to the formulary lookup and change the colors",
	"Add St. Jude to the list of sites, then fix the colors",
	"Support XP units in the formulary module; colors stay the same",
	"Make answers mention Windows XP compatibility",
	"Add the original style guide link to the policy module",
];
/** UI words next to a code change: the model gets the whole request. */
const MIXED = ["Cite the 2001 guideline in clinical answers and use the default style", "Make research answers shorter and use a serif font", "Add enrollment counts to research answers, then make the buttons teal"];

describe("look context and content in the same clause", () => {
	it.each(OTHER_CLAUSE)("%s is not a UI preference", (request) => {
		expect(parseUiRequest(request)).toBeNull();
		expect(matchRecipe(request)).toBeNull();
	});

	it("keeps the color clause and drops the unrelated era word", () => {
		const m = parseUiRequest("Add the 2001 cutoff to the formulary lookup; use a blue theme")!;
		expect(m.accent).toBe("blue");
		expect(m.look).toBeUndefined();
	});

	it("still maps Windows XP with a look word nearby", () => {
		expect(parseUiRequest(XP)).toMatchObject({ look: "luna-xp" });
		expect(parseUiRequest("Switch to Windows XP")).toMatchObject({ look: "luna-xp" });
	});
});

/** One preference applied to a part of the page that holds answers: still a UI request. */
const UI_ON_ANSWERS: [string, Record<string, string>][] = [
	["Use Georgia for the answer cards", { font: "georgia" }],
	["Make the links in answers blue", { accent: "blue" }],
	["Use a monospace font for citations", { font: "mono" }],
	["Make the cards look compact", { density: "compact" }],
];

describe("a preference for the answer area stays with the ui recipe", () => {
	it.each(UI_ON_ANSWERS)("%s", (request, expected) => {
		expect(parseUiRequest(request)).toMatchObject(expected);
		expect(matchRecipe(request)).toEqual({ kind: "ui" });
	});

	it("sends a request whose other clause changes answers to the model", () => {
		expect(parseUiRequest("Make the answer text larger and use Palatino")).toMatchObject({ font: "palatino" });
		expect(matchRecipe("Make the answer text larger and use Palatino")).toBeNull();
	});
});

describe("mixed requests go to the model", () => {
	it.each(MIXED)("%s is routed to the model", (request) => {
		expect(parseUiRequest(request)).not.toBeNull();
		expect(matchRecipe(request)).toBeNull();
	});

	it.each([...LOOK_AND_TAB.map(([r]) => r), "add a tab with charts of answers by intent", "Add a tab with charts, citations and answers", USER_REQUEST, CHART_PAGE])("%s stays with the ui recipe", (request) => {
		expect(matchRecipe(request)).toEqual({ kind: "ui" });
	});
});

describe("uiChange edge cases", () => {
	it("says there is nothing to change for a reset with no file", () => {
		expect(() => uiChange(null, "Reset the look")).toThrow(/nothing to change/);
	});

	it("joins notes that share a phrase into one mapped line", () => {
		const change = uiChange(null, "Use a compact serif font");
		expect(change.mapped).toEqual(['"a compact serif font" -> density "compact"; font "georgia": Georgia, "Times New Roman", Times, serif']);
	});
});

const MOCK_SAME = [ST_JUDE, CHART_PAGE, XP, USER_REQUEST, "Use a serif font", "Make the layout compact", "Make the accent color purple", "make the look red", "Windows XP look with violet buttons",
	"Add a dashboard tab showing my override rate and confidence", 'Add a tab called "My stats" with charts of gate results', "Reset the look", "Make research answers shorter", "Change the colors",
	"Make it feel like 2001", "Use crimson buttons", "Use a compact serif font", ...NOT_LOOKS, ...LOOK_AND_TAB.map(([r]) => r),
	"Give the UI a St. Jude look and feel for my answers view", "Use St Jude colors", "A retro palette please", "Use St. Jude colors in clinical answers", "Cite St. Jude protocols in a retro color scheme for answers",
	...OTHER_CLAUSE, ...MIXED, "Add the 2001 cutoff to the formulary lookup; use a blue theme", "Add a tab with charts, citations and answers", "add a tab with charts of answers by intent",
	...UI_ON_ANSWERS.map(([r]) => r), "Make the answer text larger and use Palatino"];

describe("mock mode recipe", () => {
	const SAME = MOCK_SAME;

	it.each(SAME)("maps %s the same way as the platform", async (request) => {
		const mock = await import("../public/js/ui-recipe.js");
		const platform = parseUiRequest(request);
		const browser = mock.parseUiRequest(request);
		if (!platform) {
			expect(browser).toBeNull();
			return;
		}
		const pick = (m: Record<string, unknown>) => ({ font: m.font, density: m.density, accent: m.accent, look: m.look, tab: m.tab, phrases: (m.notes as { phrase: string }[]).map((n) => n.phrase) });
		expect(pick(browser)).toEqual(pick(platform as unknown as Record<string, unknown>));
	});
});

describe("mock mode matchRecipe", () => {
	it.each([...MOCK_SAME, "Raise my confidence to 0.9", "Raise my threshold", "Lower my tau", "Set tau to 0.7", "Lower my confidence threshold to 0.6", "Add a REDCap connector so research mode reports enrollment", "What is my confidence?"])("routes %s like the platform", async (request) => {
		const mock = await import("../public/js/ui-recipe.js");
		expect(mock.matchRecipe(request)).toEqual(matchRecipe(request));
	});

	it("computes the same tau target", async () => {
		const mock = await import("../public/js/ui-recipe.js");
		const { tauTarget } = await import("../src/agents/recipes.ts");
		for (const request of ["Raise my threshold", "Lower my tau", "Set tau to 0.7"]) {
			const recipe = matchRecipe(request) as Parameters<typeof tauTarget>[0];
			expect(mock.tauTarget(mock.matchRecipe(request), 0.85)).toBe(tauTarget(recipe, 0.85));
		}
	});
});

describe("mock and platform stay in step", () => {
	it("uses the same rule tables, pattern for pattern", async () => {
		const mock = await import("../public/js/ui-recipe.js");
		const shape = (rules: Record<string, unknown>) => Object.fromEntries(Object.entries(rules).map(([name, value]) => [name,
			value instanceof RegExp ? [value.source, value.flags] : (value as [string, RegExp][]).map(([k, re]) => [k, re.source, re.flags])]));
		expect(Object.keys(mock.UI_RULES).sort()).toEqual(Object.keys(UI_RULES).sort());
		expect(shape(mock.UI_RULES)).toEqual(shape(UI_RULES as unknown as Record<string, unknown>));
	});

	it("uses the platform limits", async () => {
		const ui = await import("../public/js/ui-prefs.js");
		expect({ maxTabs: ui.MAX_TABS, maxWidgets: ui.MAX_WIDGETS, maxTitle: ui.MAX_TITLE }).toEqual({ maxTabs: UI_LIMITS.maxTabs, maxWidgets: UI_LIMITS.maxWidgets, maxTitle: UI_LIMITS.maxTitle });
	});

	const full = { tabs: ["A", "B", "C", "D"].map((title) => ({ title, widgets: ["override-rate"] })) };
	it.each([
		[null, ST_JUDE],
		[null, XP],
		[null, CHART_PAGE],
		[{ font: "georgia", tabs: [{ title: "Mine", widgets: ["override-rate"] }] }, ST_JUDE],
		[{ look: "crimson" }, "Reset the look"],
		[{}, "Reset the look"],
		[null, "Reset the look"],
		[full, CHART_PAGE],
		[{ tabs: [{ title: "charts", widgets: ["override-rate"] }] }, CHART_PAGE],
		[{ font: "georgia" }, "Use a Georgia font"],
		[null, 'Add a tab called "' + "x".repeat(60) + '" with charts'],
	])("merges %j with %s the same way", async (current, request) => {
		const mock = await import("../public/js/ui-recipe.js");
		let platform: unknown;
		try {
			platform = { ok: true, prefs: JSON.parse(uiChange(current === null ? null : JSON.stringify(current), request).files["ui/preferences.json"]!) };
		} catch (error) {
			platform = { ok: false, error: (error as Error).message };
		}
		const browser = mock.mergeUiRequest(current, mock.parseUiRequest(request));
		expect(browser).toEqual(platform);
	});

	it("writes the same mapped lines", async () => {
		const mock = await import("../public/js/ui-recipe.js");
		for (const request of [ST_JUDE, XP, CHART_PAGE, "Use a compact serif font"]) {
			expect(mock.mappedLines(mock.parseUiRequest(request).notes).length).toBe(uiChange(null, request).mapped!.length);
		}
	});
});

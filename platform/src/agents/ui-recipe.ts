// UI preferences recipe: requests about fonts, density, colors, or extra tabs
// with charts become a change to ui/preferences.json, the declarative file the
// platform validates and the UI applies. No code is written and answer cards
// are never touched. Requests are mapped to the closest allowlisted values,
// and the change says exactly what was mapped to what.
import { FONT_STACKS, UI_LIMITS, UI_PREFERENCES_PATH, WIDGET_DESCRIPTIONS, WIDGETS, parseUiPreferences, uiPreferencesJson, type Accent, type Density, type FontKey, type UiPreferences, type UiTab, type Widget } from "../ui/preferences.ts";
import type { PlannedChange } from "./recipes.ts";

export interface UiRequestMapping {
	font?: FontKey;
	density?: Density;
	accent?: Accent;
	tab?: UiTab;
	/** What part of the request became which preference, in request order. */
	notes: { phrase: string; mapped: string }[];
}

const FONT_RULES: [FontKey, RegExp][] = [
	["palatino", /\b(palatino|palatine|book\s*antiqua|lino\s*type|linotype)\b/i],
	["georgia", /\b(georgia|times(\s+new\s+roman)?)\b/i],
	["humanist-sans", /\b(humanist|optima|candara|gill\s*sans|frutiger|sans[-\s]?serif|sans)\b/i],
	["mono", /\b(mono|monospaced?|typewriter|courier)\b/i],
	["system", /\b(system|native|platform)\s+(fonts?|typefaces?|type)\b/i],
	["georgia", /\bserif\b/i],
];
const DENSITY_RULES: [Density, RegExp][] = [
	["compact", /\b(compact|dense|denser|tighter|condensed|less\s+(white\s*space|whitespace|padding|spacing))\b/i],
	["comfortable", /\b(comfortable|spacious|roomy|airy|relaxed|more\s+(white\s*space|whitespace|padding|spacing))\b/i],
];
const ACCENT_RULES: [Accent, RegExp][] = [
	["teal", /\b(teal|turquoise|cyan|aqua)\b/i],
	["blue", /\b(blue|navy|azure|cobalt)\b/i],
	["violet", /\b(violet|purple|lavender|indigo|plum)\b/i],
	["amber", /\b(amber|orange|gold|golden|yellow|mustard)\b/i],
	["green", /\b(green|emerald|olive|sage)\b/i],
	["rose", /\b(rose|pink|red|crimson|magenta|burgundy|maroon)\b/i],
	["slate", /\b(slate|gr[ae]y|charcoal|graphite)\b/i],
];
const COLOR_CONTEXT = /\b(colou?rs?|accents?|themes?|palette|highlights?|buttons?|links?|tint)\b/i;
const TAB_WORD = /\b(tabs?|dashboards?|pages?|panels?|views?|sections?)\b/i;
const CHART_WORD = /\b(charts?|graphs?|plots?|dashboards?|visuali[sz]ations?|stats|statistics|analytics|metrics|trends?)\b/i;
const WIDGET_RULES: [Widget, RegExp][] = [
	["answers-by-intent", /\b(intents?|answers?|questions?|ledger|modes?)\b/i],
	["confidence-distribution", /\bconfidence\b/i],
	["override-rate", /\boverrid(e|es|den|ing)\b/i],
	["sources-by-kind", /\b(sources?|citations?|cited|references?)\b/i],
	["intent-timeline", /\b(timeline|customi[sz]ations?|changes|build[-\s]?time)\b/i],
	["gate-history", /\b(gates?|tests?|pass(es|ed)?|tiers?)\b/i],
];
const QUOTED_TITLE = /\b(?:called|named|titled)\s+["“']([^"”'\n]{1,60})["”']/i;
const BARE_TITLE = /\b(?:called|named|titled)\s+([A-Za-z0-9][A-Za-z0-9 _-]{0,59}?)(?=\s+(?:with|that|showing|for|of)\b|[,.;]|$)/i;
const LEAD = /^(?:please\s+)?(?:(?:always|also|just)\s+)?(?:use|make|set|switch\s+to|change\s+to|add|give\s+me|show|i\s+want|i'd\s+like)\s+/i;

function clauses(request: string): string[] {
	return request.split(/\s*(?:[,;.]|\band\b|\bthen\b|\bplus\b)\s*/i).map((c) => c.trim()).filter(Boolean);
}

function phraseFor(request: string, pattern: RegExp): string {
	const clause = clauses(request).find((c) => pattern.test(c)) ?? request;
	return clause.replace(LEAD, "").trim();
}

function firstMatch<T>(rules: [T, RegExp][], text: string): { value: T; pattern: RegExp } | null {
	for (const [value, pattern] of rules) if (pattern.test(text)) return { value, pattern };
	return null;
}

function tabTitle(request: string): string | null {
	const m = QUOTED_TITLE.exec(request) ?? BARE_TITLE.exec(request);
	const title = m?.[1]?.replace(/[\u0000-\u001f\u007f-\u009f<>]/g, "").trim();
	return title ? title.slice(0, UI_LIMITS.maxTitle) : null;
}

/** Maps a request to UI preferences, or null when it names nothing the schema allows. */
export function parseUiRequest(request: string): UiRequestMapping | null {
	const text = String(request ?? "");
	const out: UiRequestMapping = { notes: [] };
	const found: { at: number; note: { phrase: string; mapped: string } }[] = [];
	const note = (pattern: RegExp, mapped: string) => {
		const phrase = phraseFor(text, pattern);
		found.push({ at: text.search(pattern), note: { phrase, mapped } });
	};

	const font = firstMatch(FONT_RULES, text);
	if (font) {
		out.font = font.value;
		note(font.pattern, `font "${font.value}": ${FONT_STACKS[font.value]}`);
	}
	const density = firstMatch(DENSITY_RULES, text);
	if (density) {
		out.density = density.value;
		note(density.pattern, `density "${density.value}"`);
	}
	if (COLOR_CONTEXT.test(text)) {
		const accent = firstMatch(ACCENT_RULES, text);
		if (accent) {
			out.accent = accent.value;
			note(accent.pattern, `accent "${accent.value}"`);
		}
	}
	const tabAt = text.search(TAB_WORD);
	const dashboard = /\bdashboards?\b/i.test(text);
	if ((tabAt >= 0 || dashboard) && CHART_WORD.test(text)) {
		const start = Math.max(0, Math.min(tabAt >= 0 ? tabAt : text.length, text.search(CHART_WORD)));
		const tail = text.slice(start);
		const named = WIDGETS.filter((w) => WIDGET_RULES.find(([k]) => k === w)![1].test(tail));
		const widgets = named.length ? named : [...WIDGETS];
		const title = tabTitle(text) ?? (dashboard ? "Dashboard" : "Charts");
		out.tab = { title, widgets };
		const shown = named.length ? widgets.map((w) => WIDGET_DESCRIPTIONS[w]).join("; ") : `the default set (${widgets.map((w) => WIDGET_DESCRIPTIONS[w]).join("; ")})`;
		note(tabAt >= 0 ? TAB_WORD : CHART_WORD, `tab "${title}" with ${widgets.length} chart${widgets.length === 1 ? "" : "s"}: ${shown}`);
	}
	if (found.length === 0) return null;
	out.notes = found.sort((a, b) => a.at - b.at).map((f) => f.note);
	return out;
}

/** The ui recipe's change: the current preferences (if readable) with the request applied. */
export function uiChange(currentText: string | null, request: string): PlannedChange {
	const mapping = parseUiRequest(request);
	if (!mapping) throw new Error("the request names no font, density, accent color, or chart tab that UI preferences support");
	const current = parseUiPreferences(currentText);
	const base: UiPreferences = current.ok ? structuredClone(current.preferences) : {};
	const next: UiPreferences = { ...base };
	if (mapping.font) next.font = mapping.font;
	if (mapping.density) next.density = mapping.density;
	if (mapping.accent) next.accent = mapping.accent;
	if (mapping.tab) {
		const tabs = [...(base.tabs ?? [])];
		const same = tabs.findIndex((t) => t.title.trim().toLowerCase() === mapping.tab!.title.toLowerCase());
		if (same >= 0) tabs[same] = mapping.tab;
		else if (tabs.length >= UI_LIMITS.maxTabs) throw new Error(`ui/preferences.json already has ${UI_LIMITS.maxTabs} extra tabs (${tabs.map((t) => t.title).join(", ")}); remove one or reuse a tab title`);
		else tabs.push(mapping.tab);
		next.tabs = tabs;
	}
	const text = uiPreferencesJson(next);
	if (current.ok && currentText !== null && text === uiPreferencesJson(base)) throw new Error("your fork already has these UI preferences; nothing to change");
	const mapped = mapping.notes.map((n) => `"${n.phrase}" -> ${n.mapped}`);
	const parts = [mapping.font && `font ${mapping.font}`, mapping.density && `density ${mapping.density}`, mapping.accent && `accent ${mapping.accent}`, mapping.tab && `tab "${mapping.tab.title}" (${mapping.tab.widgets.length} charts)`].filter(Boolean);
	return {
		summary: `Set UI preferences in ${UI_PREFERENCES_PATH}: ${parts.join(", ")}`,
		purpose: `Change how this fork's control plane looks for its owner (${parts.join(", ")}). UI preferences are declarative, validated by the platform, and never change answer cards.`,
		modes_affected: [],
		files: { [UI_PREFERENCES_PATH]: text },
		notes: { [UI_PREFERENCES_PATH]: `Mapped: ${mapped.join("; ")}${current.ok ? "" : " (the previous file was invalid and is replaced)"}` },
		recipe: "ui",
		mapped,
	};
}

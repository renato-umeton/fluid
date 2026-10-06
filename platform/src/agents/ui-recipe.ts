// UI preferences recipe: requests about a whole look, fonts, density, colors,
// or extra tabs with charts become a change to ui/preferences.json, the declarative file the
// platform validates and the UI applies. No code is written and answer cards
// are never touched. Requests are mapped to the closest allowlisted values,
// and the change says exactly what was mapped to what.
import { FONT_STACKS, LOOK_DESCRIPTIONS, UI_LIMITS, UI_PREFERENCES_PATH, WIDGET_DESCRIPTIONS, WIDGETS, parseUiPreferences, uiPreferencesJson, type Accent, type Density, type FontKey, type Look, type UiPreferences, type UiTab, type Widget } from "../ui/preferences.ts";
import type { PlannedChange } from "./recipes.ts";

export interface UiRequestMapping {
	look?: Look;
	font?: FontKey;
	density?: Density;
	accent?: Accent;
	tab?: UiTab;
	/** What part of the request became which preference, in request order. */
	notes: { phrase: string; mapped: string }[];
}

/**
 * Whole looks. A brand or an era maps to colors and shapes only, never to a
 * logo or a name. These words are common in other requests ("the 2001
 * guideline", "St. Jude protocols", "the XP score"), so a look matches only
 * when the request also talks about the look (LOOK_CONTEXT) and does not talk
 * about answer content (LOOK_CONTENT). "Windows XP" needs no look context.
 */
const LOOK_RULES: [Look, RegExp][] = [
	["crimson", /\b(?:st\.?\s*|saint\s+)jude\b|\bcrimson\b/i],
	["luna-xp", /\bwindows\s*xp\b|\bxp\b|\b2001\b|\bluna\b|\by2k\b|\bretro\b|\bearly\s*2000s\b/i],
	["standard", /\b(?:default|standard|original|stock|normal|plain)\s+(?:look|theme|style|skin|ui|design|appearance)\b(?!\s+guides?\b)|\breset\s+(?:the\s+|my\s+)?(?:look|theme|style|skin|ui|design|appearance)\b(?!\s+guides?\b)/i],
];
const LOOK_ALONE = /\bwindows\s*xp\b/i;
const LOOK_CONTEXT = /\b(looks?(\s+and\s+feel)?|feel|themes?|styles?|skins?|ui|design|appearance|colou?rs?|palette|branding|brand\s+colou?rs?)\b/i;
const LOOK_CONTENT = /\b(answers?(?!\s+(?:views?|pages?|tabs?|screens?|panels?)\b)|cards?|citations?|cite[sd]?|protocols?|patients?|guidelines?|scores?|dos(e|es|ing)|enrol(l)?(s|ed|ment|ing)?|connectors?|ledger)\b/i;
const LOOK_NAMES: Record<Look, string> = { standard: "Standard", crimson: "Crimson", "luna-xp": "Luna XP" };
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
const COLOR_CONTEXT = /\b(colou?rs?|accents?|themes?|palette|highlights?|buttons?|links?|tint|look(\s+and\s+feel)?|feel|styles?|skins?|branding|brand\s+colou?rs?)\b/i;
const TAB_WORD = /\b(tabs?|dashboards?|pages?|panels?|views?|sections?)\b/i;
const CHART_WORD = /\b(charts?|graphs?|plots?|dashboards?|visuali[sz]ations?|stats|statistics|analytics|metrics|trends?)\b/i;
/** "a section ... to research answers" changes answer content; it is not a tab. */
const ANSWER_TARGET = /\b(?:to|in|into|inside)\s+(?:the\s+|my\s+|all\s+|every\s+)?(?:(?:clinical|research|administrative)\s+)?(?:answers?|answer\s+cards?|cards?)\b/i;
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
const LEAD = /^(?:please\s+)?(?:(?:always|also|just)\s+)?(?:use|make|set|switch\s+to|change\s+to|add|give\s+me|show|i\s+want|i'd\s+like)\s+(?:the\s+)?/i;
/** Clause breaks; "look and feel" and abbreviations such as "St." stay whole. */
const CLAUSE_BREAK = /\s*(?:[,;]|(?<!\b(?:st|dr|mr|mrs|ms|vs))\.|\band\b(?!\s+feel\b)|\bthen\b|\bplus\b)\s*/i;

/** Every rule table, for the test that keeps mock mode's copy (public/js/ui-recipe.js) identical. */
export const UI_RULES = { LOOK_RULES, LOOK_ALONE, LOOK_CONTEXT, LOOK_CONTENT, FONT_RULES, DENSITY_RULES, ACCENT_RULES, COLOR_CONTEXT, TAB_WORD, CHART_WORD, ANSWER_TARGET, WIDGET_RULES, QUOTED_TITLE, BARE_TITLE, LEAD, CLAUSE_BREAK };

function clauses(request: string): string[] {
	return request.split(CLAUSE_BREAK).map((c) => c.trim()).filter(Boolean);
}

function phraseFor(request: string, pattern: RegExp): string {
	const clause = clauses(request).find((c) => pattern.test(c)) ?? request;
	return clause.replace(LEAD, "").trim();
}

function firstMatch<T>(rules: [T, RegExp][], text: string): { value: T; pattern: RegExp } | null {
	for (const [value, pattern] of rules) if (pattern.test(text)) return { value, pattern };
	return null;
}

/**
 * The look a request names. The clause that names the look must also talk
 * about the look and must not talk about answer content, so "a retro look
 * and a tab with charts of my answers" keeps both while "the 2001 cutoff in
 * the formulary lookup, and change the colors" is no look. "Windows XP"
 * needs no look word unless its clause is about answer content.
 */
function lookMatch(text: string): { value: Look; pattern: RegExp } | null {
	const lookClause = (c: string) => LOOK_CONTEXT.test(c) && !LOOK_CONTENT.test(c);
	for (const [value, pattern] of LOOK_RULES) {
		if (!pattern.test(text)) continue;
		const named = clauses(text).filter((c) => pattern.test(c));
		if ((named.length ? named : [text]).some(lookClause)) return { value, pattern };
	}
	const xp = clauses(text).filter((c) => LOOK_ALONE.test(c));
	return xp.some((c) => lookClause(c) || !LOOK_CONTENT.test(c)) ? { value: "luna-xp", pattern: LOOK_ALONE } : null;
}

/**
 * True when a clause of the request is about answer content (a code change).
 * Only clauses that map to no UI preference count. Chart tab clauses and,
 * with a chart tab, words that only name widgets
 * ("citations and answers") are UI, not content. Such a request goes to the
 * model whole, so the code part is not dropped.
 */
export function hasCodeContent(request: string): boolean {
	const text = String(request ?? "");
	const hasTab = Boolean(parseUiRequest(text)?.tab);
	const widgetWords = new RegExp(WIDGET_RULES.map(([, re]) => re.source).join("|"), "gi");
	return clauses(text).some((c) => {
		// A clause that maps a preference ("Use Georgia for the answer cards") styles the page, not the answers.
		if (parseUiRequest(c)) return false;
		if (ANSWER_TARGET.test(c)) return true;
		if (TAB_WORD.test(c) || CHART_WORD.test(c)) return false;
		return LOOK_CONTENT.test(hasTab ? c.replace(widgetWords, " ") : c);
	});
}

/** One line per phrase: notes that came from the same words are joined. */
export function mappedLines(notes: { phrase: string; mapped: string }[]): string[] {
	const byPhrase = new Map<string, string[]>();
	for (const n of notes) byPhrase.set(n.phrase, [...(byPhrase.get(n.phrase) ?? []), n.mapped]);
	return [...byPhrase].map(([phrase, mapped]) => `"${phrase}" -> ${mapped.join("; ")}`);
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

	const look = lookMatch(text);
	if (look) {
		out.look = look.value;
		note(look.pattern, `look "${look.value}" (${LOOK_NAMES[look.value]}): ${LOOK_DESCRIPTIONS[look.value]}`);
	}
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
	// The words that named the look ("crimson look", "St. Jude") are not also an accent color.
	const colorText = look ? text.replace(new RegExp(look.pattern.source, "gi"), " ") : text;
	if (COLOR_CONTEXT.test(colorText)) {
		const accent = firstMatch(ACCENT_RULES, colorText);
		if (accent) {
			out.accent = accent.value;
			note(accent.pattern, `accent "${accent.value}"`);
		}
	}
	const tabAt = text.search(TAB_WORD);
	const dashboard = /\bdashboards?\b/i.test(text);
	if ((tabAt >= 0 || dashboard) && CHART_WORD.test(text) && !ANSWER_TARGET.test(text)) {
		const start = Math.max(0, Math.min(tabAt >= 0 ? tabAt : text.length, text.search(CHART_WORD)));
		const tail = text.slice(start);
		const named = WIDGETS.filter((w) => WIDGET_RULES.find(([k]) => k === w)![1].test(tail));
		const widgets = named.length ? named : [...WIDGETS];
		const title = tabTitle(text) ?? (dashboard ? "Dashboard" : "Charts");
		out.tab = { title, widgets };
		const shown = named.length ? widgets.map((w) => WIDGET_DESCRIPTIONS[w]).join("; ") : `the default set (${widgets.map((w) => WIDGET_DESCRIPTIONS[w]).join("; ")})`;
		const word = (TAB_WORD.exec(text)?.[1] ?? "").toLowerCase();
		const asTab = word && !word.startsWith("tab") ? ` (your "${word}" becomes an extra tab in the rail)` : "";
		note(tabAt >= 0 ? TAB_WORD : CHART_WORD, `tab "${title}"${asTab} with ${widgets.length} chart${widgets.length === 1 ? "" : "s"}: ${shown}`);
	}
	if (found.length === 0) return null;
	out.notes = found.sort((a, b) => a.at - b.at).map((f) => f.note);
	return out;
}

/** The ui recipe's change: the current preferences (if readable) with the request applied. */
export function uiChange(currentText: string | null, request: string): PlannedChange {
	const mapping = parseUiRequest(request);
	if (!mapping) throw new Error("the request names no look, font, density, accent color, or chart tab that UI preferences support");
	const current = parseUiPreferences(currentText);
	const base: UiPreferences = current.ok ? structuredClone(current.preferences) : {};
	const next: UiPreferences = { ...base };
	// "standard" is the same as no look, so a fork without a look keeps its file as it is.
	if (mapping.look && !(mapping.look === "standard" && !base.look)) next.look = mapping.look;
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
	if (current.ok && text === uiPreferencesJson(base)) throw new Error("your fork already has these UI preferences; nothing to change");
	const mapped = mappedLines(mapping.notes);
	const parts = [mapping.look && `look ${mapping.look}`, mapping.font && `font ${mapping.font}`, mapping.density && `density ${mapping.density}`, mapping.accent && `accent ${mapping.accent}`, mapping.tab && `tab "${mapping.tab.title}" (${mapping.tab.widgets.length} charts)`].filter(Boolean);
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

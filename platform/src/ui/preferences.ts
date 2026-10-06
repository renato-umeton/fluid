// Fork-owned UI preferences: a declarative file, ui/preferences.json, that a
// fork (or its customization agent) writes to change how the control plane
// looks for its owner. No fork code ever runs in the browser: the platform
// validates the file against this strict schema, and the UI only maps the
// allowlisted keys to its own styles and to charts the platform computes.
// Unknown keys are rejected at every level.

export const UI_PREFERENCES_PATH = "ui/preferences.json";

/** Web-safe font stacks only; nothing loads an external font. */
export const FONT_STACKS = {
	system: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
	palatino: '"Palatino Linotype", "Book Antiqua", Palatino, serif',
	georgia: 'Georgia, "Times New Roman", Times, serif',
	"humanist-sans": 'Optima, Candara, "Segoe UI", "Noto Sans", "Trebuchet MS", sans-serif',
	mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
} as const;
export type FontKey = keyof typeof FONT_STACKS;

export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

/** Fixed accent palette; the UI defines a light and a dark shade for each. */
export const ACCENTS = ["teal", "blue", "violet", "amber", "green", "rose", "slate"] as const;
export type Accent = (typeof ACCENTS)[number];

/**
 * Whole looks: a set of colors, weights, and shapes the UI defines in
 * styles.css. "standard" is the stock look (the same as no look). Colors and
 * weights only: no logos, names, images, or loaded fonts, and the three mode
 * colors never change. An explicit font, density, or accent wins over the
 * look's own defaults.
 */
export const LOOKS = ["standard", "crimson", "luna-xp"] as const;
export type Look = (typeof LOOKS)[number];

export const LOOK_DESCRIPTIONS: Record<Look, string> = {
	standard: "the stock Fluid look",
	crimson: "bold red and white institutional colors; no logos, names, or trademarks",
	"luna-xp": "a Windows XP style from about 2001: blue title bars, a blue rail, bevelled buttons with a green primary, Tahoma-style web-safe fonts",
};

/** Chart widgets the platform computes over the user's own data. */
export const WIDGETS = ["answers-by-intent", "confidence-distribution", "override-rate", "sources-by-kind", "intent-timeline", "gate-history"] as const;
export type Widget = (typeof WIDGETS)[number];

export const WIDGET_DESCRIPTIONS: Record<Widget, string> = {
	"answers-by-intent": "run-time ledger answers by intent over time",
	"confidence-distribution": "confidence distribution of answers",
	"override-rate": "how often answers were overridden",
	"sources-by-kind": "sources cited, by kind",
	"intent-timeline": "build-time intent records over time",
	"gate-history": "gate results history",
};

export const UI_LIMITS = { maxTabs: 4, maxWidgets: 6, maxTitle: 40, maxBytes: 8 * 1024 };

export interface UiTab {
	title: string;
	widgets: Widget[];
}

export interface UiPreferences {
	look?: Look;
	font?: FontKey;
	density?: Density;
	accent?: Accent;
	tabs?: UiTab[];
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {};

const TOP_KEYS = ["look", "font", "density", "accent", "tabs"];
const TAB_KEYS = ["title", "widgets"];
/** Plain text: no control characters and no markup characters. */
const PLAIN_TEXT = /^[^\u0000-\u001f\u007f-\u009f<>]+$/;

export type UiValidation = { ok: true; preferences: UiPreferences } | { ok: false; errors: string[] };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf(list: readonly string[]): string {
	return list.map((x) => `"${x}"`).join(", ");
}

/** Validates parsed preferences. Errors name the path, so a gate failure says exactly what is wrong. */
export function validateUiPreferences(value: unknown): UiValidation {
	if (!isObject(value)) return { ok: false, errors: ["ui/preferences.json must be a JSON object"] };
	const errors: string[] = [];
	for (const key of Object.keys(value)) if (!TOP_KEYS.includes(key)) errors.push(`unknown key "${key}" (allowed: ${TOP_KEYS.join(", ")})`);
	if (value.look !== undefined && !(LOOKS as readonly unknown[]).includes(value.look)) errors.push(`look must be one of ${oneOf(LOOKS)}`);
	if (value.font !== undefined && !(typeof value.font === "string" && value.font in FONT_STACKS)) errors.push(`font must be one of ${oneOf(Object.keys(FONT_STACKS))}`);
	if (value.density !== undefined && !(DENSITIES as readonly unknown[]).includes(value.density)) errors.push(`density must be ${oneOf(DENSITIES)}`);
	if (value.accent !== undefined && !(ACCENTS as readonly unknown[]).includes(value.accent)) errors.push(`accent must be one of ${oneOf(ACCENTS)}`);
	if (value.tabs !== undefined) errors.push(...tabErrors(value.tabs));
	return errors.length ? { ok: false, errors } : { ok: true, preferences: value as UiPreferences };
}

function tabErrors(tabs: unknown): string[] {
	if (!Array.isArray(tabs)) return ["tabs must be an array"];
	const errors: string[] = [];
	if (tabs.length > UI_LIMITS.maxTabs) errors.push(`tabs: at most ${UI_LIMITS.maxTabs} extra tabs are allowed, got ${tabs.length}`);
	const titles = new Set<string>();
	tabs.forEach((tab, i) => {
		const where = `tabs.${i}`;
		if (!isObject(tab)) {
			errors.push(`${where} must be an object with title and widgets`);
			return;
		}
		for (const key of Object.keys(tab)) if (!TAB_KEYS.includes(key)) errors.push(`${where}: unknown key "${key}" (allowed: ${TAB_KEYS.join(", ")})`);
		const title = tab.title;
		if (typeof title !== "string" || title.trim() === "" || title.length > UI_LIMITS.maxTitle) errors.push(`${where}.title must be 1 to ${UI_LIMITS.maxTitle} characters`);
		else if (!PLAIN_TEXT.test(title)) errors.push(`${where}.title must be plain text (no control characters, no < or >)`);
		else if (titles.has(title.trim().toLowerCase())) errors.push(`${where}.title: two tabs have the same title`);
		else titles.add(title.trim().toLowerCase());
		const widgets = tab.widgets;
		if (!Array.isArray(widgets) || widgets.length === 0 || widgets.length > UI_LIMITS.maxWidgets) {
			errors.push(`${where}.widgets must list 1 to ${UI_LIMITS.maxWidgets} widgets`);
			return;
		}
		const seen = new Set<unknown>();
		widgets.forEach((w, j) => {
			if (!(WIDGETS as readonly unknown[]).includes(w)) errors.push(`${where}.widgets.${j}: widget must be one of ${oneOf(WIDGETS)}`);
			else if (seen.has(w)) errors.push(`${where}.widgets.${j}: "${String(w)}" is listed more than once`);
			seen.add(w);
		});
	});
	return errors;
}

/** Reads the file text (null when the fork has no file, which means the defaults). */
export function parseUiPreferences(text: string | null): ({ ok: true; preferences: UiPreferences } | { ok: false; errors: string[] }) & { present: boolean } {
	if (text === null) return { ok: true, preferences: { ...DEFAULT_UI_PREFERENCES }, present: false };
	if (text.length > UI_LIMITS.maxBytes) return { ok: false, errors: [`ui/preferences.json is larger than ${UI_LIMITS.maxBytes} bytes`], present: true };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { ok: false, errors: [`ui/preferences.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`], present: true };
	}
	return { ...validateUiPreferences(parsed), present: true };
}

/** Canonical file text for preferences (stable key order, trailing newline). */
export function uiPreferencesJson(prefs: UiPreferences): string {
	const ordered: Record<string, unknown> = {};
	for (const key of TOP_KEYS) if ((prefs as Record<string, unknown>)[key] !== undefined) ordered[key] = (prefs as Record<string, unknown>)[key];
	return `${JSON.stringify(ordered, null, 2)}\n`;
}

// Fork-owned UI preferences in the browser. The platform validates
// ui/preferences.json against a strict schema (platform/src/ui/preferences.ts);
// this module only maps allowlisted keys to data attributes that styles.css
// already defines. Anything not on these lists is ignored, so no value from a
// fork ever becomes a style, a URL, or markup.

export const FONT_LABELS = {
  system: "System",
  palatino: "Palatino",
  georgia: "Georgia",
  "humanist-sans": "Humanist sans",
  mono: "Monospace",
};
export const ACCENT_KEYS = ["teal", "blue", "violet", "amber", "green", "rose", "slate"];
export const DENSITY_KEYS = ["comfortable", "compact"];
export const WIDGET_LABELS = {
  "answers-by-intent": "Answers by intent over time",
  "confidence-distribution": "Confidence distribution",
  "override-rate": "Override rate",
  "sources-by-kind": "Sources cited by kind",
  "intent-timeline": "Build-time intent timeline",
  "gate-history": "Gate results history",
};
const MAX_TABS = 4;
const MAX_WIDGETS = 6;
const MAX_TITLE = 40;

/** Keeps only allowlisted values (defense in depth: the platform already validated them). */
export function sanitizePreferences(prefs) {
  const p = prefs && typeof prefs === "object" ? prefs : {};
  const out = {};
  if (Object.hasOwn(FONT_LABELS, p.font)) out.font = p.font;
  if (DENSITY_KEYS.includes(p.density)) out.density = p.density;
  if (ACCENT_KEYS.includes(p.accent)) out.accent = p.accent;
  if (Array.isArray(p.tabs)) {
    out.tabs = p.tabs.slice(0, MAX_TABS)
      .filter((t) => t && typeof t.title === "string" && t.title.trim() && Array.isArray(t.widgets))
      .map((t) => ({ title: t.title.slice(0, MAX_TITLE), widgets: t.widgets.filter((w) => Object.hasOwn(WIDGET_LABELS, w)).slice(0, MAX_WIDGETS) }))
      .filter((t) => t.widgets.length > 0);
  }
  return out;
}

/** Sets or clears the font, density, and accent attributes on the root element. */
export function applyUiPreferences(root, prefs) {
  const p = sanitizePreferences(prefs);
  const set = (name, value) => {
    if (value) root.setAttribute(name, value);
    else root.removeAttribute(name);
  };
  set("data-font", p.font);
  set("data-density", p.density === "compact" ? "compact" : null);
  set("data-accent", p.accent);
  return p;
}

/** A one-line description of the active preferences, for the rail and screen readers. */
export function describePreferences(prefs) {
  const p = sanitizePreferences(prefs);
  const parts = [];
  if (p.font) parts.push(`${FONT_LABELS[p.font]} font`);
  if (p.density) parts.push(`${p.density} density`);
  if (p.accent) parts.push(`${p.accent} accent`);
  if (p.tabs?.length) parts.push(`${p.tabs.length} extra tab${p.tabs.length === 1 ? "" : "s"}`);
  return parts.join(", ");
}

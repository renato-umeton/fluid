// Fork-owned UI preferences in the browser. The platform validates
// ui/preferences.json against a strict schema (platform/src/ui/preferences.ts);
// this module only maps allowlisted keys to data attributes that styles.css
// already defines. Anything not on these lists is ignored, so no value from a
// fork ever becomes a style, a URL, or markup.

/** Whole looks; "standard" is the stock look and sets no attribute. */
export const LOOK_LABELS = {
  standard: "Standard",
  crimson: "Crimson",
  "luna-xp": "Luna XP",
};
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
export const MAX_TABS = 4;
export const MAX_WIDGETS = 6;
export const MAX_TITLE = 40;

/** Keeps only allowlisted values (defense in depth: the platform already validated them). */
export function sanitizePreferences(prefs) {
  const p = prefs && typeof prefs === "object" ? prefs : {};
  const out = {};
  if (typeof p.look === "string" && Object.hasOwn(LOOK_LABELS, p.look)) out.look = p.look;
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

/**
 * Sets or clears the look, font, density, and accent attributes on the root
 * element. styles.css puts the look rules first, so an explicit font,
 * density, or accent wins over the look's own defaults.
 */
export function applyUiPreferences(root, prefs) {
  const p = sanitizePreferences(prefs);
  const set = (name, value) => {
    if (value) root.setAttribute(name, value);
    else root.removeAttribute(name);
  };
  set("data-look", p.look === "standard" ? null : p.look);
  set("data-font", p.font);
  set("data-density", p.density === "compact" ? "compact" : null);
  set("data-accent", p.accent);
  return p;
}

/** A one-line description of the active preferences, for the rail and screen readers. */
export function describePreferences(prefs) {
  const p = sanitizePreferences(prefs);
  const parts = [];
  if (p.look && p.look !== "standard") parts.push(`${LOOK_LABELS[p.look]} look`);
  if (p.font) parts.push(`${FONT_LABELS[p.font]} font`);
  if (p.density) parts.push(`${p.density} density`);
  if (p.accent) parts.push(`${p.accent} accent`);
  if (p.tabs?.length) parts.push(`${p.tabs.length} extra tab${p.tabs.length === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/**
 * What a merged customization changed, from the preferences before and after
 * it: short lines for the success message, and the tabs it added (with their
 * index in the rail) so the UI can open the new tab.
 */
export function uiChanges(before, after) {
  const a = sanitizePreferences(before);
  const b = sanitizePreferences(after);
  const lines = [];
  if ((a.look ?? "standard") !== (b.look ?? "standard")) lines.push(`${LOOK_LABELS[b.look ?? "standard"]} look`);
  if (a.font !== b.font) lines.push(b.font ? `${FONT_LABELS[b.font]} font` : "default font");
  if (a.density !== b.density) lines.push(`${b.density ?? "default"} density`);
  if (a.accent !== b.accent) lines.push(b.accent ? `${b.accent} accent` : "default accent");
  const known = new Set((a.tabs ?? []).map((t) => t.title.trim().toLowerCase()));
  const newTabs = [];
  (b.tabs ?? []).forEach((t, index) => {
    if (!known.has(t.title.trim().toLowerCase())) newTabs.push({ title: t.title, index });
  });
  for (const t of newTabs) lines.push(`new tab "${t.title}"`);
  return { lines, newTabs };
}

/**
 * Where a merged UI change stands, for the Customize success line: live in
 * yellow until the soak passes, applied once green, or rolled back or failed.
 * `open` says whether "Open <tab>" buttons make sense.
 */
export function mergeOutcome(run, changes) {
  const what = changes.lines.join(", ");
  const health = run?.yellow?.health;
  if (health === "rolled_back") {
    return { state: "rolled_back", open: false, text: `Rolled back: the change failed the yellow soak, so main went back to the last green commit${what ? ` and these are no longer applied: ${what}` : ""}.` };
  }
  if (health === "green" || (run?.status === "passed" && !run?.yellow?.runId)) {
    return { state: "applied", open: true, text: what ? `Applied: ${what}.` : "Applied. Your look and tabs were already like this." };
  }
  if (run?.status === "failed") {
    return { state: "failed", open: false, text: "The yellow soak failed after the merge and main was not rolled back automatically. See the Yellow phase panel." };
  }
  return { state: "yellow", open: true, text: `Merged to main, live in yellow${what ? `: ${what}` : ""}. It counts as applied once the end-to-end suite passes 3 times.` };
}

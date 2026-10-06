// Mock mode's copy of the platform's recipe matching and UI request mapping
// (platform/src/agents/recipes.ts and ui-recipe.ts), so the same request
// works with ?mock=1. It is a copy because the platform is a Worker built
// from TypeScript and this file is served to the browser as is. Keep the
// rules in step: platform/test/ui-recipe.test.ts checks that every rule
// table is identical, pattern for pattern, and that both map, route, and
// merge the same requests the same way.
import { FONT_LABELS, LOOK_LABELS, MAX_TABS, MAX_TITLE, WIDGET_LABELS, sanitizePreferences } from "./ui-prefs.js";

const LOOK_NOTES = {
  standard: "the standard Fluid look",
  crimson: "bold red and white institutional colors; no logos, names, or trademarks",
  "luna-xp": "a Windows XP style from about 2001: blue title bars, a blue rail, bevelled buttons with a green primary, Tahoma-style web-safe fonts",
};
const LOOK_RULES = [
  ["crimson", /\b(?:st\.?\s*|saint\s+)jude\b|\bcrimson\b/i],
  ["luna-xp", /\bwindows\s*xp\b|\bxp\b|\b2001\b|\bluna\b|\by2k\b|\bretro\b|\bearly\s*2000s\b/i],
  ["standard", /\b(?:default|standard|original|stock|normal|plain)\s+(?:look|theme|style|skin|ui|design|appearance)\b(?!\s+guides?\b)|\breset\s+(?:the\s+|my\s+)?(?:look|theme|style|skin|ui|design|appearance)\b(?!\s+guides?\b)/i],
];
const LOOK_ALONE = /\bwindows\s*xp\b/i;
const LOOK_CONTEXT = /\b(looks?(\s+and\s+feel)?|feel|themes?|styles?|skins?|ui|design|appearance|colou?rs?|palette|branding|brand\s+colou?rs?)\b/i;
const LOOK_CONTENT = /\b(answers?(?!\s+(?:views?|pages?|tabs?|screens?|panels?)\b)|cards?|citations?|cite[sd]?|protocols?|patients?|guidelines?|scores?|dos(e|es|ing)|enrol(l)?(s|ed|ment|ing)?|connectors?|ledger)\b/i;
const FONT_RULES = [
  ["palatino", /\b(palatino|palatine|book\s*antiqua|lino\s*type|linotype)\b/i],
  ["georgia", /\b(georgia|times(\s+new\s+roman)?)\b/i],
  ["humanist-sans", /\b(humanist|optima|candara|gill\s*sans|frutiger|sans[-\s]?serif|sans)\b/i],
  ["mono", /\b(mono|monospaced?|typewriter|courier)\b/i],
  ["system", /\b(system|native|platform)\s+(fonts?|typefaces?|type)\b/i],
  ["georgia", /\bserif\b/i],
];
const DENSITY_RULES = [
  ["compact", /\b(compact|dense|denser|tighter|condensed|less\s+(white\s*space|whitespace|padding|spacing))\b/i],
  ["comfortable", /\b(comfortable|spacious|roomy|airy|relaxed|more\s+(white\s*space|whitespace|padding|spacing))\b/i],
];
const ACCENT_RULES = [
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
const ANSWER_TARGET = /\b(?:to|in|into|inside)\s+(?:the\s+|my\s+|all\s+|every\s+)?(?:(?:clinical|research|administrative)\s+)?(?:answers?|answer\s+cards?|cards?)\b/i;
const WIDGET_RULES = [
  ["answers-by-intent", /\b(intents?|answers?|questions?|ledger|modes?)\b/i],
  ["confidence-distribution", /\bconfidence\b/i],
  ["override-rate", /\boverrid(e|es|den|ing)\b/i],
  ["sources-by-kind", /\b(sources?|citations?|cited|references?)\b/i],
  ["intent-timeline", /\b(timeline|customi[sz]ations?|changes|build[-\s]?time)\b/i],
  ["gate-history", /\b(gates?|tests?|pass(es|ed)?|tiers?)\b/i],
];
const WIDGETS = Object.keys(WIDGET_LABELS);
const QUOTED_TITLE = /\b(?:called|named|titled)\s+["“']([^"”'\n]{1,60})["”']/i;
const BARE_TITLE = /\b(?:called|named|titled)\s+([A-Za-z0-9][A-Za-z0-9 _-]{0,59}?)(?=\s+(?:with|that|showing|for|of)\b|[,.;]|$)/i;
const LEAD = /^(?:please\s+)?(?:(?:always|also|just)\s+)?(?:use|make|set|switch\s+to|change\s+to|add|give\s+me|show|i\s+want|i'd\s+like)\s+(?:the\s+)?/i;
const CLAUSE_BREAK = /\s*(?:[,;]|(?<!\b(?:st|dr|mr|mrs|ms|vs))\.|\band\b(?!\s+feel\b)|\bthen\b|\bplus\b)\s*/i;

export const UI_RULES = { LOOK_RULES, LOOK_ALONE, LOOK_CONTEXT, LOOK_CONTENT, FONT_RULES, DENSITY_RULES, ACCENT_RULES, COLOR_CONTEXT, TAB_WORD, CHART_WORD, ANSWER_TARGET, WIDGET_RULES, QUOTED_TITLE, BARE_TITLE, LEAD, CLAUSE_BREAK };
const TAU_WORDS = /\b(tau|τ|threshold|confidence)\b|τ/i;

function clauses(request) {
  return request.split(CLAUSE_BREAK).map((c) => c.trim()).filter(Boolean);
}

function phraseFor(request, pattern) {
  const clause = clauses(request).find((c) => pattern.test(c)) ?? request;
  return clause.replace(LEAD, "").trim();
}

function firstMatch(rules, text) {
  for (const [value, pattern] of rules) if (pattern.test(text)) return { value, pattern };
  return null;
}

/** The look a request names: look words and no answer content in the same clause ("Windows XP" needs no look word). */
function lookMatch(text) {
  const lookClause = (c) => LOOK_CONTEXT.test(c) && !LOOK_CONTENT.test(c);
  for (const [value, pattern] of LOOK_RULES) {
    if (!pattern.test(text)) continue;
    const named = clauses(text).filter((c) => pattern.test(c));
    if ((named.length ? named : [text]).some(lookClause)) return { value, pattern };
  }
  const xp = clauses(text).filter((c) => LOOK_ALONE.test(c));
  return xp.some((c) => lookClause(c) || !LOOK_CONTENT.test(c)) ? { value: "luna-xp", pattern: LOOK_ALONE } : null;
}

/** True when a clause is about answer content; such a request goes to the model whole (see the platform copy). */
export function hasCodeContent(request) {
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
export function mappedLines(notes) {
  const byPhrase = new Map();
  for (const n of notes) byPhrase.set(n.phrase, [...(byPhrase.get(n.phrase) ?? []), n.mapped]);
  return [...byPhrase].map(([phrase, mapped]) => `"${phrase}" -> ${mapped.join("; ")}`);
}

function tabTitle(request) {
  const m = QUOTED_TITLE.exec(request) ?? BARE_TITLE.exec(request);
  const title = m?.[1]?.replace(/[\u0000-\u001f\u007f-\u009f<>]/g, "").trim();
  return title ? title.slice(0, MAX_TITLE) : null;
}

/** Maps a request to UI preferences ({ look, font, density, accent, tab, notes }), or null when it names nothing allowed. */
export function parseUiRequest(request) {
  const text = String(request ?? "");
  const out = { notes: [] };
  const found = [];
  const note = (pattern, mapped) => found.push({ at: text.search(pattern), note: { phrase: phraseFor(text, pattern), mapped } });

  const look = lookMatch(text);
  if (look) {
    out.look = look.value;
    note(look.pattern, `look "${look.value}" (${LOOK_LABELS[look.value]}): ${LOOK_NOTES[look.value]}`);
  }
  const font = firstMatch(FONT_RULES, text);
  if (font) {
    out.font = font.value;
    note(font.pattern, `font "${font.value}" (${FONT_LABELS[font.value]})`);
  }
  const density = firstMatch(DENSITY_RULES, text);
  if (density) {
    out.density = density.value;
    note(density.pattern, `density "${density.value}"`);
  }
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
    const named = WIDGETS.filter((w) => WIDGET_RULES.find(([k]) => k === w)[1].test(tail));
    const widgets = named.length ? named : [...WIDGETS];
    const title = tabTitle(text) ?? (dashboard ? "Dashboard" : "Charts");
    out.tab = { title, widgets };
    const shown = named.length ? widgets.map((w) => WIDGET_LABELS[w]).join("; ") : `the default set (${widgets.map((w) => WIDGET_LABELS[w]).join("; ")})`;
    const word = (TAB_WORD.exec(text)?.[1] ?? "").toLowerCase();
    const asTab = word && !word.startsWith("tab") ? ` (your "${word}" becomes an extra tab in the rail)` : "";
    note(tabAt >= 0 ? TAB_WORD : CHART_WORD, `tab "${title}"${asTab} with ${widgets.length} chart${widgets.length === 1 ? "" : "s"}: ${shown}`);
  }
  if (found.length === 0) return null;
  out.notes = found.sort((a, b) => a.at - b.at).map((f) => f.note);
  return out;
}

/**
 * The ui recipe's merge (uiChange in the platform): the current preferences
 * with the request applied. Returns { ok: true, prefs } or { ok: false, error }.
 */
export function mergeUiRequest(current, mapping) {
  if (!mapping) return { ok: false, error: "the request names no look, font, density, accent color, or chart tab that UI preferences support" };
  const base = sanitizePreferences(current ?? {});
  const next = { ...base };
  // "standard" is the same as no look, so a fork without a look keeps its file as it is.
  if (mapping.look && !(mapping.look === "standard" && !base.look)) next.look = mapping.look;
  for (const key of ["font", "density", "accent"]) if (mapping[key]) next[key] = mapping[key];
  if (mapping.tab) {
    const tabs = [...(base.tabs ?? [])];
    const same = tabs.findIndex((t) => t.title.trim().toLowerCase() === mapping.tab.title.toLowerCase());
    if (same >= 0) tabs[same] = mapping.tab;
    else if (tabs.length >= MAX_TABS) return { ok: false, error: `ui/preferences.json already has ${MAX_TABS} extra tabs (${tabs.map((t) => t.title).join(", ")}); remove one or reuse a tab title` };
    else tabs.push(mapping.tab);
    next.tabs = tabs;
  }
  const prefs = sanitizePreferences(next);
  if (JSON.stringify(prefs) === JSON.stringify(base)) return { ok: false, error: "your fork already has these UI preferences; nothing to change" };
  return { ok: true, prefs };
}

/** Which recipe a request matches, in the platform's order: REDCap, tau, then UI preferences. */
export function matchRecipe(request) {
  const text = request.toLowerCase();
  if (/\bred\s?cap\b/.test(text)) return { kind: "redcap" };
  if (TAU_WORDS.test(request)) {
    const number = /(?:^|[^\d.])((?:0?\.\d+)|(?:1(?:\.0+)?)|(?:0))(?![\d.])/.exec(request);
    const direction = /\b(lower|reduce|decrease|drop|loosen)\b/.test(text) ? "lower" : /\b(raise|increase|tighten|bump|higher)\b/.test(text) ? "raise" : "set";
    if (number) return { kind: "tau", value: Number(number[1]), direction };
    if (direction === "raise") return { kind: "tau", value: Number.NaN, direction };
    if (direction === "lower") return { kind: "tau", value: Number.NaN, direction };
  }
  // Look and layout is a declarative UI preference, unless the request also changes answer content.
  if (parseUiRequest(request) && !hasCodeContent(request)) return { kind: "ui" };
  return null;
}

/** The value a tau recipe writes, given the fork's current tau. */
export function tauTarget(recipe, currentTau) {
  const round2 = (n) => Math.round(n * 100) / 100;
  if (Number.isFinite(recipe.value)) return round2(recipe.value);
  if (recipe.direction === "raise") return round2(Math.min(1, currentTau + 0.05));
  return round2(Math.max(0, currentTau - 0.15));
}

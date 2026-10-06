// Fluid UI entry: session, persona switching, routing between views.
import { api, initApi, state as apiState } from "./js/api.js";
import { h, s, mount, short } from "./js/dom.js";
import * as workspace from "./js/views/workspace.js";
import * as forkView from "./js/views/fork.js";
import * as customize from "./js/views/customize.js";
import * as contest from "./js/views/contest.js";
import * as fleet from "./js/views/fleet.js";
import * as harvest from "./js/views/harvest.js";
import * as about from "./js/views/about.js";
import * as tab from "./js/views/tab.js";
import { applyUiPreferences, describePreferences } from "./js/ui-prefs.js";
import { healthBadge } from "./js/health.js";
import { explainStartFailure, mockDemoHref } from "./js/start-failure.js";

const VIEWS = { workspace, fork: forkView, customize, contest, fleet, harvest, about, tab };
const STOCK_MIN_TAU = 0.85;
const PERSONA_KEY = "fluid.persona";
const HEALTH_POLL_MS = 3000;
let healthTimer = null;

const app = {
  personas: [],
  persona: null,
  userId: null,
  fork: null,
  /** The active fork's validated UI preferences (font, density, accent, extra tabs). */
  ui: {},
  view: null,
  /** Set when the live platform refused a session or fork: every view shows why, with a link to mock mode. */
  blocked: null,
  get mock() { return apiState.mock; },
  stockMinTau: STOCK_MIN_TAU,
  effectiveTau() {
    const configured = typeof this.fork?.tau === "number" ? this.fork.tau : NaN;
    const min = Number(this.fork?.stockMinTau) || STOCK_MIN_TAU;
    return Number.isFinite(configured) ? Math.min(1, Math.max(min, configured)) : min;
  },
  async refreshFork() {
    if (!this.fork) return null;
    this.fork = await api.fork(this.fork.repo);
    renderForkPill();
    await loadUi();
    return this.fork;
  },
  go(view, params = "") {
    const hash = `#${view}${params ? `?${params}` : ""}`;
    if (location.hash === hash) route();
    else location.hash = hash;
  },
};

async function boot() {
  setupTheme();
  try {
    await initApi();
    mount(document.getElementById("mode-flag"), h("span", { class: "mock-flag", title: apiState.mock ? "Data served in the browser; no platform backend" : "Connected to the platform API" }, apiState.mock ? "Mock mode" : "Live platform"));
    app.personas = await api.personas();
    renderPersonas();
    let saved = null;
    try { saved = localStorage.getItem(PERSONA_KEY); } catch { /* storage unavailable */ }
    const first = app.personas.find((p) => p.id === saved) ?? app.personas[0];
    if (!first) throw new Error("GET /api/personas returned no personas");
    await switchPersona(first.id);
  } catch (err) {
    blockStart(err);
  }
  document.getElementById("nav-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view]");
    if (btn) app.go(btn.dataset.view);
  });
  document.getElementById("fork-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tab]");
    if (btn) app.go("tab", `i=${btn.dataset.tab}`);
  });
  window.addEventListener("hashchange", route);
  route();
}

function renderPersonas() {
  mount(document.getElementById("persona-list"), app.personas.map((p) => h("li", {},
    h("button", { type: "button", class: "persona-btn", "aria-pressed": "false", dataset: { persona: p.id }, onclick: () => switchPersona(p.id).catch((err) => { blockStart(err); route(); }) },
      h("span", { class: "avatar", dataset: { p: p.id }, "aria-hidden": "true" }, initials(p.displayName)),
      h("span", { class: "persona-text" },
        h("span", { class: "persona-name" }, p.displayName.replace(/\s*\(fictional\)/, "")),
        h("span", { class: "persona-repo" }, p.forkRepo))))));
}

function initials(name) {
  return name.replace(/^Dr\.\s*/, "").replace(/\(.*\)/, "").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("");
}

async function switchPersona(id) {
  const session = await api.session(id);
  app.userId = session.userId;
  app.persona = app.personas.find((p) => p.id === id);
  try { localStorage.setItem(PERSONA_KEY, id); } catch { /* storage unavailable */ }
  const me = await api.me();
  app.fork = me.fork ?? (await api.createFork());
  document.querySelectorAll(".persona-btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.persona === id)));
  app.blocked = null;
  renderForkPill();
  await loadUi();
  if (app.view) route();
}

/**
 * The live platform refused a session or a fork (fork cap, hourly limits, or
 * any provisioning error). Instead of an empty screen, every view says why and
 * offers the same demo in mock mode, keeping the current view. There is no
 * automatic switch to mock mode, so nobody mistakes mock data for the live platform.
 */
function blockStart(err) {
  console.error(err);
  app.blocked = explainStartFailure(err);
  if (app.view) VIEWS[app.view].leave?.();
  clearTimeout(healthTimer);
  document.getElementById("fork-pill").replaceChildren();
}

function renderBlocked(el) {
  const b = app.blocked;
  const mockLink = h("a", { class: "btn btn-primary", href: mockDemoHref(location) }, "Explore the full demo in mock mode");
  mount(el, h("div", { class: "start-refusal", role: "alert" },
    h("h2", {}, b.title),
    h("p", {}, b.message),
    apiState.mock ? null : h("p", {}, b.mockNote),
    h("div", { class: "start-refusal-actions" },
      apiState.mock ? null : mockLink,
      b.retry || apiState.mock ? h("button", { type: "button", class: "btn", onclick: () => location.reload() }, "Try again") : null)));
}

/**
 * Reads the active fork's ui/preferences.json (validated by the platform) and
 * applies it: font, density, and accent as root attributes styles.css maps,
 * and extra tabs in the rail. Nothing from the fork runs here.
 */
async function loadUi() {
  let prefs = {};
  try {
    prefs = (await api.forkUi(app.fork.repo))?.preferences ?? {};
  } catch (err) {
    console.warn(`Fluid: UI preferences unavailable (${err.message}); using the defaults.`);
  }
  app.ui = applyUiPreferences(document.documentElement, prefs);
  const tabs = app.ui.tabs ?? [];
  document.getElementById("fork-tabs-group").hidden = tabs.length === 0 && !describePreferences(app.ui);
  mount(document.getElementById("fork-tabs"), tabs.map((t, i) => h("li", {},
    h("button", { class: "nav-btn", type: "button", dataset: { view: "tab", tab: String(i) } }, chartIcon(), t.title))));
  mount(document.getElementById("rail-prefs"), describePreferences(app.ui) ? `From ui/preferences.json: ${describePreferences(app.ui)}` : "");
  if (app.view === "tab") route();
  else markCurrent();
}

function chartIcon() {
  return s("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" },
    s("path", { d: "M2 14h12M4 12V8M8 12V4M12 12V6", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round" }));
}

function markCurrent() {
  const [name, query = ""] = location.hash.replace(/^#/, "").split("?");
  const i = new URLSearchParams(query).get("i") ?? "0";
  document.querySelectorAll(".nav-btn").forEach((b) => {
    const current = b.dataset.view === app.view && (app.view !== "tab" || (name === "tab" && b.dataset.tab === i));
    if (current) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
}

function renderForkPill() {
  const f = app.fork;
  if (!f) return;
  mount(document.getElementById("fork-pill"),
    healthBadge(f.health, { onclick: () => app.go("fork") }),
    h("span", {}, "Fork ", h("strong", {}, f.repo)),
    h("span", {}, "on upstream ", h("strong", {}, f.stockTag)),
    h("span", {}, "τ ", h("strong", {}, app.effectiveTau().toFixed(2))),
    f.head ? h("span", { class: "hide-sm" }, "at ", h("strong", {}, short(f.head))) : null);
  watchHealth();
}

/** While the fork is yellow, refresh its health so the badge follows the soak to green or a rollback. */
function watchHealth() {
  clearTimeout(healthTimer);
  if (app.fork?.health?.health !== "yellow") return;
  const repo = app.fork.repo;
  healthTimer = setTimeout(async () => {
    try {
      const { health } = await api.health(repo);
      if (app.fork?.repo !== repo) return;
      const changed = JSON.stringify(health) !== JSON.stringify(app.fork.health);
      app.fork = { ...app.fork, health };
      if (changed && health.health !== "yellow") {
        await app.refreshFork().catch(() => renderForkPill());
        return;
      }
      renderForkPill();
    } catch (err) {
      console.warn(`Fluid: health refresh failed (${err.message})`);
      healthTimer = setTimeout(watchHealth, HEALTH_POLL_MS * 3);
    }
  }, HEALTH_POLL_MS);
}

function route() {
  const [name, query = ""] = location.hash.replace(/^#/, "").split("?");
  const key = VIEWS[name] ? name : "workspace";
  const params = new URLSearchParams(query);
  if (app.view && app.view !== key) VIEWS[app.view].leave?.();
  app.view = key;
  for (const k of Object.keys(VIEWS)) document.getElementById(`view-${k}`).hidden = k !== key;
  markCurrent();
  const view = VIEWS[key];
  if (app.blocked) {
    document.getElementById("view-title").textContent = "Fluid could not start on the live platform";
    document.getElementById("view-sub").textContent = "";
    document.title = "Fluid";
    renderBlocked(document.getElementById(`view-${key}`));
    return;
  }
  const title = typeof view.title === "function" ? view.title(app, params) : view.title;
  document.getElementById("view-title").textContent = title;
  document.getElementById("view-sub").textContent = typeof view.sub === "function" ? view.sub(app) : view.sub;
  document.title = `${title} | Fluid`;
  Promise.resolve(view.render(document.getElementById(`view-${key}`), app, params)).catch((err) => {
    console.error(err);
    mount(document.getElementById(`view-${key}`), h("div", { class: "card-error", role: "alert" }, err.message));
  });
}

function setupTheme() {
  const btn = document.getElementById("theme-toggle");
  const order = ["system", "light", "dark"];
  let theme = "system";
  try { theme = localStorage.getItem("fluid.theme") || "system"; } catch { /* storage unavailable */ }
  const apply = () => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = theme;
    btn.textContent = `Theme: ${theme}`;
  };
  btn.addEventListener("click", () => {
    theme = order[(order.indexOf(theme) + 1) % order.length];
    try { localStorage.setItem("fluid.theme", theme); } catch { /* storage unavailable */ }
    apply();
  });
  apply();
}

boot();

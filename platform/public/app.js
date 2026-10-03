// Fluid UI entry: session, persona switching, routing between views.
import { api, initApi, state as apiState } from "./js/api.js";
import { h, mount, short } from "./js/dom.js";
import * as workspace from "./js/views/workspace.js";
import * as forkView from "./js/views/fork.js";
import * as customize from "./js/views/customize.js";
import * as fleet from "./js/views/fleet.js";
import * as harvest from "./js/views/harvest.js";
import * as about from "./js/views/about.js";

const VIEWS = { workspace, fork: forkView, customize, fleet, harvest, about };
const STOCK_MIN_TAU = 0.85;
const PERSONA_KEY = "fluid.persona";

const app = {
  personas: [],
  persona: null,
  userId: null,
  fork: null,
  view: null,
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
    console.error(err);
    mount(document.getElementById("view-workspace"), h("div", { class: "card-error", role: "alert" }, `Fluid could not start: ${err.message}. Reload, or add ?mock=1 to the address to run without the platform.`));
    return;
  }
  document.getElementById("nav-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view]");
    if (btn) app.go(btn.dataset.view);
  });
  window.addEventListener("hashchange", route);
  route();
}

function renderPersonas() {
  mount(document.getElementById("persona-list"), app.personas.map((p) => h("li", {},
    h("button", { type: "button", class: "persona-btn", "aria-pressed": "false", dataset: { persona: p.id }, onclick: () => switchPersona(p.id) },
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
  renderForkPill();
  if (app.view) route();
}

function renderForkPill() {
  const f = app.fork;
  if (!f) return;
  mount(document.getElementById("fork-pill"),
    h("span", { class: "dot", "aria-hidden": "true" }),
    h("span", {}, "Fork ", h("strong", {}, f.repo)),
    h("span", {}, "on stock ", h("strong", {}, f.stockTag)),
    h("span", {}, "τ ", h("strong", {}, app.effectiveTau().toFixed(2))),
    f.head ? h("span", { class: "hide-sm" }, "at ", h("strong", {}, short(f.head))) : null);
}

function route() {
  const [name, query = ""] = location.hash.replace(/^#/, "").split("?");
  const key = VIEWS[name] ? name : "workspace";
  const params = new URLSearchParams(query);
  if (app.view && app.view !== key) VIEWS[app.view].leave?.();
  app.view = key;
  for (const k of Object.keys(VIEWS)) document.getElementById(`view-${k}`).hidden = k !== key;
  document.querySelectorAll(".nav-btn").forEach((b) => {
    if (b.dataset.view === key) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  const view = VIEWS[key];
  document.getElementById("view-title").textContent = view.title;
  document.getElementById("view-sub").textContent = typeof view.sub === "function" ? view.sub(app) : view.sub;
  document.title = `${view.title} | Fluid`;
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

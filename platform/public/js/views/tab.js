// A fork-owned tab from ui/preferences.json: charts the platform computes over
// the user's own ledger, build-time intents, and gate history.
import { api } from "../api.js";
import { h, mount } from "../dom.js";
import { renderWidget } from "../charts.js";

export function title(app, params) {
  return currentTab(app, params)?.title ?? "Tab";
}
export const sub = "A tab your fork added through ui/preferences.json. Charts are computed by the platform over your own data; no fork code runs in the browser.";

function currentTab(app, params) {
  const i = Number(params?.get("i") ?? 0);
  return app.ui?.tabs?.[Number.isInteger(i) ? i : 0] ?? null;
}

export async function render(root, app, params) {
  const tab = currentTab(app, params);
  if (!tab) {
    mount(root, h("p", { class: "empty" }, "This tab is not in your fork's ui/preferences.json any more."));
    return;
  }
  mount(root, h("p", { class: "muted" }, "Loading charts..."));
  const data = await api.charts();
  mount(root, h("div", { class: "tab-grid" }, tab.widgets.map((w) => renderWidget(w, data))));
}

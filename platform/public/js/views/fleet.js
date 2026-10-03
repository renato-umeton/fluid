// Fleet: tag a stock release and watch every fork upgrade, gate, pass, or open a repair.
import { api, adminKey, setAdminKey } from "../api.js";
import { h, mount, fmtTime, statusTag } from "../dom.js";
import { renderTimeline, renderDiff, renderGate, renderIntent } from "./shared.js";

export const title = "Fleet";
export const sub = "The mothership view. A stock release fans out one upgrade run per fork; each fork moves only when all three test tiers pass on the new stock.";

const STATUSES = [
  ["pinned", "Pinned"],
  ["upgrading", "Upgrading"],
  ["gating", "Gating"],
  ["passed", "Passed"],
  ["failed", "Failed"],
  ["repair_open", "Repair open"],
];
const ATTENTION = new Set(["failed", "repair_open"]);

let current = null;
let unsubscribe = null;
const model = { forks: new Map(), stockTags: [], filter: null, selected: null, log: [], streamState: "connecting" };
const cells = new Map();

function normStatus(s) {
  return String(s || "pinned").replace(/[\s-]+/g, "_").toLowerCase();
}

export async function render(root, app) {
  leave();
  current = { root, app };
  mount(root, h("p", { class: "muted" }, "Loading the fleet..."));
  const data = await api.fleet();
  model.stockTags = data.stockTags || [];
  model.forks = new Map((data.forks || []).map((f) => [f.repo, { ...f, status: normStatus(f.status) }]));
  layout();
  unsubscribe = api.fleetStream(onEvent, (s) => { model.streamState = s; paintStream(); });
}

export function leave() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}

function layout() {
  const { root, app } = current;
  const next = nextTag(model.stockTags);
  const tag = h("input", { type: "text", id: "rel-tag", value: next, required: true, pattern: "v\\d+\\.\\d+\\.\\d+" });
  const notes = h("textarea", { id: "rel-notes", rows: 3 }, "Research answers always show a discrepancy summary. Order entry becomes a hard clinical floor that screen labels cannot outweigh.");
  const safety = h("input", { type: "checkbox", id: "rel-safety", checked: true });
  const key = app.mock ? null : h("input", { type: "password", id: "rel-key", value: adminKey(), autocomplete: "off", onchange: (e) => setAdminKey(e.target.value) });
  const relMsg = h("p", { class: "small", role: "status", id: "rel-msg" });
  const form = h("form", { class: "release-form", onsubmit: async (e) => {
    e.preventDefault();
    relMsg.textContent = "Tagging...";
    try {
      const res = await api.release(tag.value.trim(), notes.value.trim(), safety.checked);
      relMsg.textContent = `Tagged ${res.tag}. ${res.upgradeRuns} upgrade runs started.`;
      if (!model.stockTags.includes(res.tag)) model.stockTags.push(res.tag);
      tag.value = nextTag(model.stockTags);
      paintTags();
    } catch (err) {
      relMsg.textContent = err.message;
    }
  } },
    h("label", { class: "field" }, "Tag", tag),
    h("label", { class: "field" }, "Release notes", notes),
    h("label", { class: "toggle-row" }, h("span", {}, "Safety release", h("span", { class: "xsmall muted", style: { display: "block" } }, "Tightens an invariant. Forks that fail run the affected capability in stock mode after a grace period.")), safety),
    key ? h("label", { class: "field" }, "Admin secret (sent as x-fluid-admin)", key) : null,
    h("button", { class: "btn btn-primary", type: "submit" }, "Tag release and upgrade the fleet"),
    relMsg);

  mount(root, h("div", { class: "fleet" },
    h("div", { class: "stack" },
      h("section", { class: "panel" },
        h("div", { class: "panel-head" },
          h("div", {}, h("h2", { id: "fleet-heading" }, "Forks"), h("p", { id: "fleet-tags" })),
          h("span", { class: "small muted", id: "stream-state" })),
        h("div", { class: "panel-body stack" },
          h("div", { class: "counts", id: "counts", role: "group", "aria-label": "Filter forks by status" }),
          h("div", { class: "progress", id: "progress", "aria-hidden": "true" }),
          h("div", { class: "grid-cells", id: "grid", role: "group", "aria-labelledby": "fleet-heading" }),
          h("p", { class: "xsmall muted" }, "Each square is one user's fork. Select a square, or use the list of forks that need attention."))),
      h("section", { class: "panel" },
        h("div", { class: "panel-head" }, h("h2", {}, "Fork detail")),
        h("div", { class: "panel-body", id: "drill" }, h("p", { class: "empty" }, "Select a fork to see its upgrade, gate, and any repair branch.")))),
    h("div", { class: "stack" },
      h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", {}, "Release")), h("div", { class: "panel-body" }, form)),
      h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", {}, "Needs attention")), h("div", { class: "panel-body" }, h("ul", { class: "attention", id: "attention" }))),
      h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", {}, "Event stream")), h("div", { class: "panel-body" }, h("ul", { class: "event-log", id: "event-log", "aria-live": "off" }))),
      app.mock ? null : seedPanel())));
  buildGrid();
  paintAll();
}

function seedPanel() {
  const count = h("input", { type: "text", value: "300", inputmode: "numeric", "aria-label": "Number of forks to seed" });
  const msg = h("p", { class: "small", role: "status" });
  return h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", {}, "Seed demo fleet")),
    h("div", { class: "panel-body stack" }, h("div", { class: "row" }, count,
      h("button", { type: "button", class: "btn", onclick: async () => {
        try { const r = await api.seedFleet(Number(count.value)); msg.textContent = `Created ${r.created} forks.`; render(current.root, current.app); } catch (err) { msg.textContent = err.message; }
      } }, "Seed")), msg));
}

function nextTag(tags) {
  const last = [...tags].sort(cmpTag).pop() || "v1.0.0";
  const [maj, min] = last.slice(1).split(".").map(Number);
  return `v${maj}.${min + 1}.0`;
}
function cmpTag(a, b) {
  const pa = a.slice(1).split(".").map(Number);
  const pb = b.slice(1).split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function buildGrid() {
  const grid = current.root.querySelector("#grid");
  cells.clear();
  const frag = document.createDocumentFragment();
  for (const f of model.forks.values()) {
    const cell = h("button", { type: "button", class: "cell", tabindex: "-1", "aria-pressed": "false", onclick: () => select(f.repo) });
    cells.set(f.repo, cell);
    paintCell(f);
    frag.append(cell);
  }
  grid.replaceChildren(frag);
}

function paintCell(f) {
  const cell = cells.get(f.repo);
  if (!cell) return;
  cell.className = `cell s-${f.status}${model.filter && model.filter !== f.status ? " dim" : ""}`;
  cell.title = `${f.repo}: ${f.status.replace("_", " ")}, pinned to ${f.pinnedTag}`;
  cell.setAttribute("aria-label", cell.title);
  cell.setAttribute("aria-pressed", String(model.selected === f.repo));
}

function paintAll() {
  paintTags();
  paintCounts();
  paintAttention();
  paintLog();
  paintStream();
}

function paintTags() {
  const el = current?.root.querySelector("#fleet-tags");
  if (el) el.textContent = `${model.forks.size} forks. Stock tags: ${[...model.stockTags].sort(cmpTag).join(", ")}.`;
}

function paintStream() {
  const el = current?.root.querySelector("#stream-state");
  if (el) el.textContent = `Live stream: ${model.streamState}`;
}

function counts() {
  const c = Object.fromEntries(STATUSES.map(([k]) => [k, 0]));
  for (const f of model.forks.values()) c[f.status] = (c[f.status] || 0) + 1;
  return c;
}

function paintCounts() {
  const c = counts();
  const total = model.forks.size || 1;
  mount(current.root.querySelector("#counts"), STATUSES.map(([k, label]) => h("button", {
    type: "button", class: "count", "aria-pressed": String(model.filter === k),
    onclick: () => { model.filter = model.filter === k ? null : k; for (const f of model.forks.values()) paintCell(f); paintCounts(); },
  }, h("b", {}, String(c[k])), h("span", {}, h("i", { class: `swatch s-${k}`, "aria-hidden": "true" }), label))));
  mount(current.root.querySelector("#progress"), STATUSES.map(([k]) => h("span", { class: `s-${k}`, style: { width: `${(c[k] / total) * 100}%` } })));
}

function paintAttention() {
  const list = [...model.forks.values()].filter((f) => ATTENTION.has(f.status));
  mount(current.root.querySelector("#attention"), list.length
    ? list.map((f) => h("li", {}, h("button", { type: "button", onclick: () => select(f.repo) },
        h("i", { class: `swatch s-${f.status}`, "aria-hidden": "true" }), h("code", { class: "grow" }, f.repo), statusTag(f.status))))
    : h("li", { class: "small muted" }, "No forks need attention."));
}

function paintLog() {
  mount(current.root.querySelector("#event-log"), model.log.slice(0, 60).map((l) => h("li", {}, l)));
}

let paintQueued = false;
function onEvent(ev) {
  if (ev.type === "fork" && ev.fork) ev = { ...ev.fork, type: undefined };
  if (ev.type === "snapshot" || ev.type === "stockTags") {
    if (Array.isArray(ev.stockTags)) model.stockTags = ev.stockTags;
  }
  if (ev.type === "removed") {
    model.forks.delete(ev.repo);
    if (current?.root.isConnected) buildGrid();
  } else if (ev.type === "release") {
    if (!model.stockTags.includes(ev.tag)) model.stockTags.push(ev.tag);
    model.log.unshift(`${fmtTime(ev.at)} release ${ev.tag}${ev.safety ? " (safety)" : ""} tagged`);
  } else if (Array.isArray(ev.forks)) {
    for (const f of ev.forks) model.forks.set(f.repo, { ...model.forks.get(f.repo), ...f, status: normStatus(f.status) });
    if (current?.root.isConnected) buildGrid();
  } else if (ev.repo) {
    const f = { ...(model.forks.get(ev.repo) || {}), ...ev, status: normStatus(ev.status) };
    model.forks.set(ev.repo, f);
    model.log.unshift(`${fmtTime(ev.at || new Date().toISOString())} ${ev.repo} ${f.status.replace("_", " ")}`);
    if (model.log.length > 200) model.log.length = 200;
    if (!current?.root.isConnected) return;
    if (!cells.has(ev.repo)) buildGrid(); else paintCell(f);
    if (model.selected === ev.repo) renderDrill(ev.repo);
  }
  if (!paintQueued && current?.root.isConnected) {
    paintQueued = true;
    requestAnimationFrame(() => { paintQueued = false; if (current?.root.isConnected) paintAll(); });
  }
}

function select(repo) {
  const prev = model.selected;
  model.selected = repo;
  if (prev && model.forks.has(prev)) paintCell(model.forks.get(prev));
  paintCell(model.forks.get(repo));
  renderDrill(repo);
}

async function renderDrill(repo) {
  const el = current.root.querySelector("#drill");
  const f = model.forks.get(repo);
  const head = h("dl", { class: "facts" },
    h("dt", {}, "Fork"), h("dd", {}, h("code", {}, repo)),
    h("dt", {}, "Persona"), h("dd", {}, f.persona || "n/a"),
    h("dt", {}, "Pinned stock"), h("dd", {}, h("code", {}, f.pinnedTag)),
    h("dt", {}, "Status"), h("dd", {}, statusTag(f.status)),
    f.lastRun?.branch ? [h("dt", {}, "Branch"), h("dd", {}, h("code", {}, f.lastRun.branch))] : null);
  mount(el, h("div", { class: "drill" }, head, h("p", { class: "small muted" }, "Loading...")));
  let run = null;
  let intents = [];
  try {
    [run, intents] = await Promise.all([
      f.lastRun?.runId && (f.lastRun.kind === "repair" || ATTENTION.has(f.status)) ? api.run(f.lastRun.runId).catch(() => null) : null,
      api.intents(repo).catch(() => []),
    ]);
  } catch (err) {
    mount(el, h("div", { class: "card-error" }, err.message));
    return;
  }
  if (model.selected !== repo) return;
  const related = new Set(run?.intentRefs || []);
  mount(el, h("div", { class: "drill" },
    head,
    summary(f, run),
    run?.explanation ? h("div", { class: "explain" }, h("strong", {}, run.kind === "repair" ? "Repair agent: " : ""), run.explanation) : null,
    run?.safety ? h("div", { class: "explain", style: { borderColor: "var(--fail)", background: "var(--fail-bg)" } }, run.safety) : null,
    run?.steps ? h("div", {}, h("h3", { class: "small", style: { marginBottom: "8px" } }, "Run steps"), renderTimeline(run.steps)) : null,
    run?.diff?.length ? h("div", {}, h("h3", { class: "small" }, "Proposed fix"), renderDiff(run.diff)) : null,
    run?.gate ? h("div", {}, h("h3", { class: "small", style: { marginBottom: "8px" } }, "Gate on the upgrade branch"), renderGate(run.gate)) : null,
    h("div", { class: "stack" }, h("h3", { class: "small" }, "Intent records in this fork"),
      intents.length ? intents.map((r) => renderIntent(r, { related: related.has(r.id) })) : h("p", { class: "small muted" }, "No records."))));
}

function summary(f, run) {
  const tag = f.lastRun?.tag || model.stockTags[model.stockTags.length - 1];
  const text = {
    pinned: `On ${f.pinnedTag}. No upgrade running.`,
    upgrading: `Upgrade agent is merging stock ${tag} into upgrade/${tag}.`,
    gating: `The gate is running all three tiers on upgrade/${tag}, with tiers 1 and 2 read at ${tag}.`,
    passed: f.lastRun?.applied === false ? `Upgrade to ${tag} passed all three tiers. Waiting for the user's one-tap approval (auto_upgrade is off).` : `Upgrade to ${tag} passed all three tiers and was applied.`,
    failed: run ? `Upgrade to ${tag} failed the gate. The fork stays pinned to ${f.pinnedTag}.` : `Upgrade to ${tag} failed the gate. The repair agent is reading the fork's intent records.`,
    repair_open: `Upgrade to ${tag} failed the gate. A repair branch is open for review; the fork stays pinned to ${f.pinnedTag}.`,
  }[f.status];
  return h("p", { class: "small" }, text || f.status);
}

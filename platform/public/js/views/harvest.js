// Harvest: clusters of similar customizations across opted-in forks, with draft stock branches.
import { api } from "../api.js";
import { h, mount, statusTag } from "../dom.js";
import { renderTimeline, renderIntent } from "./shared.js";

export const title = "Harvest";
export const sub = "Forks are a research channel for the mothership. The harvester reads intent records across opted-in forks, clusters similar customizations, and drafts the common ones as stock features.";

let current = null;
let selected = 0;
let harvestRun = null;
let timer = null;

export async function render(root, app) {
  current = { root, app };
  mount(root, h("p", { class: "muted" }, "Loading proposals..."));
  const proposals = await api.harvest();
  paint(proposals);
}

export function leave() {
  clearTimeout(timer);
  timer = null;
}

function paint(proposals) {
  const { root } = current;
  const max = Math.max(1, ...proposals.map((p) => p.count));
  const runBtn = h("button", { type: "button", class: "btn btn-primary", onclick: startRun }, proposals.length ? "Run the harvester again" : "Run the harvester");
  const runPanel = h("div", { id: "harvest-run" });
  if (selected >= proposals.length) selected = 0;
  mount(root, h("div", { class: "harvest" },
    h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("div", {}, h("h2", {}, "Clusters"), h("p", {}, "Similar customizations, counted by fork.")), runBtn),
      h("div", { class: "panel-body stack" }, runPanel,
        proposals.length
          ? h("ul", { class: "cluster-list" }, proposals.map((p, i) => h("li", {},
              h("button", { type: "button", class: "cluster-btn", "aria-pressed": String(i === selected), onclick: () => { selected = i; paint(proposals); } },
                h("span", { class: "cluster-count" }, String(p.count)),
                h("span", {},
                  h("strong", {}, p.cluster),
                  h("span", { class: "small muted", style: { display: "block" } }, p.draftBranch ? `Draft branch ${p.draftBranch}` : "Not drafted"),
                  h("div", { class: "cluster-bar", style: { width: `${(p.count / max) * 100}%` } }))))))
          : h("p", { class: "empty" }, "No proposals yet. Run the harvester to cluster intent records from opted-in forks."))),
    h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", {}, "Proposal")),
      h("div", { class: "panel-body" }, proposals[selected] ? detail(proposals[selected]) : h("p", { class: "empty" }, "Select a cluster.")))));
  if (harvestRun) paintRun();
}

function detail(p) {
  const shownForks = (p.forks || []).slice(0, 18);
  const intents = (p.intents || []).map((r) => (typeof r === "string" ? { id: r, request: r } : r));
  return h("div", { class: "stack" },
    h("h3", {}, `${p.count} forks: ${p.cluster}`),
    p.summary ? h("p", { class: "small" }, p.summary) : null,
    p.draftBranch
      ? h("div", { class: "explain", style: { borderColor: "var(--research)", background: "var(--research-bg)" } },
          h("strong", {}, "Draft stock feature branch: "), h("code", {}, p.draftBranch),
          p.proposedFiles?.length ? h("div", { class: "file-list", style: { marginTop: "6px" } }, p.proposedFiles.map((f) => h("code", {}, f))) : null,
          p.retires ? h("p", { class: "small", style: { marginTop: "6px" } }, p.retires) : null)
      : h("p", { class: "small muted" }, "Not drafted. The harvester drafts only clusters above 5 forks that do not change clinical behavior or conflict with an invariant; the summary above gives the reason."),
    h("div", {}, h("h4", { class: "small", style: { marginBottom: "6px" } }, "Forks"),
      h("div", { class: "file-list" }, shownForks.map((f) => h("code", {}, f)),
        p.forks?.length > shownForks.length ? h("span", { class: "small muted" }, `and ${p.forks.length - shownForks.length} more`) : null)),
    h("div", { class: "stack" }, h("h4", { class: "small" }, "Intent records it was built from"),
      intents.slice(0, 6).map((r) => renderIntent(r)),
      intents.length > 6 ? h("p", { class: "small muted" }, `${intents.length - 6} more records`) : null));
}

async function startRun() {
  try {
    const { runId } = await api.startHarvest();
    harvestRun = { id: runId, status: "running", steps: [] };
    pollRun();
  } catch (err) {
    mount(current.root.querySelector("#harvest-run"), h("div", { class: "card-error", role: "alert" }, err.message));
  }
}

async function pollRun() {
  clearTimeout(timer);
  try {
    harvestRun = await api.run(harvestRun.id);
  } catch (err) {
    mount(current.root.querySelector("#harvest-run"), h("div", { class: "card-error", role: "alert" }, err.message));
    return;
  }
  if (!current.root.isConnected || current.root.hidden) return;
  if (["passed", "failed"].includes(harvestRun.status)) {
    selected = 0;
    paint(await api.harvest());
    return;
  }
  paintRun();
  timer = setTimeout(pollRun, 600);
}

function paintRun() {
  const el = current.root.querySelector("#harvest-run");
  if (el) mount(el, h("div", { class: "stack" }, h("div", { class: "row" }, h("strong", { class: "small grow" }, "Harvester run"), statusTag(harvestRun.status)), renderTimeline(harvestRun.steps)));
}

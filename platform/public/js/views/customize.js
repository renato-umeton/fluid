// Customize: request a change, watch the agent run, review suggested tests, see the gate.
import { api } from "../api.js";
import { h, mount, json, statusTag } from "../dom.js";
import { renderTimeline, renderDiff, renderGate, renderIntent } from "./shared.js";

export const title = "Customize";
export const sub = "Ask for a change in plain words. An agent writes it on a work branch with an intent record, proposes tests, and the gate decides whether it merges.";

const EXAMPLES = [
  "Add a REDCap connector so research mode reports enrollment for my protocols",
  "Lower my confidence threshold to 0.6",
  "Raise my confidence threshold to 0.9",
];
const POLL_MS = 600;
const runs = new Map(); // persona id -> { runId, run }
let current = null;
let timer = null;

export function render(root, app) {
  current = { root, app };
  const input = h("textarea", { id: "cust-request", rows: 3, placeholder: "Describe the change you want in your fork" });
  const form = h("form", { onsubmit: (e) => { e.preventDefault(); start(input.value.trim()); } },
    h("label", { class: "field", for: "cust-request" }, "Request"),
    input,
    h("div", { class: "row" }, h("button", { class: "btn btn-primary", type: "submit" }, "Start customization"),
      h("span", { class: "small muted" }, `Runs against ${app.fork.repo} on stock ${app.fork.stockTag}`)));
  mount(root, h("div", { class: "customize" },
    h("section", { class: "panel request-box" },
      h("div", { class: "panel-head" }, h("h2", {}, "What should your fork do differently?")),
      h("div", { class: "panel-body stack" }, form,
        h("div", { class: "examples" }, h("span", { class: "small muted" }, "Examples"),
          EXAMPLES.map((x) => h("button", { type: "button", class: "btn", onclick: () => { input.value = x; input.focus(); } }, x))))),
    h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", {}, "Run"), h("span", { id: "run-status" })), h("div", { class: "panel-body", id: "run-steps" })),
    h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", {}, "Diff summary"), h("span", { id: "run-branch", class: "small muted" })), h("div", { class: "panel-body", id: "run-diff" })),
    h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("div", {}, h("h2", {}, "Suggested tests"), h("p", {}, "Tier 3 tests proposed from the diff and the intent record."))), h("div", { class: "panel-body stack", id: "run-suggestions" })),
    h("section", { class: "panel wide" }, h("div", { class: "panel-head" }, h("h2", {}, "Gate result")), h("div", { class: "panel-body", id: "run-gate" })),
    h("section", { class: "panel wide" }, h("div", { class: "panel-head" }, h("h2", {}, "Intent record for this change")), h("div", { class: "panel-body", id: "run-intent" })),
  ));
  const saved = runs.get(app.persona.id);
  paint(saved?.run ?? null);
  if (saved && !isFinal(saved.run)) poll();
}

export function leave() {
  clearTimeout(timer);
  timer = null;
}

function isFinal(run) {
  return run && ["passed", "failed"].includes(run.status);
}

async function start(request) {
  if (!request) return;
  const { app } = current;
  try {
    const { runId } = await api.customize(app.fork.repo, request);
    runs.set(app.persona.id, { runId, run: { id: runId, status: "running", steps: [], request } });
    paint(runs.get(app.persona.id).run);
    poll();
  } catch (err) {
    mount(current.root.querySelector("#run-steps"), h("div", { class: "card-error", role: "alert" }, err.message));
  }
}

async function poll() {
  clearTimeout(timer);
  const persona = current.app.persona.id;
  const entry = runs.get(persona);
  if (!entry) return;
  try {
    entry.run = await api.run(entry.runId);
  } catch (err) {
    mount(current.root.querySelector("#run-steps"), h("div", { class: "card-error", role: "alert" }, err.message));
    return;
  }
  if (current.app.persona.id !== persona || !current.root.isConnected) return;
  paint(entry.run);
  if (isFinal(entry.run)) {
    current.app.refreshFork().catch(() => {});
    return;
  }
  timer = setTimeout(poll, POLL_MS);
}

function paint(run) {
  const $ = (id) => current.root.querySelector(id);
  if (!run) {
    mount($("#run-steps"), h("p", { class: "empty" }, "No run yet. Start with one of the examples."));
    mount($("#run-diff"), h("p", { class: "empty" }, "No changes yet."));
    mount($("#run-suggestions"), h("p", { class: "empty" }, "Suggestions appear after the change is pushed."));
    mount($("#run-gate"), renderGate(null));
    mount($("#run-intent"), h("p", { class: "empty" }, "Every change gets one."));
    mount($("#run-status"));
    return;
  }
  mount($("#run-status"), statusTag(run.status));
  mount($("#run-steps"), h("p", { class: "small", style: { marginBottom: "10px" } }, h("strong", {}, "Request: "), run.request ?? ""), renderTimeline(run.steps));
  mount($("#run-branch"), run.branch ? h("code", {}, `${run.branch}${run.commit ? ` at ${run.commit.slice(0, 7)}` : ""}`) : "");
  mount($("#run-diff"), renderDiff(run.diff));
  mount($("#run-suggestions"), run.suggestions?.length ? run.suggestions.map((s) => suggestion(run, s)) : h("p", { class: "empty" }, "Suggestions appear after the change is pushed."));
  mount($("#run-gate"), renderGate(run.gate));
  mount($("#run-intent"), run.intent ? renderIntent(run.intent) : h("p", { class: "empty" }, "Written by the agent before it commits."));
}

function suggestion(run, s) {
  const decided = s.decision;
  const editor = h("textarea", { class: "probe-json", rows: 6, "aria-label": `Edit assertions for ${s.title}` }, json(s.probe?.assert ?? []));
  const editWrap = h("div", { hidden: true, class: "stack" }, editor,
    h("div", { class: "row" },
      h("button", { type: "button", class: "btn btn-primary", onclick: async () => {
        let assert;
        try { assert = JSON.parse(editor.value); } catch (err) { editError.textContent = `Assertions must be valid JSON: ${err.message}`; return; }
        await decide(run, s, "edit", { assert });
      } }, "Save edited test"),
      h("button", { type: "button", class: "btn", onclick: () => { editWrap.hidden = true; } }, "Cancel")));
  const editError = h("p", { class: "small", style: { color: "var(--fail)" }, role: "alert" });
  editWrap.append(editError);
  return h("article", { class: "suggestion", dataset: { decision: decided || "" } },
    h("div", { class: "row" }, h("strong", { class: "grow" }, s.title), decided ? h("span", { class: `tag ${decided === "reject" ? "" : "pass"}` }, decided === "edit" ? "edited and accepted" : `${decided}ed`) : null),
    h("p", { class: "small muted" }, s.rationale),
    h("p", { class: "xsmall" }, h("code", {}, s.file), s.intentId ? ` verifies ${s.intentId}` : ""),
    probeSummary(s.probe),
    decided ? null : h("div", { class: "row" },
      h("button", { type: "button", class: "btn btn-primary", onclick: () => decide(run, s, "accept") }, "Accept"),
      h("button", { type: "button", class: "btn", onclick: () => { editWrap.hidden = false; editor.focus(); } }, "Edit"),
      h("button", { type: "button", class: "btn btn-danger", onclick: () => decide(run, s, "reject") }, "Reject")),
    decided ? null : editWrap);
}

function describeAssert(a) {
  const op = Object.keys(a).find((k) => k !== "path");
  const value = a[op];
  const shown = op === "some" || op === "every" ? describeAssert(value) : JSON.stringify(value);
  return `${a.path || "answer"} ${op} ${shown}`;
}

function probeSummary(probe) {
  if (!probe) return null;
  const ctx = probe.request?.context ? Object.entries(probe.request.context).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ") : "";
  return h("div", { class: "stack", style: { gap: "6px" } },
    probe.request ? h("p", { class: "small" }, h("span", { class: "muted" }, "Asks "), `"${probe.request.question}"`, ctx ? h("span", { class: "muted" }, ` with ${ctx}`) : null) : null,
    h("ul", { class: "framing" }, (probe.assert || []).map((a) => h("li", {}, h("code", {}, describeAssert(a))))),
    h("details", { class: "ctx-json" }, h("summary", {}, "Probe JSON"), h("pre", {}, json(probe))));
}

async function decide(run, s, decision, edited) {
  try {
    const updated = await api.decide(run.id, s.id, decision, edited);
    const entry = runs.get(current.app.persona.id);
    if (entry) entry.run = updated;
    paint(updated);
    poll();
  } catch (err) {
    alertError(err);
  }
}

function alertError(err) {
  mount(current.root.querySelector("#run-suggestions"), h("div", { class: "card-error", role: "alert" }, err.message));
}

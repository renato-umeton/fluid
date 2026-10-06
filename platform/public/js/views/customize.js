// Customize: request a change, watch the agent run, review suggested tests, see the gate.
import { api } from "../api.js";
import { h, mount, json, statusTag } from "../dom.js";
import { renderTimeline, renderDiff, renderGate, renderIntent, repairApply } from "./shared.js";
import { renderHealth } from "../health.js";
import { mergeOutcome, uiChanges } from "../ui-prefs.js";

export const title = "Customize";
export const sub = "Ask for a change in plain words. An agent writes it on a work branch with an intent record, proposes tests, and the gate decides whether it merges.";

const EXAMPLES = [
  "Add a REDCap connector so research mode reports enrollment for my protocols",
  "Lower my confidence threshold to 0.6",
  "Raise my confidence threshold to 0.9",
  "Use Palatino fonts and add a tab with charts",
  "Make the look and feel like it is 2001 and we run on Windows XP",
];
const POLL_MS = 600;
const runs = new Map(); // persona id -> { runId, run, uiBefore, applied }
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
    h("section", { class: "panel wide" }, h("div", { class: "panel-head" }, h("div", {}, h("h2", {}, "Yellow phase"), h("p", {}, "After the gate merges, the change is live on main in yellow. The end-to-end suite runs against the live fork 3 times; a failure rolls main back."))), h("div", { class: "panel-body", id: "run-yellow" })),
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

/** A run is done when it reached a final status and any yellow phase it started has settled. */
function isFinal(run) {
  return run && ["passed", "failed"].includes(run.status) && run.yellow?.health !== "yellow";
}

/** The change is on main once the run passed or its yellow phase started. */
function merged(run) {
  return run?.status === "passed" || Boolean(run?.yellow?.runId);
}

function touchesUi(run) {
  return (run.intent?.files ?? (run.diff ?? []).map((d) => d.path)).includes("ui/preferences.json");
}

async function start(request) {
  if (!request) return;
  const { app } = current;
  try {
    const { runId } = await api.customize(app.fork.repo, request);
    runs.set(app.persona.id, { runId, run: { id: runId, status: "running", steps: [], request }, uiBefore: structuredClone(app.ui ?? {}), applied: null });
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
  if (merged(entry.run) && touchesUi(entry.run) && !entry.applied) {
    entry.yellowSeen = entry.run.yellow?.runId;
    await showApplied(entry, persona);
  }
  // The change is live: refresh the fork once so the top bar shows the yellow badge.
  if (entry.run.yellow?.runId && entry.yellowSeen !== entry.run.yellow.runId) {
    entry.yellowSeen = entry.run.yellow.runId;
    current.app.refreshFork().catch(() => {});
  }
  if (isFinal(entry.run)) {
    current.app.refreshFork().catch(() => {});
    return;
  }
  timer = setTimeout(poll, POLL_MS);
}

/**
 * After a UI change merges: reload the fork's preferences, say what changed,
 * and open a tab the change added, so the result is in front of the user.
 */
async function showApplied(entry, persona) {
  const { app } = current;
  const repo = app.fork?.repo;
  entry.applied = { lines: [], newTabs: [] };
  try {
    await app.refreshFork();
  } catch {
    entry.applied = null; // the next poll tries again
    return;
  }
  // The user may have switched persona while the fork reloaded; app.ui is then another fork's.
  if (app.persona.id !== persona || app.fork?.repo !== repo) {
    entry.applied = null;
    return;
  }
  entry.applied = uiChanges(entry.uiBefore, app.ui);
  if (app.persona.id !== persona || !current.root.isConnected || app.view !== "customize") return;
  paint(entry.run);
  const tab = entry.applied.newTabs[0];
  if (tab) app.go("tab", `i=${tab.index}`);
}

function appliedBox(run) {
  const entry = runs.get(current.app.persona.id);
  const done = entry?.run?.id === run.id ? entry.applied : null;
  if (!done) return null;
  const outcome = mergeOutcome(run, done);
  return h("div", { class: "applied", role: "status", dataset: { state: outcome.state } },
    h("p", {}, outcome.text),
    outcome.open && done.newTabs.length ? h("div", { class: "row" }, done.newTabs.map((t) => h("button", { type: "button", class: "btn btn-primary", onclick: () => current.app.go("tab", `i=${t.index}`) }, `Open ${t.title}`))) : null);
}

function paint(run) {
  const $ = (id) => current.root.querySelector(id);
  if (!run) {
    mount($("#run-steps"), h("p", { class: "empty" }, "No run yet. Start with one of the examples."));
    mount($("#run-diff"), h("p", { class: "empty" }, "No changes yet."));
    mount($("#run-suggestions"), h("p", { class: "empty" }, "Suggestions appear after the change is pushed."));
    mount($("#run-gate"), renderGate(null));
    mount($("#run-intent"), h("p", { class: "empty" }, "Every change gets one."));
    mount($("#run-yellow"), h("p", { class: "empty" }, "Starts when the gate merges the change to main."));
    mount($("#run-status"));
    return;
  }
  mount($("#run-status"), statusTag(run.status));
  mount($("#run-steps"), appliedBox(run), h("p", { class: "small", style: { marginBottom: "10px" } }, h("strong", {}, "Request: "), run.request ?? ""), renderTimeline(run.steps),
    run.status === "failed" && run.error ? h("div", { class: "explain", role: "status", style: { marginTop: "10px" } }, h("strong", {}, "Why the run stopped: "), run.error) : null,
    run.intent?.mapped?.length ? h("div", { class: "explain", style: { marginTop: "10px" } }, h("strong", {}, "How your request was mapped: "), h("ul", { class: "framing" }, run.intent.mapped.map((m) => h("li", {}, m)))) : null);
  mount($("#run-branch"), run.branch ? h("code", {}, `${run.branch}${run.commit ? ` at ${run.commit.slice(0, 7)}` : ""}`) : "");
  mount($("#run-diff"), renderDiff(run.diff));
  mount($("#run-suggestions"), run.suggestions?.length ? run.suggestions.map((s) => suggestion(run, s)) : h("p", { class: "empty" }, "Suggestions appear after the change is pushed."));
  mount($("#run-gate"), renderGate(run.gate), run.repair?.branch ? repairBox(run) : null);
  mount($("#run-intent"), run.intent ? renderIntent(run.intent) : h("p", { class: "empty" }, "Written by the agent before it commits."));
  paintYellow($("#run-yellow"), run);
}

const yellowRuns = new Map(); // yellow run id -> last fetched run
const yellowFetched = new Map(); // yellow run id -> time of the last fetch
const YELLOW_POLL_MS = 2500;
async function paintYellow(el, run) {
  const y = run.yellow;
  if (!y?.runId) {
    mount(el, h("p", { class: "empty" }, run.status === "failed" ? "The change did not reach main, so there is no yellow phase." : "Starts when the gate merges the change to main."));
    return;
  }
  const health = { health: y.health === "cancelled" ? "yellow" : y.health, commit: y.commit, pass: y.pass ?? 0, of: y.of ?? 3, runId: y.health === "yellow" ? y.runId : null, failure: y.failure ?? null, browser: y.browser ?? null, lastGreenCommit: null, since: run.updatedAt };
  mount(el, renderHealth(health, yellowRuns.get(y.runId) ?? null));
  const cached = yellowRuns.get(y.runId);
  const settled = cached && ["passed", "failed", "cancelled"].includes(cached.status);
  if (cached && (settled || (y.health === "yellow" && Date.now() - (yellowFetched.get(y.runId) ?? 0) < YELLOW_POLL_MS))) return;
  yellowFetched.set(y.runId, Date.now());
  try {
    const yellow = await api.run(y.runId);
    yellowRuns.set(y.runId, yellow);
    if (el.isConnected) mount(el, renderHealth({ ...health, lastGreenCommit: y.health === "green" ? y.commit : yellow.rolledBackTo ?? null }, yellow),
      y.repairRunId && run.repair?.branch ? h("p", { class: "small muted" }, `Repair ${run.repair.branch} is linked to this change's intent record.`) : null);
  } catch {
    // The yellow run record appears a moment after the gate merges.
  }
}

function repairBox(run) {
  return h("div", { class: "stack", style: { marginTop: "12px" } },
    h("h3", { class: "small" }, `Repair branch ${run.repair.branch}`),
    run.repair.explanation ? h("div", { class: "explain" }, h("strong", {}, "Repair agent: "), run.repair.explanation) : null,
    repairApply(run.repo, run.repair.branch, { gatePassed: run.repair.repairGatePassed ?? null }));
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
    scenarioSummary(s.scenario),
    decided ? null : h("div", { class: "row" },
      h("button", { type: "button", class: "btn btn-primary", onclick: () => decide(run, s, "accept") }, "Accept"),
      s.scenario ? null : h("button", { type: "button", class: "btn", onclick: () => { editWrap.hidden = false; editor.focus(); } }, "Edit"),
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

/** An end-to-end scenario suggestion: its steps in order, for tests/user/e2e.json. */
function scenarioSummary(scenario) {
  if (!scenario) return null;
  const describe = (st) => st.kind === "ask" ? `ask "${st.request?.question}"${st.request?.explicitMode ? ` in ${st.request.explicitMode} mode` : ""}`
    : st.kind === "override" ? `override ${st.answer} to ${st.mode}${st.reask ? ` and ask again` : ""}`
    : st.kind === "ledger" ? `read the ledger record of ${st.answer}`
    : st.kind === "config" ? `check ${st.file}` : st.kind;
  return h("div", { class: "stack", style: { gap: "6px" } },
    h("p", { class: "xsmall muted" }, "End-to-end scenario: runs in the yellow soak against the live fork after this change lands."),
    h("ol", { class: "framing" }, scenario.steps.map((st) => h("li", {}, `${describe(st)}; then ${(st.assert || []).map(describeAssert).join(", ") || "record it"}`))),
    h("details", { class: "ctx-json" }, h("summary", {}, "Scenario JSON"), h("pre", {}, json(scenario))));
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

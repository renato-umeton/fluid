// Contest: best-of-N agents compete to grant one wish. Contestants side by
// side with live status, the behavior diff (rows are probes, columns are main
// and each candidate), the winner with the rule's reason, and "Ship this one".
// Built with h() only; every state is written out, never shown by color alone.
import { api } from "../api.js";
import { h, mount, short, statusTag } from "../dom.js";
import { renderTimeline } from "./shared.js";
import { cellView, changeLine, countsLine, isFinalContest, joinCountdown, mainText, seconds, shipChoices, statusText, tierLines } from "../contest.js";

export const title = "Contest";
export const sub = "Several agents compete to grant one wish. Each works on its own branch and is gated in check mode; a behavior diff against main and a fixed rule pick the winner. Only the one you ship is gated in merge mode.";

const EXAMPLES = [
  "Add a plain-language summary line to research answers",
  "Raise my confidence threshold to 0.9",
  "Add a REDCap connector so research mode reports enrollment for my protocols",
];
const RULES = [
  "(a) every tier passed, and every wish test passed",
  "(b) fewest behavior changes outside what the wish targets",
  "(c) fewest files changed",
  "(d) finished first",
];
const POLL_MS = 700;
const contests = new Map(); // persona id -> { runId, run, children }
let current = null;
let timer = null;
let onlyChanged = false;

export function render(root, app, params) {
  current = { root, app };
  const fromUrl = params?.get("run");
  if (fromUrl && contests.get(app.persona.id)?.runId !== fromUrl) contests.set(app.persona.id, { runId: fromUrl, run: null, children: {} });
  const input = h("textarea", { id: "contest-request", rows: 3, placeholder: "Describe the change you want in your fork" }, params?.get("request") ?? "");
  const size = h("select", { id: "contest-size" }, h("option", { value: "3" }, "3 contestants"), h("option", { value: "2" }, "2 contestants"));
  const agent = h("input", { type: "checkbox", id: "contest-agent" });
  const form = h("form", { onsubmit: (e) => { e.preventDefault(); start(input.value.trim(), Number(size.value), agent.checked); } },
    h("label", { class: "field", for: "contest-request" }, "Wish"),
    input,
    h("div", { class: "row" },
      h("label", { class: "small", for: "contest-size" }, "Contestants "), size,
      h("label", { class: "small row", for: "contest-agent" }, agent, "Let my own agent join (it pushes to the inbox within 5 minutes)")),
    h("div", { class: "row" }, h("button", { class: "btn btn-primary", type: "submit" }, "Start the contest"),
      h("span", { class: "small muted" }, `A contest of N counts as N customizations on ${app.fork.repo}`)));
  mount(root, h("div", { class: "contest" },
    h("section", { class: "panel request-box" },
      h("div", { class: "panel-head" }, h("h2", {}, "One wish, several agents")),
      h("div", { class: "panel-body stack" }, form,
        h("div", { class: "examples" }, h("span", { class: "small muted" }, "Examples"),
          EXAMPLES.map((x) => h("button", { type: "button", class: "btn", onclick: () => { input.value = x; input.focus(); } }, x))))),
    h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", {}, "Contest"), h("span", { id: "contest-status" })),
      h("div", { class: "panel-body", id: "contest-steps" })),
    h("section", { class: "panel wide", "aria-live": "polite" }, h("div", { class: "panel-body", id: "contest-banner" })),
    h("section", { class: "panel wide" },
      h("div", { class: "panel-head" }, h("div", {}, h("h2", {}, "Contestants"), h("p", {}, "Each one plans, is checked in an isolate, commits its change with its intent record and wish tests, and is gated in check mode."))),
      h("div", { class: "panel-body", id: "contest-columns" })),
    h("section", { class: "panel wide" },
      h("div", { class: "panel-head" }, h("div", {}, h("h2", {}, "Behavior diff"), h("p", {}, "Every probe the gate ran, with the fork's answer on main and on each candidate. This replaces the pull request: you review what changed in the answers, not lines of code.")),
        h("label", { class: "small row", for: "contest-only-changed" }, h("input", { type: "checkbox", id: "contest-only-changed", checked: onlyChanged, onchange: (e) => { onlyChanged = e.target.checked; paint(); } }), "Only rows with changes")),
      h("div", { class: "panel-body", id: "contest-diff" })),
  ));
  paint();
  const saved = contests.get(app.persona.id);
  if (saved && !isFinalContest(saved.run)) poll();
}

export function leave() {
  clearTimeout(timer);
  timer = null;
}

/** Starts a contest from this view or from Customize ("Run as a contest"). */
export async function startContest(app, request, size = 3, includeAgent = false) {
  const out = await api.startContest(app.fork.repo, request, size, includeAgent);
  contests.set(app.persona.id, { runId: out.runId, run: null, children: {} });
  return out;
}

async function start(request, size, includeAgent) {
  if (!request) return;
  try {
    await startContest(current.app, request, size, includeAgent);
    paint();
    poll();
  } catch (err) {
    mount(current.root.querySelector("#contest-steps"), h("div", { class: "card-error", role: "alert" }, err.message));
  }
}

async function poll() {
  clearTimeout(timer);
  const persona = current.app.persona.id;
  const entry = contests.get(persona);
  if (!entry) return;
  try {
    entry.run = await api.run(entry.runId);
    const kids = await Promise.all((entry.run.contestants ?? []).map((c) => (c.runId ? api.run(c.runId).catch(() => null) : null)));
    entry.children = Object.fromEntries(kids.filter(Boolean).map((k) => [k.label ?? k.id, k]));
  } catch (err) {
    mount(current.root.querySelector("#contest-steps"), h("div", { class: "card-error", role: "alert" }, err.message));
    return;
  }
  if (current.app.persona.id !== persona || !current.root.isConnected) return;
  paint();
  if (entry.run.status === "passed" && !entry.refreshed) {
    entry.refreshed = true;
    current.app.refreshFork().catch(() => {});
  }
  if (!isFinalContest(entry.run)) timer = setTimeout(poll, POLL_MS);
}

async function ship(label) {
  const entry = contests.get(current.app.persona.id);
  if (!entry) return;
  try {
    entry.run = await api.pickContest(entry.runId, label);
    paint();
    poll();
  } catch (err) {
    mount(current.root.querySelector("#contest-banner"), h("div", { class: "card-error", role: "alert" }, err.message));
  }
}

function paint() {
  const $ = (id) => current.root.querySelector(id);
  const entry = contests.get(current.app.persona.id);
  const run = entry?.run;
  if (!run) {
    mount($("#contest-status"));
    mount($("#contest-steps"), h("p", { class: "empty" }, entry ? "Starting the contest..." : "No contest yet. Write a wish and start one."));
    mount($("#contest-banner"), h("p", { class: "empty" }, "The winner and the rule's reason appear here."));
    mount($("#contest-columns"), h("p", { class: "empty" }, "Contestants appear when the contest starts."));
    mount($("#contest-diff"), h("p", { class: "empty" }, "The behavior diff appears when every contestant has been checked."));
    return;
  }
  // Polling repaints every section; keep the <details> the reader opened open.
  const open = openDetailKeys(current.root);
  mount($("#contest-status"), statusTag(run.status));
  mount($("#contest-steps"),
    h("p", { class: "small", style: { marginBottom: "10px" } }, h("strong", {}, "Wish: "), run.request ?? ""),
    agentBox(run),
    renderTimeline(run.steps));
  mount($("#contest-banner"), banner(run));
  mount($("#contest-columns"), columns(run, entry.children ?? {}));
  mount($("#contest-diff"), diffTable(run));
  reopenDetails(current.root, open);
}

/** Keys for the open <details>: section id, summary text, and its position among equal summaries. */
export function detailKeys(root) {
  const seen = new Map();
  return [...root.querySelectorAll("details")].map((d) => {
    const section = d.closest("[id]")?.id ?? "";
    const base = `${section}|${d.querySelector("summary")?.textContent ?? ""}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { details: d, key: `${base}|${n}` };
  });
}

function openDetailKeys(root) {
  return new Set(detailKeys(root).filter((x) => x.details.open).map((x) => x.key));
}

function reopenDetails(root, open) {
  if (open.size === 0) return;
  for (const { details, key } of detailKeys(root)) if (open.has(key)) details.open = true;
}

function agentBox(run) {
  if (!run.includeAgent || !run.agentBranch) return null;
  const agent = (run.contestants ?? []).find((c) => c.label === "agent");
  const waiting = agent?.status === "waiting for your push";
  return h("div", { class: "explain contest-join", style: { marginBottom: "10px" } },
    h("p", {}, h("strong", {}, "Your own agent: "), waiting ? `push your entry to ${run.agentBranch} in your inbox (My fork, Connect your own agent). ${joinCountdown(run.joinUntil)}.` : agent?.status === "no change" ? `no entry joined: ${agent.error ?? "the window closed"}.` : `joined as ${agent?.branch ?? "your entry"}.`),
    waiting ? h("pre", { class: "xsmall" }, `git checkout -b ${run.agentBranch}\ngit push origin ${run.agentBranch}`) : null);
}

function banner(run) {
  const verdict = run.verdict;
  if (!verdict) return h("p", { class: "empty" }, "Checking every contestant. The winner and the rule's reason appear here.");
  const choices = shipChoices(run);
  const shipped = run.picked;
  return h("div", { class: "contest-banner", dataset: { state: verdict.winner ? (run.status === "passed" ? "shipped" : "winner") : "none" }, role: "status" },
    h("h2", {}, verdict.winner ? `Winner: ${verdict.winner}` : "No winner"),
    h("p", {}, verdict.reason),
    shipped ? h("p", {}, h("strong", {}, run.status === "passed" ? `Shipped ${shipped.label}: ` : `Shipping ${shipped.label}: `), shipped.by === "rule" ? "the rule's choice." : shipped.reason, run.status === "passed" ? " It is on main now, live in yellow until the end-to-end soak passes." : " It is being gated in merge mode; main moves only if every tier passes.") : null,
    run.pickRequested && !shipped ? h("p", {}, `Shipping ${run.pickRequested}...`) : null,
    run.yellow ? h("p", {}, h("strong", {}, "Health: "), run.yellow.health === "yellow" ? `yellow, soak pass ${run.yellow.pass ?? 0} of ${run.yellow.of ?? 3}` : run.yellow.health === "green" ? "green: the end-to-end soak passed 3 times" : String(run.yellow.health)) : null,
    h("details", { class: "small" }, h("summary", {}, "How the winner is picked"),
      h("ol", { class: "framing" }, RULES.map((r) => h("li", {}, r))),
      h("p", { class: "muted" }, "Wording changes (body, framing, sources) in the modes the wish tests ask about count as inside the wish. Any change to mode, confidence, dose, attestation, override, or ledger fields, or to another mode, counts as outside.")),
    choices.includes(verdict.winner) ? h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-primary", onclick: () => ship(verdict.winner) }, `Ship the winner (${verdict.winner})`),
      h("span", { class: "small muted" }, "Or ship another contestant that passed, below.")) : null,
    run.notes ? h("ul", { class: "framing" }, Object.entries(run.notes).map(([label, note]) => h("li", {}, h("strong", {}, `${label}: `), note))) : null);
}

function columns(run, children) {
  const list = run.contestants ?? [];
  if (!list.length) return h("p", { class: "empty" }, "No contestants yet.");
  const choices = shipChoices(run);
  return h("div", { class: "contest-grid", style: { gridTemplateColumns: `repeat(${list.length}, minmax(220px, 1fr))` } }, list.map((c) => {
    const winner = run.winner === c.label;
    const picked = run.picked?.label === c.label;
    const steps = children[c.label]?.steps ?? c.steps ?? [];
    return h("article", { class: "contestant", dataset: { winner: winner ? "yes" : "no", picked: picked ? "yes" : "no" }, "aria-label": `Contestant ${c.label}` },
      h("header", { class: "contestant-head" },
        h("h3", {}, c.label, winner ? h("span", { class: "tag pass", style: { marginLeft: "8px" } }, "winner") : null, picked && !winner ? h("span", { class: "tag warn", style: { marginLeft: "8px" } }, "your pick") : null),
        h("p", { class: "xsmall muted" }, c.title ?? c.kind)),
      h("p", { class: "small" }, h("span", { class: `tag ${c.status === "evaluated" ? (c.gate?.passed ? "pass" : "fail") : c.status === "no change" ? "fail" : "run"}` }, c.status === "evaluated" ? (c.gate?.passed ? "passed the gate" : "failed the gate") : statusText(c.status))),
      c.branch && c.status !== "no change" ? h("p", { class: "xsmall" }, h("code", {}, c.branch), c.commit ? ` at ${short(c.commit)}` : "") : null,
      c.summary ? h("p", { class: "small" }, c.summary) : null,
      c.error ? h("p", { class: "small", role: "note" }, h("strong", {}, "No change: "), c.error) : null,
      h("ul", { class: "tier-list" }, tierLines(c.gate).map((t) => h("li", { dataset: { state: t.state } }, h("span", {}, t.name), h("span", { class: "tier-text" }, t.text)))),
      c.gate?.firstFailure ? h("p", { class: "xsmall", role: "note" }, h("strong", {}, "First failure: "), c.gate.firstFailure) : null,
      countsLine(c) ? h("p", { class: "xsmall" }, countsLine(c)) : null,
      c.files?.length ? h("details", { class: "xsmall" }, h("summary", {}, `Files touched (${c.files.length})`), h("ul", {}, c.files.map((f) => h("li", {}, h("code", {}, f))))) : null,
      c.latencyMs !== undefined || c.checkMs !== undefined ? h("p", { class: "xsmall muted" }, [c.latencyMs !== undefined ? `ready in ${seconds(c.latencyMs)}` : null, c.checkMs !== undefined ? `checked in ${seconds(c.checkMs)}` : null].filter(Boolean).join(", ")) : null,
      c.note ? h("p", { class: "xsmall", role: "note" }, c.note) : null,
      choices.includes(c.label) && run.winner !== c.label ? h("button", { type: "button", class: "btn", onclick: () => ship(c.label) }, `Ship this one (${c.label})`) : null,
      steps.length ? h("details", { class: "xsmall" }, h("summary", {}, "Steps"), renderTimeline(steps)) : null);
  }));
}

function diffTable(run) {
  const table = run.behavior;
  if (!table) return h("p", { class: "empty" }, "The behavior diff appears when every contestant has been checked.");
  const labels = (run.contestants ?? []).filter((c) => table.rows.some((r) => r.cells?.[c.label])).map((c) => c.label);
  const rows = table.rows.filter((r) => !onlyChanged || labels.some((l) => r.cells[l]?.changed));
  return h("div", { class: "stack" },
    h("p", { class: "small muted" }, `Rows: ${table.rows.length} probes${table.omitted ? `, and ${table.omitted} more that no contestant changed` : ""}. ${table.targetModes?.length ? `The wish tests ask about ${table.targetModes.join(", ")} answers.` : "The wish tests ask about no answer mode."}`),
    h("div", { class: "table-wrap" },
      h("table", { class: "data behavior-diff" },
        h("caption", { class: "visually-hidden" }, "Behavior diff: one row per probe, one column for main and one per contestant"),
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Probe"), h("th", { scope: "col" }, "main"), labels.map((l) => h("th", { scope: "col" }, l, run.winner === l ? " (winner)" : "")))),
        h("tbody", {}, rows.map((r) => h("tr", { dataset: { wish: r.wish ? "yes" : "no" } },
          h("th", { scope: "row" },
            h("code", {}, r.id), " ", h("span", { class: `tag ${r.wish ? "warn" : ""}` }, r.wish ? "wish test" : r.tier),
            r.question ? h("div", { class: "xsmall muted" }, r.question) : null),
          h("td", { dataset: { state: "main" } }, mainText(r.main)),
          labels.map((l) => cell(r.cells[l]))))))),
    run.wishTests?.length ? h("p", { class: "xsmall muted" }, `Wish tests (every contestant faces them): ${run.wishTests.map((w) => w.id).join(", ")}`) : null);
}

function cell(c) {
  const view = cellView(c);
  return h("td", { class: "diff-cell", dataset: { state: view.state }, "aria-label": view.label },
    h("span", { class: "cell-mark", "aria-hidden": "true" }, view.state === "same" ? "=" : view.state === "missing" ? "?" : view.state === "own" ? "new" : "+/-"),
    " ", view.text,
    c?.changed && c.changes?.length ? h("details", {}, h("summary", {}, `Show ${c.changes.length < c.total ? `${c.changes.length} of ${c.total}` : c.total} field change${c.total === 1 ? "" : "s"}`),
      h("ul", {}, c.changes.map((x) => h("li", {}, changeLine(x))))) : null);
}

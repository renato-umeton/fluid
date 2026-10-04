// My fork: repository facts, branches, gate history, build-time and run-time ledgers.
import { api } from "../api.js";
import { h, mount, short, fmtConf, fmtTime, modeBadge, statusTag, MODE_LABEL } from "../dom.js";
import { renderIntent } from "./shared.js";
import { renderHealth } from "../health.js";

const HEALTH_POLL_MS = 3000;
let healthTimer = null;

export const title = "My fork";
export const sub = "Your personal repository, forked from a stock release. The gate reads stock tests at the pinned tag, so nothing here can weaken the floor.";

export function leave() {
  clearTimeout(healthTimer);
  healthTimer = null;
}

export async function render(root, app, params) {
  leave();
  mount(root, h("p", { class: "muted" }, "Loading your fork..."));
  const [fork, intents, ledger, gates] = await Promise.all([
    app.refreshFork(), api.intents(app.fork.repo), api.ledger(app.userId), api.gates(app.fork.repo).catch(() => []),
  ]);
  const highlight = params.get("answer");
  const healthBody = h("div", { class: "panel-body", id: "health-body" }, h("p", { class: "small muted" }, "Loading health..."));
  mount(root, h("div", { class: "fork-grid" },
    h("section", { class: "panel wide", "aria-labelledby": "health-heading" },
      h("div", { class: "panel-head" }, h("div", {}, h("h2", { id: "health-heading" }, "Health: yellow to green"),
        h("p", {}, "Every change that passes the gate goes live on main in yellow. The stock end-to-end suite (plus your own scenarios) then runs against the live fork; 3 passes in a row turn it green, and a failure rolls main back to the last green commit."))),
      healthBody),
    factsPanel(app, fork),
    branchesPanel(fork, gates),
    ledgerPanel(ledger, highlight),
    intentsPanel(intents),
  ));
  if (highlight) root.querySelector("tr.hl")?.scrollIntoView({ block: "center" });
  await paintHealth(healthBody, app, fork.repo);
}

/** Health panel: the latest yellow run's scenarios and failing step, refreshed while the fork is yellow. */
async function paintHealth(el, app, repo) {
  if (!el.isConnected || app.fork?.repo !== repo) return;
  try {
    const { health, history } = await api.health(repo);
    const runId = health.runId ?? history.find((e) => e.runId && e.event !== "superseded" && e.event !== "cancelled")?.runId ?? null;
    const run = runId ? await api.run(runId).catch(() => null) : null;
    if (!el.isConnected) return;
    mount(el, renderHealth(health, run, history));
    if (health.health === "yellow" && health.runId) healthTimer = setTimeout(() => paintHealth(el, app, repo), HEALTH_POLL_MS);
  } catch (err) {
    mount(el, h("p", { class: "small muted" }, `Health is unavailable: ${err.message}`));
  }
}

function factsPanel(app, fork) {
  const eff = app.effectiveTau();
  const min = Number(fork.stockMinTau) || app.stockMinTau;
  const copy = h("button", { type: "button", class: "btn btn-quiet", onclick: async (e) => {
    try { await navigator.clipboard.writeText(fork.remote); e.target.textContent = "Copied"; } catch { e.target.textContent = "Copy failed"; }
  } }, "Copy");
  return h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", {}, "Repository")),
    h("div", { class: "panel-body stack" },
      h("dl", { class: "facts" },
        h("dt", {}, "Repo"), h("dd", {}, h("code", {}, fork.repo)),
        h("dt", {}, "Remote"), h("dd", {}, h("code", {}, fork.remote), " ", copy),
        h("dt", {}, "Pinned stock"), h("dd", {}, h("code", {}, fork.stockTag)),
        fork.head ? [h("dt", {}, "main"), h("dd", {}, h("code", {}, short(fork.head)))] : null,
        h("dt", {}, "Configured τ"), h("dd", {}, typeof fork.tau === "number" ? fmtConf(fork.tau) : "not set (stock default)"),
        h("dt", {}, "Effective τ"), h("dd", {}, h("strong", {}, eff.toFixed(2)), h("span", { class: "muted" }, ` (stock minimum ${min.toFixed(2)})`)),
        fork.preferences ? [h("dt", {}, "Preferences"), h("dd", {}, `auto_upgrade ${fork.preferences.auto_upgrade}, harvest_opt_in ${fork.preferences.harvest_opt_in}`)] : null,
      ),
      h("div", { class: "tau-meter" },
        h("div", { class: "tau-track", role: "img", "aria-label": `Effective threshold ${eff.toFixed(2)}; stock minimum ${min.toFixed(2)}` },
          h("div", { class: "tau-fill", style: { width: `${eff * 100}%` } }),
          h("div", { class: "tau-min", style: { left: `calc(${min * 100}% - 1px)` } })),
        h("p", { class: "xsmall muted" }, "Red mark: stock minimum, enforced by invariant inv-tau-config-floor. You may raise τ, never lower it."))));
}

function branchesPanel(fork, gates) {
  const branches = (fork.branches || []).map((b) => (typeof b === "string" ? { name: b } : b));
  return h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", {}, "Branches"), h("p", {}, "Agents push to work branches; only the gate merges to main.")),
    h("div", { class: "panel-body stack" },
      h("ul", { class: "branch-list" }, branches.map((b) => h("li", {},
        h("span", { class: "branch-name grow" }, b.name),
        b.role ? h("span", { class: "tag" }, b.role) : null,
        b.gate ? statusTag(b.gate) : null,
        b.commit ? h("code", { class: "muted" }, short(b.commit)) : null))),
      gates.length ? h("div", {},
        h("h3", { class: "small", style: { marginBottom: "6px" } }, "Recent gate runs"),
        h("ul", { class: "branch-list" }, gates.slice(0, 4).map((g) => h("li", {},
          h("span", { class: "branch-name grow" }, g.ref),
          h("code", { class: "muted" }, short(g.commit)),
          ["invariant", "functional", "user"].map((t) => g.tiers?.[t] ? h("span", { class: `tag ${g.tiers[t].passed ? "pass" : "fail"}`, title: `${t} tier` }, `${t} ${g.tiers[t].total - g.tiers[t].failed}/${g.tiers[t].total}`) : null)))))
        : null));
}

function ledgerPanel(records, highlight) {
  const body = records.length
    ? h("div", { class: "table-wrap" }, h("table", { class: "data" },
        h("caption", { class: "visually-hidden" }, "Run-time intent records, newest first"),
        h("thead", {}, h("tr", {}, ["Time", "Answer", "Intent", "Confidence", "Signals", "Override", "Attestation", "Sources", "τ", "Fork commit", "Stock"].map((c) => h("th", { scope: "col" }, c)))),
        h("tbody", {}, records.map((r) => h("tr", { class: r.answer_id === highlight ? "hl" : "", id: `rec-${r.answer_id}` },
          h("td", {}, fmtTime(r.at)),
          h("td", {}, h("code", {}, r.answer_id)),
          h("td", {}, modeBadge(r.intent)),
          h("td", {}, fmtConf(r.confidence)),
          h("td", { class: "sigs" }, h("div", { class: "signals" }, (r.signals || []).map((s) => h("span", { class: "sig" }, s)))),
          h("td", {}, r.override ? MODE_LABEL[r.override] : "none"),
          h("td", {}, r.attestation === null || r.attestation === undefined ? "n/a" : String(r.attestation)),
          h("td", { class: "src" }, (r.sources || []).length ? r.sources.map((x) => h("span", {}, x)) : "none"),
          h("td", {}, typeof r.tau === "number" ? r.tau.toFixed(2) : "n/a"),
          h("td", {}, h("code", {}, r.fork_commit)),
          h("td", {}, h("code", {}, r.stock_tag)))))))
    : h("p", { class: "empty" }, "No answers yet. Ask a question in the workspace and its record appears here.");
  return h("section", { class: "panel wide" },
    h("div", { class: "panel-head" }, h("div", {}, h("h2", {}, "Run-time ledger"),
      h("p", {}, "One record per answer: the intent, why, any override or attestation, and the exact fork commit and stock tag. Buffered per user and committed daily to a ledger repository."))),
    h("div", { class: "panel-body" }, body));
}

function intentsPanel(intents) {
  return h("section", { class: "panel wide" },
    h("div", { class: "panel-head" }, h("div", {}, h("h2", {}, "Intent ledger"),
      h("p", {}, "Build-time records in .intent/, one per change, linked from each commit by an Intent-Id trailer. Agents read these to repair and upgrade code they did not write."))),
    h("div", { class: "panel-body intent-list" }, intents.length ? intents.map((r) => renderIntent(r)) : h("p", { class: "empty" }, "No intent records.")));
}


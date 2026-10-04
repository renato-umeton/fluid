// Yellow to green health of a fork's main: badge, soak progress, scenario
// list, failing step details, and history. Every change that lands on main
// is live in yellow until the end-to-end suite passes three times in a row;
// a failure rolls main back to the last green commit.
import { h, short, fmtTime } from "./dom.js";

export const HEALTH_LABEL = { green: "Green", yellow: "Yellow", rolled_back: "Rolled back" };
const TIER_LABEL = { stock: "Stock scenarios", platform: "Basic platform scenarios", user: "Your scenarios" };

/** The fleet grid color: yellow and rolled back show over an idle status (mirrors platform/src/yellow/state.ts). */
export function displayStatus(status, health) {
  const state = health?.health ?? "green";
  const idle = status === "pinned" || status === "passed";
  if (state === "yellow" && idle) return "yellow";
  if (state === "rolled_back" && (idle || status === "repair_open")) return "rolled_back";
  return status;
}

export function healthText(health) {
  if (!health) return "Green";
  if (health.health === "yellow") return health.runId ? `Yellow: soak pass ${Math.min(health.pass + 1, health.of)} of ${health.of}` : "Yellow: soak stopped";
  if (health.health === "rolled_back") return "Rolled back";
  return "Green";
}

/** Badge for the top bar, My fork, and the fleet detail. */
export function healthBadge(health, { onclick } = {}) {
  const state = health?.health ?? "green";
  const title = state === "yellow"
    ? `Live on main in yellow since ${fmtTime(health.since)}: the end-to-end suite has passed ${health.pass} of ${health.of} runs`
    : state === "rolled_back"
      ? `The last change failed the end-to-end suite and main was rolled back to ${short(health.lastGreenCommit)}`
      : health?.lastGreenCommit ? `Last green commit ${short(health.lastGreenCommit)}` : "No change has landed since the yellow soak started; main is green";
  const content = [h("span", { class: "health-dot", "aria-hidden": "true" }), healthText(health)];
  return onclick
    ? h("button", { type: "button", class: `health-badge h-${state}`, title, onclick }, content)
    : h("span", { class: `health-badge h-${state}`, title }, content);
}

/** Three segments: passed, running, waiting. */
export function soakProgress(pass, of, health) {
  const total = of || 3;
  return h("div", { class: "soak", role: "img", "aria-label": `Soak pass ${pass} of ${total} passed` },
    Array.from({ length: total }, (_, i) => h("span", { class: `soak-seg ${i < pass ? "done" : health === "yellow" && i === pass ? "run" : health === "rolled_back" && i === pass ? "fail" : ""}` })));
}

function scenarioRow(s) {
  const state = s.skipped ? "skip" : s.passed ? "pass" : "fail";
  const failed = s.steps?.find((st) => st.id === s.failedStep);
  return h("li", { class: `scenario s-${state}` },
    h("div", { class: "row" },
      h("span", { class: `tag ${state === "pass" ? "pass" : state === "fail" ? "fail" : ""}` }, state === "skip" ? "skipped" : state === "pass" ? "passed" : "failed"),
      h("code", { class: "grow" }, s.id),
      s.steps?.length ? h("span", { class: "xsmall muted" }, `${s.steps.length} step${s.steps.length === 1 ? "" : "s"}, ${Math.max(0, ...s.steps.map((st) => st.latencyMs || 0))} ms slowest`) : null),
    s.description ? h("p", { class: "xsmall muted" }, s.description) : null,
    s.skipped ? h("p", { class: "xsmall muted" }, s.skipped) : null,
    failed ? h("div", { class: "failure", style: { marginTop: "6px" } },
      h("header", {}, h("strong", {}, `Step ${failed.id} (${failed.kind})`), h("span", { class: "tag fail" }, "failing step")),
      h("dl", {}, (failed.failures || []).slice(0, 3).flatMap((f) => [
        h("dt", {}, "Path"), h("dd", {}, f.path || "result"),
        h("dt", {}, "Op"), h("dd", {}, f.op),
        h("dt", {}, "Expected"), h("dd", {}, JSON.stringify(f.expected)),
        h("dt", {}, "Actual"), h("dd", {}, JSON.stringify(f.actual)),
      ]))) : null);
}

/** Scenario list of one soak pass, grouped by tier. */
export function renderScenarios(pass) {
  if (!pass) return h("p", { class: "empty" }, "The first soak pass is running.");
  return h("div", { class: "stack" },
    h("p", { class: "small muted" }, `Pass ${pass.pass}${pass.stockTag ? ` at stock ${pass.stockTag}` : ""}${pass.runner === "bundled" ? " (this tag has no stock suite, so the basic platform scenarios ran)" : ""}, ${pass.durationMs} ms`),
    (pass.tiers || []).map((t) => h("section", { class: "stack", style: { gap: "6px" } },
      h("h4", { class: "small" }, `${TIER_LABEL[t.tier] ?? t.tier}: ${t.error ? "could not run" : `${t.total - t.skipped - t.failed} of ${t.total - t.skipped} passed`}`),
      t.error ? h("p", { class: "small", style: { color: "var(--fail)" } }, t.error) : null,
      t.rejected?.length ? h("p", { class: "xsmall muted" }, `Not run (a user scenario cannot reuse a stock id): ${t.rejected.map((r) => r.id).join(", ")}`) : null,
      t.disabled?.length ? h("p", { class: "xsmall muted" }, `Disabled and logged: ${t.disabled.map((d) => `${d.id} (${d.reason})`).join(", ")}`) : null,
      h("ul", { class: "scenario-list" }, (t.scenarios || []).map(scenarioRow)))));
}

function browserLine(browser) {
  if (!browser) return h("p", { class: "small muted" }, "Browser checks: run once per yellow period, after the first pass.");
  const cls = browser.status === "passed" ? "pass" : browser.status === "failed" ? "fail" : "";
  return h("div", { class: "stack", style: { gap: "4px" } },
    h("p", { class: "small" }, h("span", { class: `tag ${cls}` }, `browser ${browser.status}`), " ", browser.detail),
    browser.checks?.length ? h("ul", { class: "framing" }, browser.checks.map((c) => h("li", {}, `${c.passed ? "Passed" : "Failed"}: ${c.name}. ${c.detail}`))) : null);
}

/**
 * Health panel body: state, progress, last green commit, browser tier,
 * scenario list of the latest pass with failing step details, and history.
 */
export function renderHealth(health, run, history = []) {
  const state = health?.health ?? "green";
  const passes = run?.passes || [];
  const latest = passes.length ? [...passes].sort((a, b) => b.pass - a.pass)[0] : null;
  const failure = health?.failure ?? run?.failure ?? null;
  return h("div", { class: "stack" },
    h("div", { class: "row" }, healthBadge(health), soakProgress(health?.pass ?? 0, health?.of ?? 3, state),
      h("span", { class: "small muted grow" }, state === "yellow" ? "Live with a yellow badge while the end-to-end suite soaks." : state === "rolled_back" ? "main was moved back to the last green commit with a new commit; the failed change stays in history." : "Every change since the last green commit has passed its soak.")),
    h("dl", { class: "facts" },
      health?.commit ? [h("dt", {}, state === "rolled_back" ? "Revert commit" : state === "yellow" ? "Yellow commit" : "Green commit"), h("dd", {}, h("code", {}, short(health.commit)))] : null,
      h("dt", {}, "Last green"), h("dd", {}, health?.lastGreenCommit ? h("code", {}, short(health.lastGreenCommit)) : "the commit before the next change"),
      health?.rolledBackFrom ? [h("dt", {}, "Rolled back"), h("dd", {}, h("code", {}, short(health.rolledBackFrom)))] : null,
      health?.source ? [h("dt", {}, "Landed by"), h("dd", {}, health.source)] : null,
      run?.repairRunId ? [h("dt", {}, "Repair"), h("dd", {}, h("code", {}, run.repairRunId))] : null),
    failure ? h("div", { class: "explain", role: "status", style: { borderColor: "var(--fail)", background: "var(--fail-bg)" } },
      h("strong", {}, `Failed: ${failure.tier} scenario ${failure.scenario}${failure.step ? `, step ${failure.step}` : ""}. `), failure.detail) : null,
    browserLine(run?.browser ?? (health?.browser ? { ...health.browser, checks: [] } : null)),
    run ? renderScenarios(latest) : null,
    history.length ? h("details", { class: "ctx-json" }, h("summary", {}, "Health history"),
      h("ul", { class: "event-log" }, history.slice(0, 20).map((e) => h("li", {}, `${fmtTime(e.at)} ${e.event}${e.commit ? ` ${short(e.commit)}` : ""}: ${e.detail}`)))) : null);
}

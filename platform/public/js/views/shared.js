// Renderers shared by several views: intent records, run timelines, diffs, gate results.
import { api } from "../api.js";
import { h, fmtTime, mount } from "../dom.js";
import { wishesHeading } from "../fleet-summary.js";

/**
 * "Apply repair" control for a repair/<sha> branch. Applying gates the branch
 * in merge mode; main fast-forwards to it only if every tier passes.
 */
export function repairApply(repo, branch, { gatePassed = null } = {}) {
  const sha = /^repair\/([0-9a-f]{7})$/.exec(branch || "")?.[1];
  if (!repo || !sha) return null;
  const status = h("span", { class: "small muted", role: "status" },
    gatePassed === false ? "The proposed fix still fails its check; applying it will be refused by the gate." : "Applying runs the gate on this branch; main moves only if it passes.");
  const button = h("button", { type: "button", class: "btn btn-primary" }, `Apply ${branch}`);
  button.addEventListener("click", async () => {
    button.disabled = true;
    mount(status, "Starting the gate...");
    try {
      const { runId } = await api.applyRepair(repo, sha);
      for (let i = 0; i < 300; i++) {
        const run = await api.run(runId).catch(() => null);
        if (run && (run.status === "passed" || run.status === "failed")) {
          if (run.regateRunId) { mount(status, "main moved; gating the merge of main into the repair branch..."); await new Promise((r) => setTimeout(r, 1500)); continue; }
          mount(status, run.status === "passed" && run.mergedCommit ? `Applied: main is now ${String(run.mergedCommit).slice(0, 7)}.` : `Not applied: the gate ${run.status === "passed" ? "passed but main could not move" : "failed"} (${runId}).`);
          return;
        }
        mount(status, `Gate ${runId} is running...`);
        await new Promise((r) => setTimeout(r, 1500));
      }
      mount(status, `Still running; see run ${runId}.`);
    } catch (err) {
      mount(status, err.message);
      button.disabled = false;
    }
  });
  return h("div", { class: "row" }, button, status);
}

export function renderIntent(r, { related = false } = {}) {
  return h("article", { class: `intent-rec${related ? " related" : ""}`, "aria-label": `Intent record ${r.id}` },
    h("header", {},
      h("code", {}, r.id),
      h("span", {}, [r.author, r.agent ? `via ${r.agent}` : null, r.stock_tag ? `on ${r.stock_tag}` : null, r.commit ? `commit ${r.commit}` : null, r.repo ? `fork ${r.repo}` : null].filter(Boolean).join(", "))),
    h("p", { class: "req" }, r.request),
    r.purpose ? h("p", { class: "purpose" }, `Purpose: ${r.purpose}`) : null,
    h("div", { class: "row" },
      (r.modes_affected || []).map((m) => h("span", { class: `badge m-${m}`, style: { fontSize: "11px", padding: "1px 8px 1px 6px" } }, m)),
      h("div", { class: "file-list" }, (r.files || []).map((f) => h("code", {}, f)))),
    r.tests_added?.length ? h("p", { class: "xsmall muted" }, `Tests: ${r.tests_added.join(", ")}`) : null,
    r.replay?.kind ? h("p", { class: "xsmall muted" }, r.replay.kind === "model" ? "Replay: a model change; releases upgrade this fork by merge." : `Replay: a ${r.replay.kind} wish, granted again on fresh upstream code at each release.`) : null);
}

const WISH_TAG = { replayed: "pass", failed: "fail", fallback: "warn" };

/** Intent replay result of an upgrade: "Wishes carried to vX: N of N" and each wish with its status and reason. */
export function renderWishes(replay) {
  const heading = wishesHeading(replay);
  if (!heading) return null;
  return h("section", { class: "wishes", "aria-label": "Intent replay" },
    h("h3", { class: "small" }, heading),
    replay.wishes?.length ? h("ul", { class: "wish-list" }, replay.wishes.map((w) => h("li", {},
      h("div", { class: "row" },
        h("span", { class: `tag ${WISH_TAG[w.status] || ""}` }, w.status),
        h("code", {}, w.intentId),
        w.kind ? h("span", { class: "xsmall muted" }, w.kind === "model" ? "model change" : `${w.kind} wish`) : null),
      w.request ? h("p", { class: "small" }, w.request) : null,
      h("p", { class: "xsmall muted" }, w.reason),
      w.stockAlsoChanged?.length && replay.path === "replay"
        ? h("p", { class: "xsmall wish-note" }, `Upstream ${replay.tag} also changed ${w.stockAlsoChanged.join(", ")}. A merge would have had to resolve it; replay granted the wish again on the new code.`)
        : null)))
      : null);
}

export function renderTimeline(steps) {
  return h("ol", { class: "timeline" }, (steps || []).map((s, i) => h("li", { dataset: { status: s.status } },
    h("span", { class: "step-dot", "aria-hidden": "true" }, s.status === "done" ? "" : s.status === "failed" ? "!" : String(i + 1)),
    h("div", {},
      h("div", { class: "step-name" }, s.name, h("span", { class: "visually-hidden" }, `, ${s.status}`)),
      s.detail ? h("div", { class: "step-detail" }, s.detail) : null,
      s.finishedAt ? h("div", { class: "step-detail" }, fmtTime(s.finishedAt)) : null))));
}

export function renderDiff(diff) {
  if (!diff?.length) return h("p", { class: "empty" }, "No changes yet.");
  return h("ul", { class: "diff-list" }, diff.map((d) => h("li", {},
    h("span", { class: "diff-path" }, d.path, h("span", { class: "tag", style: { marginLeft: "8px" } }, d.status)),
    h("span", { class: "diff-stat" }, h("span", { class: "add" }, `+${d.additions ?? 0}`), " ", h("span", { class: "del" }, `-${d.deletions ?? 0}`)),
    d.summary ? h("span", { class: "diff-sum" }, d.summary) : null)));
}

const TIER_INFO = {
  invariant: ["Tier 1: invariants", "Owned by upstream, read at the pinned tag. Every sample must pass."],
  functional: ["Tier 2: functional", "Owned by upstream. A majority of samples must pass."],
  user: ["Tier 3: user tests", "Owned by you, in tests/user. Disabling one is logged."],
};

export function renderGate(gate) {
  if (!gate) return h("p", { class: "empty" }, "The gate runs after the change is pushed and the suggested tests are reviewed.");
  const failures = collectFailures(gate);
  return h("div", { class: "stack" },
    h("div", { class: `gate-verdict ${gate.passed ? "pass" : "fail"}`, role: "status" },
      gate.passed ? `Gate passed on ${gate.ref || "branch"} at ${String(gate.commit || "").slice(0, 7)}. The change can merge.`
        : `Gate failed on ${gate.ref || "branch"} at ${String(gate.commit || "").slice(0, 7)}. Merge is blocked.`),
    h("div", { class: "tiers" }, ["invariant", "functional", "user"].map((t) => {
      const r = gate.tiers?.[t];
      const [name, rule] = TIER_INFO[t];
      const state = !r ? "none" : r.passed ? "pass" : "fail";
      return h("div", { class: "tier", dataset: { state } },
        h("span", { class: "tier-name" }, name),
        h("span", { class: "tier-score" }, r ? `${r.total - r.failed} / ${r.total}` : "not run"),
        h("span", { class: "tier-rule" }, rule));
    })),
    failures.length ? h("div", { class: "stack" }, h("h3", { class: "small" }, "Failing probes"), failures.map(renderFailure)) : null);
}

/** Accepts gate.failures[] or per-tier probe results with failures[] (runner shape). */
function collectFailures(gate) {
  if (Array.isArray(gate.failures) && gate.failures.length) return gate.failures;
  const out = [];
  for (const [tier, r] of Object.entries(gate.tiers || {})) {
    for (const p of r?.probes || []) {
      if (p.passed) continue;
      for (const f of p.failures || []) out.push({ tier, probe: p.id, description: p.description, samples: p.samples, ...f });
    }
  }
  return out;
}

function renderFailure(f) {
  const fmt = (v) => (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v));
  return h("article", { class: "failure" },
    h("header", {}, h("strong", {}, h("code", {}, f.probe || f.probeId || f.id || "probe")), h("span", { class: "tag fail" }, f.tier || "failed")),
    f.description ? h("p", { class: "small", style: { padding: "8px 12px 0" } }, f.description) : null,
    h("dl", {},
      h("dt", {}, "Sample"), h("dd", {}, f.samples ? `${f.sample} of ${f.samples}` : String(f.sample ?? "n/a")),
      f.file ? [h("dt", {}, "File"), h("dd", {}, f.file)] : null,
      h("dt", {}, "Path"), h("dd", {}, f.path ?? ""),
      h("dt", {}, "Op"), h("dd", {}, f.op ?? ""),
      h("dt", {}, "Expected"), h("dd", {}, fmt(f.expected)),
      h("dt", {}, "Actual"), h("dd", {}, fmt(f.actual))));
}

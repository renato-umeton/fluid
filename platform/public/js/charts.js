// Chart widgets for fork-owned tabs (ui/preferences.json). The platform
// computes the data over the user's own ledger, intents, and gates
// (GET /api/me/charts); this module draws plain inline SVG with s() and
// h(), never innerHTML. Colors come from CSS variables, so charts follow the
// light and dark themes. Every chart has a title, a text summary, a legend
// for more than one series, a native tooltip per mark, and a data table.
import { h, s, MODE_LABEL, fmtTime } from "./dom.js";
import { WIDGET_LABELS } from "./ui-prefs.js";

const INTENTS = ["clinical", "research", "administrative", "multi"];
const W = 360;
const PAD = { top: 10, right: 8, bottom: 24, left: 30 };
let uid = 0;

export function renderWidget(widget, data) {
  const draw = WIDGETS[widget];
  if (!draw) return null;
  return draw(data);
}

const WIDGETS = {
  "answers-by-intent": (d) => {
    const rows = d.answersByIntent || [];
    if (!rows.length) return figure("answers-by-intent", "No answers in your run-time ledger yet. Ask a question in the Workspace and it appears here.", null);
    const total = rows.reduce((n, r) => n + sum(r), 0);
    const svg = stackedColumns(rows.map((r) => ({ label: r.day.slice(5), title: r.day, values: r })), "Answers");
    const summary = `${total} answer${total === 1 ? "" : "s"} over ${rows.length} day${rows.length === 1 ? "" : "s"}. ${INTENTS.map((k) => `${MODE_LABEL[k]} ${rows.reduce((n, r) => n + (r[k] || 0), 0)}`).join(", ")}.`;
    return figure("answers-by-intent", summary, svg, legend(INTENTS), table(["Day", ...INTENTS.map((k) => MODE_LABEL[k])], rows.map((r) => [r.day, ...INTENTS.map((k) => r[k] || 0)])));
  },

  "confidence-distribution": (d) => {
    const bins = d.confidence || [];
    const total = bins.reduce((n, b) => n + sum(b), 0);
    if (!total) return figure("confidence-distribution", "No answers yet, so there is no confidence to show.", null);
    const svg = stackedColumns(bins.map((b) => ({ label: b.from === 0 || b.from === 0.5 || b.from === 0.9 ? b.from.toFixed(1) : "", title: `confidence ${b.from.toFixed(1)} to ${b.to.toFixed(1)}`, values: b })), "Answers");
    const high = bins.filter((b) => b.from >= 0.8).reduce((n, b) => n + sum(b), 0);
    return figure("confidence-distribution", `${total} answers; ${high} (${pct(high, total)}) at confidence 0.8 or higher.`, svg, legend(INTENTS),
      table(["Confidence", ...INTENTS.map((k) => MODE_LABEL[k])], bins.map((b) => [`${b.from.toFixed(1)} to ${b.to.toFixed(1)}`, ...INTENTS.map((k) => b[k] || 0)])));
  },

  "override-rate": (d) => {
    const o = d.overrides || { total: 0, overridden: 0, byIntent: {} };
    if (!o.total) return figure("override-rate", "No answers yet, so nothing has been overridden.", null);
    const rows = INTENTS.filter((k) => o.byIntent?.[k]?.total);
    const rowH = 26;
    const height = rows.length * rowH + 6;
    const left = 96;
    const width = W - left - 60;
    const svg = chartSvg(height, "Override rate by intent", rows.map((k, i) => {
      const { total, overridden } = o.byIntent[k];
      const y = i * rowH + 4;
      const filled = total ? (overridden / total) * width : 0;
      return s("g", {},
        s("text", { x: left - 8, y: y + 13, "text-anchor": "end" }, MODE_LABEL[k]),
        s("rect", { class: "vm-track", x: left, y, width, height: 18, rx: 4 }),
        filled > 0 ? s("rect", { class: `vm-${k}`, x: left, y, width: Math.max(filled, 4), height: 18, rx: 4, "data-hit": "" }, s("title", {}, `${MODE_LABEL[k]}: ${overridden} of ${total} overridden (${pct(overridden, total)})`)) : null,
        s("text", { class: "viz-value", x: left + width + 8, y: y + 13 }, pct(overridden, total)));
    }));
    return figure("override-rate", `${o.overridden} of ${o.total} answers overridden (${pct(o.overridden, o.total)}).`,
      h("div", { class: "stack", style: { gap: "6px" } }, h("div", { class: "viz-stat", "aria-hidden": "true" }, pct(o.overridden, o.total)), svg), null,
      table(["Intent", "Overridden", "Answers"], rows.map((k) => [MODE_LABEL[k], o.byIntent[k].overridden, o.byIntent[k].total])));
  },

  "sources-by-kind": (d) => {
    const rows = d.sourcesByKind || [];
    if (!rows.length) return figure("sources-by-kind", "No cited sources yet.", null);
    const max = Math.max(...rows.map((r) => r.count));
    const rowH = 24;
    const left = 96;
    const width = W - left - 40;
    const svg = chartSvg(rows.length * rowH + 4, "Sources cited by kind", rows.map((r, i) => {
      const y = i * rowH + 3;
      return s("g", {},
        s("text", { x: left - 8, y: y + 12, "text-anchor": "end" }, r.kind),
        s("rect", { class: "vm-link", x: left, y, width: Math.max(4, (r.count / max) * width), height: 16, rx: 4, "data-hit": "" }, s("title", {}, `${r.kind}: ${r.count} citation${r.count === 1 ? "" : "s"}`)),
        s("text", { class: "viz-value", x: left + Math.max(4, (r.count / max) * width) + 6, y: y + 12 }, String(r.count)));
    }));
    const total = rows.reduce((n, r) => n + r.count, 0);
    return figure("sources-by-kind", `${total} citations; most from ${rows[0].kind} (${rows[0].count}).`, svg, null, table(["Kind", "Citations"], rows.map((r) => [r.kind, r.count])));
  },

  "intent-timeline": (d) => {
    const rows = (d.intentTimeline || []).filter((r) => r.at);
    if (!rows.length) return figure("intent-timeline", "No dated build-time intent records.", null);
    const times = rows.map((r) => Date.parse(r.at));
    const min = Math.min(...times);
    const max = Math.max(...times);
    const span = max - min || 1;
    const x0 = 16;
    const x1 = W - 16;
    const y = 30;
    const svg = chartSvg(56, "Build-time intent records over time", [
      s("line", { class: "vm-line", x1: x0, x2: x1, y1: y, y2: y }),
      rows.map((r, i) => s("circle", { class: r.agent === "customization-agent" ? "vm-link vm-dot" : "vm-multi vm-dot", cx: x0 + ((times[i] - min) / span) * (x1 - x0), cy: y, r: 6, "data-hit": "" },
        s("title", {}, `${r.at.slice(0, 10)} ${r.agent}: ${r.request}`))),
      s("text", { x: x0, y: 52 }, rows[0].at.slice(0, 10)),
      rows.length > 1 ? s("text", { x: x1, y: 52, "text-anchor": "end" }, rows[rows.length - 1].at.slice(0, 10)) : null,
    ]);
    const latest = rows[rows.length - 1];
    return figure("intent-timeline", `${rows.length} build-time records; latest ${latest.at.slice(0, 10)}: ${latest.request}`, svg,
      h("ul", { class: "viz-legend" }, h("li", {}, h("i", { style: { background: "var(--link)" } }), "Customization"), h("li", {}, h("i", { class: "lg-multi" }), "Onboarding, stock, or other")),
      table(["Date", "Agent", "Request", "Files"], rows.slice().reverse().map((r) => [r.at.slice(0, 10), r.agent, r.request, r.files])));
  },

  "gate-history": (d) => {
    const rows = d.gateHistory || [];
    if (!rows.length) return figure("gate-history", "No gate runs yet.", null);
    const n = rows.length;
    const plotH = 100;
    const slot = (W - PAD.left - PAD.right) / Math.max(n, 6);
    const barW = Math.max(6, Math.min(22, slot - 2));
    const ratio = (g) => {
      const t = Object.values(g.tiers || {});
      const total = t.reduce((a, x) => a + x.total, 0);
      return total ? t.reduce((a, x) => a + x.passed, 0) / total : g.passed ? 1 : 0;
    };
    const svg = chartSvg(plotH + PAD.top + PAD.bottom, "Gate results history", [
      gridLines(plotH, [0, 0.5, 1], (v) => `${Math.round(v * 100)}%`),
      rows.map((g, i) => {
        const r = ratio(g);
        const hgt = Math.max(4, r * plotH);
        const x = PAD.left + i * slot + (slot - barW) / 2;
        const tiers = Object.entries(g.tiers || {}).map(([t, v]) => `${t} ${v.passed}/${v.total}`).join(", ");
        return s("g", {},
          s("rect", { class: g.passed ? "vm-pass" : "vm-fail", x, y: PAD.top + plotH - hgt, width: barW, height: hgt, rx: 3, "data-hit": "" },
            s("title", {}, `${g.passed ? "Passed" : "Failed"} ${fmtTime(g.at)} ${g.ref} ${String(g.commit).slice(0, 7)}: ${tiers}`)),
          s("text", { x: x + barW / 2, y: PAD.top + plotH + 14, "text-anchor": "middle" }, g.passed ? "pass" : "fail"));
      }),
    ]);
    const passed = rows.filter((g) => g.passed).length;
    return figure("gate-history", `${passed} of ${n} gate runs passed; the last one ${rows[n - 1].passed ? "passed" : "failed"}. Bar height is the share of probes that passed.`, svg,
      h("ul", { class: "viz-legend" }, h("li", {}, h("i", { class: "lg-pass" }), "Passed"), h("li", {}, h("i", { class: "lg-fail" }), "Failed")),
      table(["When", "Branch", "Result", "Tiers"], rows.slice().reverse().map((g) => [new Date(g.at).toLocaleString(), g.ref, g.passed ? "passed" : "failed", Object.entries(g.tiers || {}).map(([t, v]) => `${t} ${v.passed}/${v.total}`).join(", ")])));
  },
};

function sum(row) {
  return INTENTS.reduce((n, k) => n + (row[k] || 0), 0);
}

function pct(a, b) {
  return b ? `${Math.round((a / b) * 100)}%` : "0%";
}

function chartSvg(height, label, children) {
  const id = `viz-${++uid}`;
  return s("svg", { viewBox: `0 0 ${W} ${height}`, role: "img", "aria-labelledby": `${id}-t`, focusable: "false" },
    s("title", { id: `${id}-t` }, label), children);
}

function gridLines(plotH, ticks, fmt) {
  return ticks.map((t) => {
    const y = PAD.top + plotH - t * plotH;
    return s("g", {},
      s("line", { class: t === 0 ? "viz-axis" : "viz-grid", x1: PAD.left, x2: W - PAD.right, y1: y, y2: y }),
      s("text", { x: PAD.left - 4, y: y + 4, "text-anchor": "end" }, fmt(t)));
  });
}

/** Stacked columns by intent, with a 2px gap between segments. */
function stackedColumns(columns, unit) {
  const plotH = 120;
  const max = Math.max(1, ...columns.map((c) => sum(c.values)));
  const top = niceMax(max);
  const slot = (W - PAD.left - PAD.right) / columns.length;
  const barW = Math.max(4, Math.min(28, slot - 4));
  const gap = 2;
  return chartSvg(plotH + PAD.top + PAD.bottom, `${unit} by intent`, [
    gridLines(plotH, [0, 0.5, 1], (t) => String(Math.round(t * top))),
    columns.map((c, i) => {
      const x = PAD.left + i * slot + (slot - barW) / 2;
      let y = PAD.top + plotH;
      const segs = INTENTS.filter((k) => c.values[k] > 0).map((k) => {
        const hgt = (c.values[k] / top) * plotH;
        y -= hgt;
        const rect = s("rect", { class: `vm-${k}`, x, y: y + gap / 2, width: barW, height: Math.max(1, hgt - gap), rx: 2, "data-hit": "" }, s("title", {}, `${c.title}: ${MODE_LABEL[k]} ${c.values[k]}`));
        return rect;
      });
      return s("g", {}, segs, c.label ? s("text", { x: x + barW / 2, y: PAD.top + plotH + 14, "text-anchor": "middle" }, c.label) : null);
    }),
  ]);
}

function niceMax(n) {
  if (n <= 4) return 4;
  const step = Math.pow(10, Math.floor(Math.log10(n)));
  return Math.ceil(n / step) * step;
}

function legend(keys) {
  return h("ul", { class: "viz-legend" }, keys.map((k) => h("li", {}, h("i", { class: `lg-${k}` }), MODE_LABEL[k] || k)));
}

function table(head, rows) {
  return h("details", {},
    h("summary", {}, "Show data as a table"),
    h("div", { class: "table-wrap" }, h("table", { class: "data" },
      h("thead", {}, h("tr", {}, head.map((c) => h("th", { scope: "col" }, c)))),
      h("tbody", {}, rows.map((r) => h("tr", {}, r.map((v) => h("td", {}, String(v)))))))));
}

function figure(widget, summary, chart, legendEl = null, tableEl = null) {
  return h("figure", { class: "viz panel", dataset: { widget } },
    h("div", { class: "panel-head" }, h("h2", {}, WIDGET_LABELS[widget])),
    h("div", { class: "panel-body stack", style: { gap: "8px" } },
      h("figcaption", {}, summary),
      chart,
      legendEl, tableEl));
}

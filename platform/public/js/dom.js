// Small DOM helpers. h() builds elements; text is always set as text, never HTML.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export const MODES = ["clinical", "research", "administrative"];
export const MODE_LABEL = { clinical: "Clinical", research: "Research", administrative: "Administrative", multi: "Multi-intent" };

export function fmtConf(n) {
  return typeof n === "number" ? n.toFixed(2) : "n/a";
}

export function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function short(sha) {
  return typeof sha === "string" ? sha.slice(0, 7) : "";
}

export function json(value) {
  return JSON.stringify(value, null, 2);
}

/** Tri-color distribution bar with a tau marker. */
export function intentStrip(distribution, tau) {
  const dist = distribution || {};
  const bar = h("div", { class: "strip-bar", role: "img", "aria-label": stripLabel(dist, tau) },
    MODES.map((m) => h("span", { class: `strip-seg m-${m}`, style: { width: `${Math.max(0, (dist[m] || 0) * 100)}%` } })),
    typeof tau === "number" ? h("span", { class: "strip-tau", style: { left: `calc(${tau * 100}% - 1px)` } }, h("span", {}, `τ ${tau.toFixed(2)}`)) : null,
  );
  const legend = h("div", { class: "strip-legend", "aria-hidden": "true" },
    MODES.map((m) => h("span", {}, h("i", { style: { background: `var(--${m})` } }), `${MODE_LABEL[m]} `, h("b", {}, fmtConf(dist[m])))),
  );
  return h("div", { class: "strip" }, bar, legend);
}

function stripLabel(dist, tau) {
  const parts = MODES.map((m) => `${MODE_LABEL[m]} ${fmtConf(dist[m])}`);
  return `Intent distribution: ${parts.join(", ")}${typeof tau === "number" ? `. Threshold ${tau.toFixed(2)}` : ""}`;
}

export function miniStrip(distribution) {
  const dist = distribution || {};
  return h("span", { class: "mini-strip", "aria-hidden": "true" },
    MODES.map((m) => h("span", { class: `m-${m}`, style: { width: `${(dist[m] || 0) * 100}%` } })));
}

export function modeBadge(mode) {
  return h("span", { class: `badge m-${mode}` }, MODE_LABEL[mode] || mode);
}

export function statusTag(status) {
  const map = { passed: "pass", done: "pass", failed: "fail", repair_open: "warn", waiting: "warn", running: "run", upgrading: "run", gating: "run" };
  const label = { repair_open: "repair open" }[status] || status;
  return h("span", { class: `tag ${map[status] || ""}` }, label);
}

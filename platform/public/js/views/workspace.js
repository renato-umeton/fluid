// Workspace: context simulator plus chat with answer cards.
import { api } from "../api.js";
import { h, mount, MODE_LABEL } from "../dom.js";
import { renderCard } from "../card.js";
import { SYNTHETIC } from "../synthetic.js";

export const title = "Workspace";
export const sub = (app) => `${app.persona.role}, ${app.persona.department}. ${app.persona.story}`;

const DAY = "2026-10-03";
const SPEC_QUESTION = "What is the right dose of Morphinex for a patient of 70 kg and 45 years?";
const QUICK = [
  SPEC_QUESTION,
  "What is the right dose of Morphinex for a patient of 70 kg and 78 years?",
  "What dose of Morphinex should I use for this patient?",
  "Is Morphinex on formulary?",
];
const SCREEN_LABELS = [
  ["", "No screen signal"],
  ["ehr_chart", "EHR chart view"],
  ["order_entry", "Order entry"],
  ["manuscript_editor", "Manuscript editor"],
  ["reference_manager", "Reference manager"],
  ["irb_portal", "IRB portal"],
  ["statistics_package", "Statistics package"],
  ["budget_spreadsheet", "Spreadsheet with budget structure"],
  ["formulary_review", "Formulary review"],
  ["unknown", "Unrecognized screen"],
];

const PRESETS = {
  "hospitalist-researcher": [
    { name: "At the bedside", ctx: { clock: 540, chart: "synthetic_patient_117", orderEntry: false, doc: "", screen: "ehr_chart", conf: 0.94 } },
    { name: "Writing the manuscript", ctx: { clock: 900, chart: "", orderEntry: false, doc: "doc-manuscript-morphinex-older-adults", screen: "manuscript_editor", conf: 0.91 } },
    { name: "Ambiguous screen", ctx: { clock: 810, chart: "", orderEntry: false, doc: "", screen: "unknown", conf: 0.4 } },
    { name: "On service, draft open", ctx: { clock: 660, chart: "", orderEntry: false, doc: "doc-manuscript-morphinex-older-adults", screen: "", conf: 0.5 } },
  ],
  "research-coordinator": [
    { name: "IRB portal", ctx: { clock: 810, chart: "", orderEntry: false, doc: "doc-irb-2026-0142", screen: "irb_portal", conf: 0.88 } },
    { name: "Ambiguous screen", ctx: { clock: 720, chart: "", orderEntry: false, doc: "", screen: "unknown", conf: 0.4 } },
  ],
  "department-administrator": [
    { name: "Budget review", ctx: { clock: 570, chart: "", orderEntry: false, doc: "doc-budget-fy27-pharmacy", screen: "budget_spreadsheet", conf: 0.9 } },
    { name: "Formulary prep", ctx: { clock: 810, chart: "", orderEntry: false, doc: "", screen: "formulary_review", conf: 0.86 } },
  ],
};

const sessions = new Map(); // persona id -> { ctx, thread }

function sessionFor(persona) {
  if (!sessions.has(persona.id)) {
    sessions.set(persona.id, { ctx: { clock: 600, chart: "", orderEntry: false, doc: "", screen: "", conf: 0.8 }, thread: [] });
  }
  return sessions.get(persona.id);
}

const patients = SYNTHETIC.patients.bundles.map((b) => {
  const res = b.entry.map((e) => e.resource);
  const p = res.find((r) => r.resourceType === "Patient");
  const w = res.find((r) => r.resourceType === "Observation" && r.code?.coding?.[0]?.code === "29463-7");
  const enc = res.find((r) => r.resourceType === "Encounter");
  const cond = res.filter((r) => r.resourceType === "Condition").map((r) => r.code?.coding?.[0]?.display).filter(Boolean);
  const age = Math.floor((Date.parse(SYNTHETIC.patients.referenceDate) - Date.parse(p.birthDate)) / (365.25 * 86400000));
  return {
    id: p.id, mrn: p.identifier?.[0]?.value, name: `${p.name[0].given[0].replace(/\d+/g, "")} ${p.name[0].family.replace(/\d+/g, "")}`,
    age, weight: w?.valueQuantity ? `${w.valueQuantity.value} ${w.valueQuantity.unit}` : "not recorded",
    location: enc?.location?.[0]?.location?.display ?? "", conditions: cond,
  };
});

function at(clock) {
  const hh = String(Math.floor(clock / 60)).padStart(2, "0");
  const mm = String(clock % 60).padStart(2, "0");
  return { label: `${hh}:${mm}`, iso: `${DAY}T${hh}:${mm}:00-04:00` };
}

function schedule(personaId, clock) {
  const t = Date.parse(at(clock).iso);
  const inside = (x) => x.personaId === personaId && Date.parse(x.start) <= t && t < Date.parse(x.end);
  return {
    shift: SYNTHETIC.callSchedule.shifts.find(inside) ?? null,
    event: SYNTHETIC.calendars.events.find(inside) ?? null,
  };
}

function hhmm(iso) {
  return iso.slice(11, 16);
}

function contextSignals(persona, ctx) {
  const { shift, event } = schedule(persona.id, ctx.clock);
  const doc = SYNTHETIC.documents.documents.find((d) => d.id === ctx.doc);
  return {
    chartOpen: ctx.chart ? { patientId: ctx.chart, identified: true } : null,
    orderEntryActive: Boolean(ctx.orderEntry),
    onService: Boolean(shift),
    documentType: doc?.type ?? null,
    calendarEvent: event?.title ?? null,
    screenLabel: ctx.screen ? { label: ctx.screen, confidence: Number(ctx.conf) } : null,
  };
}

let current = null; // { root, app, session }

export function render(root, app) {
  const session = sessionFor(app.persona);
  current = { root, app, session };
  mount(root, h("div", { class: "workspace" }, contextPanel(), chatPanel()));
  renderThread();
}

// ---------- context simulator ----------

function contextPanel() {
  const { app, session } = current;
  const ctx = session.ctx;
  const persona = app.persona;
  const panel = h("aside", { class: "panel context-panel", "aria-label": "Context simulator" });
  const update = (patch) => { Object.assign(ctx, patch); refreshContext(); };

  const docs = SYNTHETIC.documents.documents.filter((d) => persona.documents?.includes(d.id));
  const clockOut = h("output", { id: "clock-out", for: "clock" }, at(ctx.clock).label);
  const derived = h("div", { id: "derived" });
  const chartInfo = h("div", { id: "chart-info" });
  const json = h("pre", { id: "ctx-json" });
  const confOut = h("output", { for: "screen-conf" }, Number(ctx.conf).toFixed(2));

  panel.append(
    h("div", { class: "panel-head" }, h("div", {}, h("h2", {}, "Context simulator"), h("p", {}, "What the assistant can observe right now. All synthetic."))),
    h("div", { class: "ctx-section" },
      h("h3", {}, "Scenes"),
      h("div", { class: "preset-list" }, (PRESETS[persona.id] || []).map((p) => h("button", {
        type: "button", class: "btn", onclick: () => { Object.assign(ctx, p.ctx); render(current.root, app); },
      }, p.name)))),
    h("div", { class: "ctx-section" },
      h("h3", {}, h("label", { for: "clock" }, "Clock, Oct 3"), h("span", { class: "layer" }, "Schedule and calendar")),
      h("div", { class: "clock" }, clockOut, h("span", { class: "small muted" }, "America/New_York")),
      h("input", { type: "range", id: "clock", min: 360, max: 1080, step: 15, value: ctx.clock, "aria-valuetext": at(ctx.clock).label,
        oninput: (e) => update({ clock: Number(e.target.value) }) }),
      derived),
    h("div", { class: "ctx-section" },
      h("h3", {}, h("label", { for: "chart" }, "Patient chart"), h("span", { class: "layer" }, "Hard context")),
      h("select", { id: "chart", onchange: (e) => update({ chart: e.target.value }) },
        h("option", { value: "" }, "No chart open"),
        patients.map((p) => h("option", { value: p.id, selected: p.id === ctx.chart }, `${p.name}, ${p.age} y, ${p.mrn}`))),
      chartInfo,
      h("label", { class: "toggle-row" }, h("span", {}, "Order entry in progress"),
        h("input", { type: "checkbox", checked: ctx.orderEntry, onchange: (e) => update({ orderEntry: e.target.checked }) }))),
    h("div", { class: "ctx-section" },
      h("h3", {}, h("label", { for: "doc" }, "Active document"), h("span", { class: "layer" }, "Soft context")),
      h("select", { id: "doc", onchange: (e) => update({ doc: e.target.value }) },
        h("option", { value: "" }, "None"),
        docs.map((d) => h("option", { value: d.id, selected: d.id === ctx.doc }, `${d.type}: ${d.title}`)))),
    h("div", { class: "ctx-section" },
      h("h3", {}, h("label", { for: "screen" }, "Screen label"), h("span", { class: "layer" }, "Soft context")),
      h("select", { id: "screen", onchange: (e) => update({ screen: e.target.value }) },
        SCREEN_LABELS.map(([v, l]) => h("option", { value: v, selected: v === ctx.screen }, l))),
      h("div", { class: "row" },
        h("label", { for: "screen-conf", class: "small muted" }, "Classifier confidence"), confOut),
      h("input", { type: "range", id: "screen-conf", min: 0, max: 1, step: 0.01, value: ctx.conf,
        oninput: (e) => { confOut.textContent = Number(e.target.value).toFixed(2); update({ conf: Number(e.target.value) }); } }),
      h("p", { class: "xsmall muted" }, "Only the label and confidence are kept; the screen image is discarded after classification.")),
    h("div", { class: "ctx-section" },
      h("details", { class: "ctx-json" }, h("summary", {}, "Context sent with each question"), json)),
  );
  queueMicrotask(refreshContext);
  return panel;
}

function refreshContext() {
  const { app, session, root } = current;
  const ctx = session.ctx;
  const { shift, event } = schedule(app.persona.id, ctx.clock);
  const clock = root.querySelector("#clock-out");
  if (!clock) return;
  clock.textContent = at(ctx.clock).label;
  root.querySelector("#clock").setAttribute("aria-valuetext", at(ctx.clock).label);
  mount(root.querySelector("#derived"),
    h("div", { class: `derived${shift ? " on" : ""}` },
      shift ? `On service: ${shift.service}, ${shift.role} until ${hhmm(shift.end)}` : "Off service per call schedule"),
    h("div", { class: "derived", style: { marginTop: "6px" } },
      event ? `Calendar: ${event.title} (${hhmm(event.start)} to ${hhmm(event.end)})` : "Calendar: no event now"));
  const p = patients.find((x) => x.id === ctx.chart);
  mount(root.querySelector("#chart-info"), p
    ? h("div", { class: "chart-card" }, h("strong", {}, `${p.name} (synthetic)`), h("div", {}, `${p.age} years, ${p.weight}, ${p.location}`), h("div", { class: "xsmall muted" }, p.conditions.join("; ")))
    : null);
  root.querySelector("#ctx-json").textContent = JSON.stringify(contextSignals(app.persona, ctx), null, 2);
}

// ---------- chat ----------

function chatPanel() {
  const input = h("textarea", { id: "question", rows: 1, placeholder: "Ask a question", "aria-label": "Question",
    onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } } });
  const form = h("form", { onsubmit: (e) => { e.preventDefault(); const q = input.value.trim(); if (q) { input.value = ""; ask(q); } } },
    input, h("button", { class: "btn btn-primary", type: "submit" }, "Ask"));
  return h("div", { class: "chat" },
    h("div", { class: "thread", id: "thread", "aria-live": "polite" }),
    h("div", { class: "composer" },
      h("div", { class: "quick", role: "group", "aria-label": "Example questions" },
        QUICK.map((q) => h("button", { type: "button", class: "btn", onclick: () => ask(q) }, q))),
      form));
}

function renderThread() {
  const { session, root, app } = current;
  const el = root.querySelector("#thread");
  if (!session.thread.length) {
    mount(el, h("div", { class: "thread-empty" },
      h("h2", {}, "Same question, different job. Fluid asks which one you are doing."),
      h("p", {}, `Set the context on the left, or pick a scene, then ask. Each answer comes from your own fork, ${app.fork.repo}, and writes a record to your run-time ledger.`)));
    return;
  }
  mount(el, session.thread.map((item) => [
    h("div", { class: "q-bubble" }, item.question),
    h("div", { class: "q-meta" }, item.note ?? describeContext(item.context)),
    item.pending ? h("div", { class: "thinking" }, "Classifying intent and answering from your fork...")
      : item.error ? h("div", { class: "card-error", role: "alert" }, item.error)
      : renderCard(item.card, cardOpts(item)),
  ]));
  const bubbles = el.querySelectorAll(".q-bubble");
  bubbles[bubbles.length - 1]?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function describeContext(c) {
  const parts = [];
  if (c.chartOpen) parts.push(`chart ${c.chartOpen.patientId}`);
  if (c.orderEntryActive) parts.push("order entry");
  if (c.onService) parts.push("on service");
  if (c.documentType) parts.push(`${c.documentType} open`);
  if (c.screenLabel) parts.push(`screen ${c.screenLabel.label} ${c.screenLabel.confidence.toFixed(2)}`);
  return parts.length ? `Context: ${parts.join(", ")}` : "No context signals";
}

function cardOpts(item) {
  return {
    tau: current.app.effectiveTau(),
    onOverride: (card, mode) => overrideTo(item, card, mode),
    onAttest: (card) => attest(item, card),
    ledgerHref: (id) => `#fork?answer=${encodeURIComponent(id)}`,
  };
}

async function ask(question, extra = {}, note) {
  const { app, session } = current;
  const context = extra.context ?? contextSignals(app.persona, session.ctx);
  const item = { question, context, pending: true, note, extra };
  session.thread.push(item);
  renderThread();
  try {
    item.card = await api.ask({ repo: app.fork.repo, question, context, explicitMode: extra.explicitMode, attestation: extra.attestation });
  } catch (err) {
    item.error = `The fork could not answer: ${err.message}`;
  }
  item.pending = false;
  if (current.session === session) renderThread();
  if (item.card?.requires_attestation && !extra.attestation && extra.explicitMode) attest(item, item.card);
  return item;
}

async function overrideTo(item, card, mode) {
  try {
    await api.override(card.ledger?.answer_id ?? card.answer_id, mode);
  } catch (err) {
    console.warn("Fluid: override record not stored", err);
  }
  await ask(item.question, { context: item.context, explicitMode: mode }, `Answer again as ${MODE_LABEL[mode]}; override logged on ${card.answer_id}`);
}

function attest(item, card) {
  const dialog = document.getElementById("attest-dialog");
  dialog.returnValue = "";
  dialog.onclose = () => {
    if (dialog.returnValue !== "confirm") return;
    ask(item.question, { context: item.context, explicitMode: card.mode === "multi" ? "research" : card.mode, attestation: true },
      "Attested: not making a decision for a patient right now");
  };
  dialog.showModal();
  dialog.querySelector("#attest-confirm").focus();
}

// Answer card renderer. Every card shows: intent badge, confidence, the
// distribution against tau, signals, sources with kind, framing lines, the
// computed dose only when present, the override control, alternatives, the
// held state when attestation is required, and its run-time ledger record.
import { h, MODES, MODE_LABEL, fmtConf, intentStrip, modeBadge } from "./dom.js";

const HARD = /^(chart_open|chart_open_deidentified|order_entry|on_service)[:]/;
const SOFT = /^(document|calendar|screen)[:]/;

export function signalLayer(signal) {
  if (signal.startsWith("explicit:")) return "explicit";
  if (HARD.test(signal)) return "hard";
  if (SOFT.test(signal)) return "soft";
  return "conversation";
}

/**
 * @param card AnswerCard from POST /api/ask
 * @param opts { tau, onOverride(card, mode), onAttest(card), ledgerHref(answerId), nested }
 */
export function renderCard(card, opts) {
  return h("article", { class: `card${opts.nested ? " nested" : ""}`, dataset: { mode: card.mode }, "aria-label": `${MODE_LABEL[card.mode]} answer` },
    header(card, opts),
    h("div", { class: "card-strip" }, intentStrip(card.distribution, typeof card.tau === "number" ? card.tau : opts.tau)),
    safetyNote(card),
    h("div", { class: "card-body" }, card.body),
    card.computed_dose ? dose(card.computed_dose) : null,
    card.requires_attestation ? held(card, opts) : null,
    details(card),
    card.mode === "multi" && card.alternatives?.length ? alternatives(card, opts) : null,
    footer(card, opts),
  );
}

/** Shown when the platform answered with stock instead of the fork's code (safety fallback or clinical dose guard). */
function safetyNote(card) {
  const signal = (card.signals || []).find((s) => s.startsWith("safety_fallback:") || s.startsWith("safety_guard:"));
  if (!signal) return null;
  const served = card.fork?.servedBy;
  const text = signal.startsWith("safety_fallback:")
    ? `Upstream mode: answered by upstream ${served?.ref || ""} because a safety release's grace period ended while this fork still fails it.`
    : `Safety guard: this fork's answer computed a clinical dose, so upstream ${served?.ref || ""} answered instead.`;
  return h("div", { class: "safety-note", role: "status" }, h("strong", {}, signal), " ", text);
}

function header(card, opts) {
  const current = card.mode === "multi" ? null : card.mode;
  const group = h("div", { class: "override", role: "group", "aria-label": "Answer in a different mode" },
    MODES.map((m) => h("button", {
      type: "button", dataset: { m }, "aria-pressed": String(m === current),
      title: m === current ? `Answered in ${MODE_LABEL[m]} mode` : `Answer again in ${MODE_LABEL[m]} mode (logged as an override)`,
      onclick: () => { if (m !== current) opts.onOverride(card, m); },
    }, MODE_LABEL[m])));
  const overridden = card.ledger?.override;
  return h("div", { class: "card-head" },
    h("div", { class: "card-id" },
      modeBadge(card.mode),
      h("span", { class: "conf" }, "Confidence ", h("b", {}, fmtConf(card.confidence))),
      overridden ? h("span", { class: "tag" }, `You chose ${MODE_LABEL[overridden]}`) : null,
      card.ledger?.attestation === true ? h("span", { class: "tag warn" }, "Attested") : null,
    ),
    h("div", { class: "row" }, h("span", { class: "override-label" }, "Answer as"), group),
  );
}

function dose(d) {
  return h("div", { class: "dose" },
    h("div", {}, h("div", { class: "xsmall muted" }, "Computed dose, hypothetical parameters"), h("div", { class: "dose-value" }, `${d.value} ${d.unit}`)),
    h("div", { class: "dose-basis" }, d.basis));
}

function held(card, opts) {
  return h("div", { class: "held" },
    h("span", {}, "The research number is held while an identified patient is in context."),
    h("button", { type: "button", class: "btn", onclick: () => opts.onAttest(card) }, "Review attestation"));
}

function details(card) {
  const framing = h("ul", { class: "framing" },
    (card.framing || []).map((f) => h("li", { class: /^Synthetic demo data/.test(f) ? "synthetic" : "" }, f)));
  const signals = h("div", { class: "signals" },
    (card.signals || []).length
      ? card.signals.map((s) => h("span", { class: "sig", dataset: { layer: signalLayer(s) }, title: `${signalLayer(s)} signal` }, s))
      : h("span", { class: "small muted" }, "No context signals; wording only."));
  const sources = (card.sources || []).length
    ? h("ul", { class: "sources" }, card.sources.map((s) => h("li", {},
        h("span", { class: "kind", dataset: { kind: s.kind } }, s.kind),
        h("span", {}, s.title, h("span", { class: "src-id" }, s.publisher ? `${s.id}, ${s.publisher}` : s.id)))))
    : h("p", { class: "small muted" }, "No sources shown for this card.");
  return h("div", { class: "card-grid" },
    h("section", {}, h("h4", {}, "Framing"), framing, h("h4", { style: { marginTop: "12px" } }, "Signals that drove the intent"), signals,
      h("p", { class: "sig-legend" }, "Outlined: hard context. Plain: soft context or wording. Filled: your explicit choice.")),
    h("section", {}, h("h4", {}, "Sources"), sources));
}

function hasClinicalSignal(card) {
  return (card.framing || []).some((f) => f.startsWith("Clinical answer shown first"))
    || (card.signals || []).some((s) => HARD.test(s) && !s.startsWith("chart_open_deidentified"));
}

function alternatives(card, opts) {
  const alts = card.alternatives;
  const optionB = hasClinicalSignal(card);
  const wrap = h("div", { class: "alts" });
  const nestedOpts = { ...opts, nested: true };

  if (optionB) {
    const panel = h("div", {});
    const tabs = alts.map((alt, i) => h("button", {
      type: "button", class: "alt-tab", "aria-expanded": String(i === 0), "aria-controls": `${card.answer_id}-alt`,
      onclick: (e) => {
        tabs.forEach((t) => t.setAttribute("aria-expanded", String(t === e.currentTarget)));
        panel.replaceChildren(renderCard(alt, nestedOpts));
      },
    }, modeBadge(alt.mode), h("span", { class: "conf" }, fmtConf(alt.confidence))));
    panel.id = `${card.answer_id}-alt`;
    panel.append(renderCard(alts[0], nestedOpts));
    wrap.append(
      h("div", { class: "alts-head" },
        h("div", {}, h("h3", {}, "Clinical first, others one tap away"),
          h("p", {}, "A clinical signal is present, so the clinical answer opens first and the side-by-side view is not offered (upstream behavior, spec 5.4 option B).")),
        h("div", { class: "alt-tabs", role: "group", "aria-label": "Labeled answers by intent" }, tabs)),
      panel);
  } else {
    wrap.append(
      h("div", { class: "alts-head" },
        h("div", {}, h("h3", {}, "Labeled answers for each plausible intent"),
          h("p", {}, "No intent reached the threshold and no clinical signal is present, so each intent's answer is shown side by side. Pick one to answer in that mode."))),
      h("div", { class: "alt-columns" }, alts.map((alt) => renderCard(alt, nestedOpts))));
  }
  return wrap;
}

function footer(card, opts) {
  const l = card.ledger || {};
  return h("footer", { class: "card-foot" },
    h("dl", {},
      h("div", {}, h("dt", {}, "Ledger record"), h("dd", {}, l.answer_id || "missing")),
      h("div", {}, h("dt", {}, "Fork commit"), h("dd", {}, l.fork_commit || "missing")),
      h("div", {}, h("dt", {}, "Upstream tag"), h("dd", {}, l.stock_tag || "missing")),
      l.attestation !== null && l.attestation !== undefined ? h("div", {}, h("dt", {}, "Attestation"), h("dd", {}, String(l.attestation))) : null),
    opts.nested ? null : h("a", { href: opts.ledgerHref(l.answer_id), class: "btn-quiet" }, "Open in ledger"));
}

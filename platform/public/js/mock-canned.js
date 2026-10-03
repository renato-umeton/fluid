// Fallback answer cards for mock mode when vendor/stock-app.js is absent.
// They follow the stock mode contracts closely enough to demo every card part,
// but the real behavior lives in the stock engine.

const NOTICE = "Synthetic demo data, not for clinical use.";
const TAU = 0.85;

const SRC = {
  policy: { id: "policy:opioid-adult-acute-v7", title: "Acute pain management with opioids, adults, v7 (owner: Pain Stewardship Committee)", kind: "policy" },
  fda: { id: "fda:morphinex-label-2025", title: "Morphinex prescribing information, revised 2025 (synthetic summary of FDA labeling)", kind: "fda" },
  cdc: { id: "cdc:opioid-acute-pain-guideline-2022", title: "Clinical practice guideline for prescribing opioids for pain, Morphinex section (synthetic summary of CDC guideline)", kind: "cdc" },
  society: { id: "society:acute-pain-medicine-2024", title: "Weight-based opioid dosing statement, 2024 (synthetic summary of a specialty society guideline)", kind: "society" },
  formulary: { id: "committee:pt-formulary-policy-v12", title: "Formulary Management Policy v12 (owner: Pharmacy and Therapeutics Committee)", kind: "committee" },
};

function signalsOf(req) {
  const c = req.context || {};
  const s = [];
  if (req.explicitMode) s.push(`explicit:${req.explicitMode}`);
  if (c.chartOpen) s.push(`${c.chartOpen.identified ? "chart_open" : "chart_open_deidentified"}:${c.chartOpen.patientId}`);
  if (c.orderEntryActive) s.push("order_entry:true");
  if (c.onService) s.push("on_service:true");
  if (c.documentType) s.push(`document:${c.documentType}`);
  if (c.calendarEvent) s.push(`calendar:${c.calendarEvent}`);
  if (c.screenLabel) s.push(`screen:${c.screenLabel.label}`);
  return s;
}

function distributionOf(req) {
  const c = req.context || {};
  if (c.chartOpen?.identified || c.orderEntryActive) return { clinical: 0.9, research: 0.05, administrative: 0.05 };
  if (c.documentType === "manuscript" && !c.onService) return { clinical: 0.01, research: 0.98, administrative: 0.01 };
  if (c.documentType === "budget") return { clinical: 0.05, research: 0.05, administrative: 0.9 };
  if (c.onService) return { clinical: 0.46, research: 0.42, administrative: 0.12 };
  return { clinical: 0.33, research: 0.34, administrative: 0.33 };
}

function card(base, req, ids) {
  const ledger = {
    answer_id: base.answer_id, intent: base.mode, confidence: base.confidence, signals: base.signals,
    override: req.explicitMode ?? null, attestation: base.attestation ?? null, sources: base.sources.map((s) => s.id),
    fork_commit: ids.commit, stock_tag: ids.tag,
  };
  const { attestation, ...rest } = base;
  return { override_available: true, computed_dose: null, ...rest, ledger };
}

function clinical(req, common, ids) {
  return card({
    ...common, mode: "clinical", sources: [SRC.policy],
    framing: [NOTICE, "Basis shown so the clinician can review it independently.", "Clinical judgment: the treating clinician applies their own clinical judgment. No patient-specific dose is computed in clinical mode."],
    body: "Institutional policy for Morphinex:\nAcute pain management with opioids, adults (policy:opioid-adult-acute-v7, version 7, owner: Pain Stewardship Committee).\nOrder guidance: Order through the 'Acute pain, opioid-naive adult' order set (OS-114, synthetic).\nBasis: Use the lowest effective starting option in the order set and reassess pain and sedation scores before any repeat dose.\nNo patient-specific dose is computed. The treating clinician selects the dose from the order set using their own judgment.",
    attestation: common.identified ? false : null,
  }, req, ids);
}

function research(req, common, ids) {
  if (common.identified && !req.attestation) {
    return card({
      ...common, mode: "research", sources: [], requires_attestation: true, attestation: false,
      framing: [NOTICE, "Research numbers are withheld while an identified patient is in context; attestation is required and will be recorded.", "Hypothetical parameters only; not a recommendation for any patient."],
      body: "Research answer held: an identified patient is in context (open chart or active order entry).\nTo view it, confirm \"I am not making a decision for a patient right now.\" The attestation is recorded in the run-time ledger.",
    }, req, ids);
  }
  const framing = [NOTICE, "Cross-checked across 3 independent US registry sources.", "Discrepancies flagged: none above 10 percent.", "Units and weight band validated: weight in kg within 40 to 150 kg (adult band)."];
  if (req.attestation) framing.push("Attestation recorded: the user stated they are not making a decision for a patient right now.");
  framing.push("Hypothetical parameters only; not a recommendation for any patient.");
  return card({
    ...common, mode: "research", sources: [SRC.fda, SRC.cdc, SRC.society], framing, attestation: req.attestation ? true : null,
    computed_dose: { value: 7, unit: "mg", basis: "0.1 mg/kg x 70 kg, adult band, single-dose cap 10 mg, per fda:morphinex-label-2025 (synthetic registry value)" },
    body: "Hypothetical parameters: Morphinex, adult band.\nComputed single dose: 7 mg.\nCross-check:\n- fda:morphinex-label-2025: 7 mg (0.1 mg/kg, adult band)\n- cdc:opioid-acute-pain-guideline-2022: 7 mg (0.1 mg/kg, adult band)\n- society:acute-pain-medicine-2024: 7 mg (0.1 mg/kg, adult band)",
  }, req, ids);
}

function administrative(req, common, ids) {
  return card({
    ...common, mode: "administrative", sources: [SRC.formulary],
    framing: [NOTICE, "Policy version and owner cited: Formulary Management Policy v12 (owner: Pharmacy and Therapeutics Committee)."],
    body: "Administrative view of the Morphinex question: formulary, cost, utilization, and policy. Dosing is not answered in administrative mode.\nFormulary status: Morphinex immediate-release tablet (fictional) is formulary, tier 1.\nCost and utilization: $0.42 per unit, about 18,400 units and $7,728 per month as of 2026-09-30.",
  }, req, ids);
}

const BUILD = { clinical, research, administrative };

export function cannedCard(req, commit, tag) {
  const ids = { commit, tag };
  const answer_id = `ans_${Math.random().toString(16).slice(2, 14)}`;
  const distribution = distributionOf(req);
  const signals = signalsOf(req);
  const identified = Boolean(req.context?.chartOpen?.identified || req.context?.orderEntryActive);
  const top = Object.keys(distribution).reduce((a, b) => (distribution[b] > distribution[a] ? b : a));
  const mode = req.explicitMode ?? (distribution[top] >= TAU ? top : null);
  if (mode) {
    return BUILD[mode](req, { answer_id, distribution, signals, identified, confidence: distribution[mode] }, ids);
  }
  const clinicalSignal = signals.some((s) => /^(on_service|chart_open|order_entry)/.test(s));
  const order = ["clinical", "research", "administrative"].sort((a, b) => (clinicalSignal ? (a === "clinical" ? -1 : b === "clinical" ? 1 : 0) : distribution[b] - distribution[a]));
  const alternatives = order.map((m) => BUILD[m](req, { answer_id: `${answer_id}-${m}`, distribution, signals, identified, confidence: distribution[m] }, ids));
  const framing = [NOTICE, `Top intent confidence ${distribution[top].toFixed(4)} is below the threshold ${TAU}; labeled answers are shown for each plausible intent.`];
  if (clinicalSignal) framing.push("Clinical answer shown first because a clinical signal is present; other answers are one tap away.");
  return card({
    answer_id, mode: "multi", confidence: distribution[top], distribution, signals, alternatives,
    sources: alternatives.flatMap((a) => a.sources), framing,
    body: `Intent is unclear, so this answer is shown per intent. Choose a mode to answer in that mode.`,
  }, req, ids);
}

// Signal adapters for the four layers in spec 5.1. Each adapter turns one kind
// of input into labeled signals. Labels are what the card and ledger show.
import type { AskRequest, ContextSignals, Mode } from "../app/types.js";
import { IDENTIFIED_CONTEXT_CLINICAL_FLOOR, ON_SERVICE_CLINICAL_FLOOR } from "./thresholds.js";

export type Layer = "explicit" | "hard" | "soft" | "conversation";

export interface Signal {
  label: string;
  layer: Layer;
  /** Additive evidence per mode, combined by the classifier. */
  evidence: Partial<Record<Mode, number>>;
  /** Minimum clinical probability this signal imposes (hard context only). */
  clinicalFloor?: number;
}

type Evidence = Partial<Record<Mode, number>>;

const DOCUMENT_EVIDENCE: Record<NonNullable<ContextSignals["documentType"]>, Evidence> = {
  manuscript: { research: 3 },
  grant: { research: 2, administrative: 1 },
  budget: { administrative: 3 },
  irb: { research: 2, administrative: 0.5 },
};

const SCREEN_LABEL_MODE: Record<string, Mode> = {
  ehr_chart: "clinical",
  order_entry: "clinical",
  manuscript_editor: "research",
  reference_manager: "research",
  irb_portal: "research",
  statistics_package: "research",
  budget_spreadsheet: "administrative",
  formulary_review: "administrative",
};
const SCREEN_WEIGHT = 2;

const CALENDAR_KEYWORDS: Record<Mode, RegExp> = {
  clinical: /\b(rounds|clinic|sign-out|handoff|service|consult)\b/i,
  research: /\b(manuscript|writing|journal club|lab meeting|study|irb|enrollment|grant)\b/i,
  administrative: /\b(budget|committee|p&t|finance|formulary|staffing|operations)\b/i,
};
const CALENDAR_WEIGHT = 1;

const CONVERSATION_PHRASES: Record<Mode, string[]> = {
  clinical: ["my patient", "this patient", "the patient in", "bedside", "admitted", "on the floor", "in clinic now", "order set", "ordering", "right now", "pain score", "post-op day", "prn"],
  research: ["paper", "manuscript", "study", "literature", "cohort", "hypothetical", "references", "cite", "dataset", "trial", "protocol", "enrollment", "grant"],
  administrative: ["formulary", "cost", "costs", "price", "budget", "spend", "utilization", "committee", "p&t", "reimbursement", "per month"],
};
const KEYWORD_WEIGHT = 0.75;
const HISTORY_FACTOR = 0.5;
const MAX_KEYWORDS_PER_MODE = 3;
const HISTORY_TURNS = 2;

export function explicitSignals(explicitMode: Mode | undefined): Signal[] {
  return explicitMode ? [{ label: `explicit:${explicitMode}`, layer: "explicit", evidence: {} }] : [];
}

export function hardContextSignals(context: ContextSignals): Signal[] {
  const signals: Signal[] = [];
  const chart = context.chartOpen;
  if (chart && isIdentifiedChart(chart)) {
    signals.push({ label: `chart_open:${displayPatientId(chart.patientId)}`, layer: "hard", evidence: {}, clinicalFloor: IDENTIFIED_CONTEXT_CLINICAL_FLOOR });
  } else if (chart) {
    signals.push({ label: `chart_open_deidentified:${displayPatientId(chart.patientId)}`, layer: "hard", evidence: { clinical: 1 } });
  }
  if (context.orderEntryActive) {
    signals.push({ label: "order_entry:true", layer: "hard", evidence: {}, clinicalFloor: IDENTIFIED_CONTEXT_CLINICAL_FLOOR });
  }
  if (context.onService) {
    signals.push({ label: "on_service:true", layer: "hard", evidence: {}, clinicalFloor: ON_SERVICE_CLINICAL_FLOOR });
  }
  return signals;
}

export function softContextSignals(context: ContextSignals): Signal[] {
  const signals: Signal[] = [];
  if (context.documentType) {
    signals.push({ label: `document:${context.documentType}`, layer: "soft", evidence: { ...DOCUMENT_EVIDENCE[context.documentType] } });
  }
  if (context.calendarEvent) {
    signals.push({ label: `calendar:${context.calendarEvent}`, layer: "soft", evidence: calendarEvidence(context.calendarEvent) });
  }
  if (context.screenLabel) {
    const { label, confidence } = context.screenLabel;
    const mode = SCREEN_LABEL_MODE[label];
    const evidence: Evidence = mode ? { [mode]: SCREEN_WEIGHT * clamp01(confidence) } : {};
    signals.push({ label: `screen:${label}`, layer: "soft", evidence });
  }
  return signals;
}

export function conversationSignals(question: string, history: AskRequest["history"] = []): Signal[] {
  const recentUserTurns = history.filter((turn) => turn.role === "user").slice(-HISTORY_TURNS);
  return [
    ...keywordSignals(question, "keyword", KEYWORD_WEIGHT),
    ...recentUserTurns.flatMap((turn) => keywordSignals(turn.text, "history", KEYWORD_WEIGHT * HISTORY_FACTOR)),
  ];
}

export function extractSignals(req: AskRequest): Signal[] {
  return [
    ...explicitSignals(req.explicitMode),
    ...hardContextSignals(req.context),
    ...softContextSignals(req.context),
    ...conversationSignals(req.question, req.history),
  ];
}

export function hasClinicalSignal(signals: Signal[]): boolean {
  return signals.some((s) => (s.evidence.clinical ?? 0) > 0 || s.clinicalFloor !== undefined || s.label === "explicit:clinical");
}

/** An identified patient is in front of the user: research numbers need attestation. */
export function hasIdentifiedPatientContext(context: ContextSignals): boolean {
  return (context.chartOpen ? isIdentifiedChart(context.chartOpen) : false) || Boolean(context.orderEntryActive);
}

/** Fail closed: a chart counts as identified unless it is explicitly marked identified: false. */
export function isIdentifiedChart(chart: NonNullable<ContextSignals["chartOpen"]>): boolean {
  return chart.identified !== false;
}

/**
 * Patient ids are user-supplied, so they are only echoed when they look like
 * an id (a letter, then letters, digits, or underscores). Anything else, such
 * as "5 mg", is replaced so it can never read as a dose on the card.
 */
export function displayPatientId(patientId: unknown): string {
  return typeof patientId === "string" && SAFE_PATIENT_ID.test(patientId) ? patientId : "unrecognized_id";
}
const SAFE_PATIENT_ID = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function keywordSignals(text: string, prefix: string, weight: number): Signal[] {
  const lower = text.toLowerCase();
  const signals: Signal[] = [];
  for (const mode of Object.keys(CONVERSATION_PHRASES) as Mode[]) {
    const matches = CONVERSATION_PHRASES[mode].filter((phrase) => containsPhrase(lower, phrase)).slice(0, MAX_KEYWORDS_PER_MODE);
    for (const phrase of matches) {
      signals.push({ label: `${prefix}:${mode}:${phrase}`, layer: "conversation", evidence: { [mode]: weight } });
    }
  }
  return signals;
}

function containsPhrase(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z])${escaped}($|[^a-z])`).test(text);
}

function calendarEvidence(title: string): Evidence {
  const evidence: Evidence = {};
  for (const mode of Object.keys(CALENDAR_KEYWORDS) as Mode[]) {
    if (CALENDAR_KEYWORDS[mode].test(title)) evidence[mode] = CALENDAR_WEIGHT;
  }
  return evidence;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

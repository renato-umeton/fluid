// Mode contracts from spec 5.3, and the last deterministic check every answer
// passes before it becomes a card. Policies produce drafts; this enforces them.
import type { ComputedDose, Mode, SourceKind, SourceRef } from "../app/types.js";
import { MIN_INDEPENDENT_SOURCES } from "./dose.js";
import { STOCK_REGISTRY } from "./registry.js";

export const SYNTHETIC_NOTICE = "Synthetic demo data, not for clinical use.";
export const CLINICAL_BASIS_STATEMENT = "Basis shown so the clinician can review it independently.";
export const CLINICAL_JUDGMENT_STATEMENT =
  "Clinical judgment: the treating clinician applies their own clinical judgment. No patient-specific dose is computed in clinical mode.";
export const RESEARCH_HYPOTHETICAL_STATEMENT = "Hypothetical parameters only; not a recommendation for any patient.";
export const ATTESTATION_HOLD_STATEMENT =
  "Research numbers are withheld while an identified patient is in context; attestation is required and will be recorded.";
export const CROSS_CHECK_MISSING_STATEMENT = "Number withheld: fewer than two independent current registry sources.";
export const ATTESTATION_HOLD_FACTS = [
  "Research answer held: an identified patient is in context (open chart or active order entry).",
  "To view it, confirm \"I am not making a decision for a patient right now.\" The attestation is recorded in the run-time ledger.",
];

/** A dose amount in text, for example "7 mg" or "0.5 mcg". */
export const DOSE_AMOUNT_PATTERN = /\d+(\.\d+)?\s*(mg|mcg|micrograms?|milligrams?|ml|units?)\b/i;

export interface ModeContract {
  purpose: string;
  patientSpecificComputedValues: "never" | "hypothetical parameters only" | "not applicable";
  primarySourceKinds: SourceKind[];
  requiredFraming: string[];
}

export const MODE_CONTRACTS: Record<Mode, ModeContract> = {
  clinical: {
    purpose: "Support a clinician's decision",
    patientSpecificComputedValues: "never",
    primarySourceKinds: ["policy"],
    requiredFraming: [CLINICAL_BASIS_STATEMENT, CLINICAL_JUDGMENT_STATEMENT],
  },
  research: {
    purpose: "Produce accurate, cited facts",
    patientSpecificComputedValues: "hypothetical parameters only",
    primarySourceKinds: ["fda", "cdc", "society", "literature", "policy"],
    requiredFraming: [RESEARCH_HYPOTHETICAL_STATEMENT],
  },
  administrative: {
    purpose: "Policies, operations, money, compliance",
    patientSpecificComputedValues: "not applicable",
    primarySourceKinds: ["policy", "committee"],
    requiredFraming: [],
  },
};

/** What a mode policy produces before contract enforcement. */
export interface Draft {
  mode: Mode;
  computed_dose: ComputedDose | null;
  sources: SourceRef[];
  framing: string[];
  /** Body lines; the default body is these joined by newlines. */
  facts: string[];
  requires_attestation?: boolean;
}

export interface EnforceOptions {
  researchNeedsAttestation: boolean;
}

export function enforceContract(draft: Draft, options: EnforceOptions): Draft {
  const enforced = { ...draft, sources: [...draft.sources], framing: [...draft.framing] };
  if (draft.mode === "clinical") enforceClinical(enforced);
  if (draft.mode === "research") enforceResearch(enforced, options);
  if (draft.mode === "administrative") enforceAdministrative(enforced);
  enforced.framing = unique([SYNTHETIC_NOTICE, ...enforced.framing, ...MODE_CONTRACTS[draft.mode].requiredFraming]);
  return enforced;
}

/** Distinct publishers among the cited sources that are current registry entries. */
export function independentRegistrySources(sources: SourceRef[]): number {
  const publishers = sources
    .map((s) => STOCK_REGISTRY.entries.find((e) => e.id === s.id && e.status === "current")?.publisher)
    .filter((p): p is string => p !== undefined);
  return new Set(publishers).size;
}

function enforceClinical(draft: Draft): void {
  // Clinical mode never carries a computed patient-specific dose, whatever a policy returned.
  draft.computed_dose = null;
  if (draft.facts.some((line) => DOSE_AMOUNT_PATTERN.test(line))) {
    throw new Error("clinical contract: answer text must not contain a dose amount");
  }
  if (!draft.sources.some((s) => s.kind === "policy")) {
    throw new Error("clinical contract: an answer must cite at least one institutional policy");
  }
}

function enforceResearch(draft: Draft, { researchNeedsAttestation }: EnforceOptions): void {
  if (researchNeedsAttestation) {
    draft.computed_dose = null;
    draft.requires_attestation = true;
    draft.sources = [];
    draft.facts = [...ATTESTATION_HOLD_FACTS];
    draft.framing = [ATTESTATION_HOLD_STATEMENT];
    return;
  }
  if (draft.computed_dose !== null && independentRegistrySources(draft.sources) < MIN_INDEPENDENT_SOURCES) {
    draft.computed_dose = null;
    draft.facts = [CROSS_CHECK_MISSING_STATEMENT];
    draft.framing = [CROSS_CHECK_MISSING_STATEMENT];
  }
}

function enforceAdministrative(draft: Draft): void {
  draft.computed_dose = null;
  if (!draft.sources.some((s) => s.kind === "committee")) {
    throw new Error("administrative contract: an answer must cite a committee policy with version and owner");
  }
}

function unique(lines: string[]): string[] {
  return [...new Set(lines)];
}

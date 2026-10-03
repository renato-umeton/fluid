// Research mode: accurate, cited facts. Dosing questions with hypothetical
// parameters get a computed value cross-checked across the US source registry.
import type { Draft } from "./contracts.js";
import { DISCREPANCY_TOLERANCE, computeCrossCheckedDose, parseDoseParameters, type DoseOutcome } from "./dose.js";
import { detectDrug } from "./drugs.js";
import { isDosingQuestion } from "../intent/questions.js";
import { STOCK_REGISTRY, currentEntriesFor, toSourceRef, type RegistryEntry } from "./registry.js";

export const ATTESTATION_RECORDED_STATEMENT =
  "Attestation recorded: the user stated they are not making a decision for a patient right now.";

export interface ResearchInput {
  question: string;
  /** True when an identified patient is in context and the user attested. */
  attested: boolean;
}

export function researchAnswer({ question, attested }: ResearchInput): Draft {
  const drug = detectDrug(question);
  const entries = drug ? currentEntriesFor(STOCK_REGISTRY, drug.id) : [];
  const attestation = attested ? [ATTESTATION_RECORDED_STATEMENT] : [];

  if (!drug || entries.length === 0) {
    return draft(["No drug from the US source registry was named, so there is nothing to cross-check."], [], attestation);
  }
  if (!isDosingQuestion(question)) {
    const facts = [`Current US registry sources for ${drug.display}:`, ...entries.map((e) => `- ${e.title} (${e.id})`)];
    return draft(facts, entries, attestation);
  }

  const outcome = computeCrossCheckedDose(parseDoseParameters(question), entries);
  return outcome.ok ? computedDraft(drug.display, outcome, attestation) : withheldDraft(outcome, entries, attestation);
}

function computedDraft(drugName: string, outcome: Extract<DoseOutcome, { ok: true }>, attestation: string[]): Draft {
  const { dose, weightKg, ageYears, primary, perSource, discrepancies, notes } = outcome;
  const used = perSource.map((s) => s.entry);
  const facts = [
    `Hypothetical parameters: ${drugName}, ${weightKg} kg, ${ageYears} years (${primary.band.population} band of the primary source).`,
    `Computed single dose: ${dose.value} ${dose.unit} (${dose.basis}).`,
    "Cross-check:",
    ...perSource.map((s) => `- ${s.entry.id}: ${s.valueMg} mg (${s.band.mgPerKg} mg/kg, ${s.band.population} band${s.capped ? ", capped" : ""})`),
    ...discrepancies.map((d) => `Discrepancy: ${d.sourceId} gives ${d.valueMg} mg versus ${d.primaryMg} mg from the primary source.`),
  ];
  const framing = [
    `Cross-checked across ${used.length} independent US registry sources.`,
    discrepancies.length === 0
      ? `Discrepancies flagged: none above ${DISCREPANCY_TOLERANCE * 100} percent.`
      : `Discrepancies flagged: ${discrepancies.length} source(s) differ from the primary value by more than ${DISCREPANCY_TOLERANCE * 100} percent.`,
    `Units and weight band validated: ${weightKg} kg is within ${primary.band.minWeightKg} to ${primary.band.maxWeightKg} kg (${primary.band.population} band).`,
    ...notes,
    ...attestation,
  ];
  return { mode: "research", computed_dose: dose, sources: used.map(toSourceRef), framing, facts };
}

function withheldDraft(outcome: Extract<DoseOutcome, { ok: false }>, consulted: RegistryEntry[], attestation: string[]): Draft {
  const facts = [`No number computed: ${outcome.reason}`, "Consulted current registry sources:", ...consulted.map((e) => `- ${e.title} (${e.id})`)];
  const framing = [`Units and weight band validation did not pass: ${outcome.reason}`, ...outcome.notes, ...attestation];
  return { mode: "research", computed_dose: null, sources: consulted.map(toSourceRef), framing, facts };
}

function draft(facts: string[], entries: RegistryEntry[], framing: string[]): Draft {
  return { mode: "research", computed_dose: null, sources: entries.map(toSourceRef), framing, facts };
}

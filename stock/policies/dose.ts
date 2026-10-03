// Research-mode dose computation for hypothetical parameters. A number is only
// produced when units and weight band validate and at least two independent
// registry publishers cover the case; disagreements are flagged, not hidden.
import type { ComputedDose } from "../app/types.js";
import { KNOWN_DRUGS } from "./drugs.js";
import { STOCK_REGISTRY, registryDrugs, type DosingBand, type RegistryEntry } from "./registry.js";

export interface DoseParameters {
  drug: string | null;
  weightKg: number | null;
  ageYears: number | null;
  notes: string[];
  problems: string[];
}

export interface SourceDose {
  entry: RegistryEntry;
  band: DosingBand;
  valueMg: number;
  capped: boolean;
}

export interface Discrepancy {
  sourceId: string;
  valueMg: number;
  primaryMg: number;
}

export type DoseOutcome =
  | { ok: true; dose: ComputedDose; weightKg: number; ageYears: number; primary: SourceDose; perSource: SourceDose[]; discrepancies: Discrepancy[]; notes: string[] }
  | { ok: false; reason: string; notes: string[] };

export const MIN_INDEPENDENT_SOURCES = 2;
export const DISCREPANCY_TOLERANCE = 0.1;
const KG_PER_LB = 0.45359237;

const WEIGHT_PATTERN = /(\d+(?:\.\d+)?)\s*(kg|kgs|kilograms?|lbs?|pounds?)\b/gi;
const UNSUPPORTED_WEIGHT_PATTERN = /(\d+(?:\.\d+)?)\s*(g|grams?|st|stone|oz|ounces?)\b/i;
const AGE_PATTERN = /(\d+(?:\.\d+)?)\s*-?\s*(years?|yrs?|yo|y\/o|months?)\b/gi;
/** Two stated weights closer than this (after lb conversion) are the same weight. */
const SAME_WEIGHT_KG = 0.5;

export function parseDoseParameters(question: string, knownDrugs: string[] = defaultDrugNames()): DoseParameters {
  const lower = question.toLowerCase();
  const drugs = knownDrugs.filter((d) => lower.includes(d));
  const notes: string[] = [];
  const problems: string[] = [];
  if (drugs.length === 0) problems.push("Drug name not found in the US source registry.");
  if (drugs.length > 1) problems.push(`Ambiguous drug: the question names more than one drug (${drugs.join(", ")}); ask about one drug at a time.`);

  const weightKg = parseWeight(question, notes, problems);
  const ageYears = parseAge(question, problems);
  return { drug: drugs.length === 1 ? drugs[0]! : null, weightKg, ageYears, notes, problems };
}

function defaultDrugNames(): string[] {
  return [...new Set([...registryDrugs(STOCK_REGISTRY), ...KNOWN_DRUGS.map((d) => d.id)])];
}

export function computeCrossCheckedDose(params: DoseParameters, entries: RegistryEntry[]): DoseOutcome {
  const { notes } = params;
  if (params.problems.length > 0 || params.weightKg === null || params.ageYears === null) {
    return { ok: false, reason: params.problems.join(" "), notes };
  }
  const weightKg = params.weightKg;
  const ageYears = params.ageYears;

  const applicable = entries.flatMap((entry) => {
    const band = entry.dosing.find((b) => ageYears >= b.minAgeYears && (b.maxAgeYears === null || ageYears < b.maxAgeYears));
    return band ? [{ entry, band }] : [];
  });
  if (applicable.length === 0) {
    return { ok: false, reason: `No current registry source covers age ${ageYears} years for ${params.drug}.`, notes };
  }

  const inBand = applicable.filter(({ band }) => weightKg >= band.minWeightKg && weightKg <= band.maxWeightKg);
  if (inBand.length === 0) {
    const { band } = applicable[0]!;
    return { ok: false, reason: `Weight ${weightKg} kg is outside the validated weight band (${band.minWeightKg} to ${band.maxWeightKg} kg) for the ${band.population} population.`, notes };
  }

  const publishers = new Set(inBand.map(({ entry }) => entry.publisher));
  if (publishers.size < MIN_INDEPENDENT_SOURCES) {
    const ids = inBand.map(({ entry }) => entry.id).join(", ");
    return { ok: false, reason: `Cross-check requires at least two independent registry sources; only ${publishers.size} covers this case (${ids}).`, notes };
  }

  const perSource = inBand.map(({ entry, band }) => doseFor(entry, band, weightKg));
  const primary = perSource.find((s) => s.entry.kind === "fda") ?? perSource[0]!;
  const discrepancies = perSource
    .filter((s) => Math.abs(s.valueMg - primary.valueMg) / primary.valueMg > DISCREPANCY_TOLERANCE)
    .map((s) => ({ sourceId: s.entry.id, valueMg: s.valueMg, primaryMg: primary.valueMg }));

  const { band } = primary;
  const basis = `${band.mgPerKg} mg/kg x ${weightKg} kg, ${band.population} band, single-dose cap ${band.maxSingleDoseMg} mg, per ${primary.entry.id} (synthetic registry value)`;
  return { ok: true, dose: { value: primary.valueMg, unit: "mg", basis }, weightKg, ageYears, primary, perSource, discrepancies, notes };
}

function doseFor(entry: RegistryEntry, band: DosingBand, weightKg: number): SourceDose {
  const raw = weightKg * band.mgPerKg;
  const capped = raw > band.maxSingleDoseMg;
  return { entry, band, valueMg: roundTenth(capped ? band.maxSingleDoseMg : raw), capped };
}

function parseWeight(question: string, notes: string[], problems: string[]): number | null {
  const matches = [...question.matchAll(WEIGHT_PATTERN)];
  if (matches.length === 0) {
    const unsupported = UNSUPPORTED_WEIGHT_PATTERN.exec(question);
    problems.push(unsupported ? `Weight unit "${unsupported[2]}" is not supported; use kg or lb.` : "Weight with a unit (kg or lb) is required.");
    return null;
  }
  const weights = matches.map((m) => {
    const value = Number(m[1]);
    const isKg = /^(kg|kgs|kilograms?)$/i.test(m[2]!);
    return { stated: `${value} ${isKg ? "kg" : "lb"}`, value, kg: isKg ? value : roundTenth(value * KG_PER_LB), isKg };
  });
  const first = weights[0]!;
  if (weights.some((w) => Math.abs(w.kg - first.kg) > SAME_WEIGHT_KG)) {
    problems.push(`Ambiguous weight: the question states more than one weight (${unique(weights.map((w) => w.stated)).join(", ")}); state one weight.`);
    return null;
  }
  const kgWeight = weights.find((w) => w.isKg);
  if (kgWeight) return kgWeight.value;
  notes.push(`Weight ${first.value} lb converted to ${first.kg} kg.`);
  return first.kg;
}

function parseAge(question: string, problems: string[]): number | null {
  const ages = [...question.matchAll(AGE_PATTERN)].map((m) => {
    const value = Number(m[1]);
    const months = /^months?$/i.test(m[2]!);
    return { stated: `${value} ${months ? "months" : "years"}`, years: months ? Math.round((value / 12) * 100) / 100 : value };
  });
  if (ages.length === 0) {
    problems.push("Age in years is required.");
    return null;
  }
  if (new Set(ages.map((a) => a.years)).size > 1) {
    problems.push(`Ambiguous age: the question states more than one age (${unique(ages.map((a) => a.stated)).join(", ")}); state one age.`);
    return null;
  }
  return ages[0]!.years;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

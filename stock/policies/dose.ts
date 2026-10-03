// Research-mode dose computation for hypothetical parameters. A number is only
// produced when units and weight band validate and at least two independent
// registry publishers cover the case; disagreements are flagged, not hidden.
import type { ComputedDose } from "../app/types.js";
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

const WEIGHT_PATTERN = /(\d+(?:\.\d+)?)\s*(kg|kgs|kilograms?|lbs?|pounds?)\b/i;
const UNSUPPORTED_WEIGHT_PATTERN = /(\d+(?:\.\d+)?)\s*(g|grams?|st|stone|oz|ounces?)\b/i;
const AGE_PATTERN = /(\d+(?:\.\d+)?)\s*-?\s*(years?|yrs?|yo|y\/o|months?)\b/i;

export function parseDoseParameters(question: string, knownDrugs: string[] = registryDrugs(STOCK_REGISTRY)): DoseParameters {
  const lower = question.toLowerCase();
  const drug = knownDrugs.find((d) => lower.includes(d)) ?? null;
  const notes: string[] = [];
  const problems: string[] = [];
  if (!drug) problems.push("Drug name not found in the US source registry.");

  const weightKg = parseWeight(question, notes, problems);
  const ageYears = parseAge(question);
  if (ageYears === null) problems.push("Age in years is required.");
  return { drug, weightKg, ageYears, notes, problems };
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
  const match = WEIGHT_PATTERN.exec(question);
  if (!match) {
    const unsupported = UNSUPPORTED_WEIGHT_PATTERN.exec(question);
    problems.push(unsupported ? `Weight unit "${unsupported[2]}" is not supported; use kg or lb.` : "Weight with a unit (kg or lb) is required.");
    return null;
  }
  const value = Number(match[1]);
  if (/^(kg|kgs|kilograms?)$/i.test(match[2]!)) return value;
  const kg = roundTenth(value * KG_PER_LB);
  notes.push(`Weight ${value} lb converted to ${kg} kg.`);
  return kg;
}

function parseAge(question: string): number | null {
  const match = AGE_PATTERN.exec(question);
  if (!match) return null;
  const value = Number(match[1]);
  return /^months?$/i.test(match[2]!) ? Math.round((value / 12) * 100) / 100 : value;
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

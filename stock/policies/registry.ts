// US source registry for research mode. Loaded from registry.json and
// validated up front so a malformed fork edit fails loudly.
import rawRegistry from "./registry.json";
import type { SourceKind, SourceRef } from "../app/types.js";

export type RegistryKind = Extract<SourceKind, "fda" | "cdc" | "society" | "literature">;

export interface DosingBand {
  population: string;
  minAgeYears: number;
  /** Exclusive upper bound; null means no upper bound. */
  maxAgeYears: number | null;
  minWeightKg: number;
  maxWeightKg: number;
  mgPerKg: number;
  maxSingleDoseMg: number;
}

export interface RegistryEntry {
  id: string;
  kind: RegistryKind;
  publisher: string;
  title: string;
  drug: string;
  status: "current" | "superseded";
  synthetic: true;
  dosing: DosingBand[];
}

export interface Registry {
  version: string;
  jurisdiction: string;
  entries: RegistryEntry[];
}

const REGISTRY_KINDS: readonly string[] = ["fda", "cdc", "society", "literature"];

export function loadRegistry(raw: unknown): Registry {
  const input = raw as Partial<Registry>;
  if (!Array.isArray(input.entries)) throw new Error("registry: entries must be an array");
  input.entries.forEach(validateEntry);
  return { version: String(input.version ?? "unknown"), jurisdiction: String(input.jurisdiction ?? "US"), entries: input.entries };
}

export const STOCK_REGISTRY: Registry = loadRegistry(rawRegistry);

export function currentEntriesFor(registry: Registry, drug: string): RegistryEntry[] {
  return registry.entries.filter((e) => e.drug === drug && e.status === "current");
}

export function registryDrugs(registry: Registry): string[] {
  return [...new Set(registry.entries.map((e) => e.drug))];
}

export function toSourceRef(entry: RegistryEntry): SourceRef {
  return { id: entry.id, title: entry.title, kind: entry.kind, publisher: entry.publisher };
}

function validateEntry(entry: Partial<RegistryEntry>): void {
  const where = `registry entry ${entry.id ?? "(no id)"}`;
  if (typeof entry.id !== "string") throw new Error(`${where}: id is required`);
  if (!REGISTRY_KINDS.includes(String(entry.kind))) throw new Error(`${where}: kind must be one of ${REGISTRY_KINDS.join(", ")}`);
  if (typeof entry.publisher !== "string" || typeof entry.title !== "string") throw new Error(`${where}: publisher and title are required`);
  if (entry.synthetic !== true) throw new Error(`${where}: must be marked synthetic`);
  if (entry.status !== "current" && entry.status !== "superseded") throw new Error(`${where}: status must be current or superseded`);
  if (!Array.isArray(entry.dosing)) throw new Error(`${where}: dosing must be an array`);
}

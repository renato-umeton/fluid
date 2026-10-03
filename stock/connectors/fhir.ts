// Mock FHIR connector over the synthetic Synthea-style bundles in env.data.
import type { FhirResource, SyntheticData } from "./types.js";

export interface PatientSummary {
  id: string;
  displayName: string;
  gender: string;
  birthDate: string;
  ageYears: number;
  weightKg: number | null;
  conditions: string[];
  allergies: string[];
  location: string | null;
}

const WEIGHT_LOINC = "29463-7";

export function findPatient(data: SyntheticData | undefined, patientId: string): PatientSummary | null {
  const bundle = data?.patients?.bundles.find((b) => b.entry.some((e) => isPatient(e.resource, patientId)));
  if (!bundle) return null;
  const resources = bundle.entry.map((e) => e.resource);
  const patient = resources.find((r) => isPatient(r, patientId))!;
  const birthDate = String(patient.birthDate);
  return {
    id: patientId,
    displayName: displayName(patient),
    gender: String(patient.gender),
    birthDate,
    ageYears: ageInYears(birthDate, data?.patients?.referenceDate),
    weightKg: latestWeightKg(resources),
    conditions: codesOf(resources, "Condition"),
    allergies: codesOf(resources, "AllergyIntolerance"),
    location: locationOf(resources),
  };
}

export function listPatientIds(data: SyntheticData | undefined): string[] {
  return (data?.patients?.bundles ?? []).flatMap((b) => b.entry.filter((e) => e.resource.resourceType === "Patient").map((e) => e.resource.id));
}

export function ageInYears(birthDate: string, referenceDate?: string): number {
  const ref = referenceDate ? new Date(`${referenceDate}T00:00:00Z`) : new Date();
  const birth = new Date(`${birthDate}T00:00:00Z`);
  const days = (ref.getTime() - birth.getTime()) / 86_400_000;
  return Math.floor((days / 365.25) * 10) / 10;
}

function isPatient(resource: FhirResource, id: string): boolean {
  return resource.resourceType === "Patient" && resource.id === id;
}

function displayName(patient: FhirResource): string {
  const name = (patient.name as { given?: string[]; family?: string }[] | undefined)?.[0];
  return [name?.given?.join(" "), name?.family].filter(Boolean).join(" ");
}

function latestWeightKg(resources: FhirResource[]): number | null {
  const weight = resources.find((r) => {
    if (r.resourceType !== "Observation") return false;
    const coding = (r.code as { coding?: { code?: string }[] } | undefined)?.coding ?? [];
    return coding.some((c) => c.code === WEIGHT_LOINC);
  });
  const quantity = weight?.valueQuantity as { value?: number; unit?: string } | undefined;
  return quantity?.unit === "kg" && typeof quantity.value === "number" ? quantity.value : null;
}

function codesOf(resources: FhirResource[], resourceType: string): string[] {
  return resources
    .filter((r) => r.resourceType === resourceType)
    .flatMap((r) => ((r.code as { coding?: { code?: string }[] } | undefined)?.coding ?? []).map((c) => c.code ?? ""))
    .filter((code) => code !== "");
}

function locationOf(resources: FhirResource[]): string | null {
  const encounter = resources.find((r) => r.resourceType === "Encounter");
  const location = (encounter?.location as { location?: { display?: string } }[] | undefined)?.[0];
  return location?.location?.display ?? null;
}

// Clinical mode: retrieve the applicable institutional policy and order
// guidance, show the basis, and never compute a patient-specific dose.
import rawPolicies from "./clinical-policies.json";
import type { ContextSignals, SourceRef } from "../app/types.js";
import { findPatient, type PatientSummary } from "../connectors/fhir.js";
import type { SyntheticData } from "../connectors/types.js";
import type { Draft } from "./contracts.js";
import { parseDoseParameters } from "./dose.js";
import { detectDrug, type DrugInfo } from "./drugs.js";

export interface ClinicalPolicy {
  id: string;
  title: string;
  version: string;
  owner: string;
  effective: string;
  synthetic: true;
  appliesTo: { drugClass: string; population?: string; condition?: string };
  orderGuidance: string;
  basis: string[];
}

export const CLINICAL_POLICIES: ClinicalPolicy[] = (rawPolicies as { policies: ClinicalPolicy[] }).policies;

const OLDER_ADULT_AGE = 65;
const ADULT_AGE = 18;

export interface ClinicalInput {
  question: string;
  context: ContextSignals;
  data?: SyntheticData;
}

export function clinicalAnswer({ question, context, data }: ClinicalInput): Draft {
  const drug = detectDrug(question);
  const patientId = context.chartOpen?.identified ? context.chartOpen.patientId : null;
  const patient = patientId ? findPatient(data, patientId) : null;
  const ageYears = patient?.ageYears ?? parseDoseParameters(question).ageYears;
  const policies = drug ? opioidPolicies(ageYears, patient) : [policyById("policy:clinical-decision-support-v2")];

  const facts = [
    ...alerts(drug, patient, patientId),
    drug ? `Institutional policy for ${drug.display}:` : "Institutional policy:",
    ...policies.flatMap(describePolicy),
    ...(patient ? [describePatient(patient)] : []),
    "No patient-specific dose is computed. The treating clinician selects the dose from the order set using their own judgment.",
  ];
  return { mode: "clinical", computed_dose: null, sources: policies.map(toSourceRef), framing: [], facts };
}

export function policyById(id: string): ClinicalPolicy {
  const policy = CLINICAL_POLICIES.find((p) => p.id === id);
  if (!policy) throw new Error(`clinical policy ${id} is missing from clinical-policies.json`);
  return policy;
}

function opioidPolicies(ageYears: number | null, patient: PatientSummary | null): ClinicalPolicy[] {
  const policies: ClinicalPolicy[] = [];
  if (ageYears === null) {
    policies.push(policyById("policy:opioid-adult-acute-v7"), policyById("policy:opioid-pediatric-acute-v3"));
  } else if (ageYears < ADULT_AGE) {
    policies.push(policyById("policy:opioid-pediatric-acute-v3"));
  } else {
    policies.push(policyById("policy:opioid-adult-acute-v7"));
    if (ageYears >= OLDER_ADULT_AGE) policies.push(policyById("policy:opioid-older-adult-v2"));
  }
  for (const policy of CLINICAL_POLICIES) {
    const condition = policy.appliesTo.condition;
    if (condition && patient?.conditions.includes(condition)) policies.push(policy);
  }
  return policies;
}

function alerts(drug: DrugInfo | null, patient: PatientSummary | null, patientId: string | null): string[] {
  const lines: string[] = [];
  if (patientId && !patient) lines.push(`Patient record ${patientId} was not found in the FHIR connector; policy shown without patient context.`);
  if (drug && patient?.allergies.includes(drug.id)) lines.push(`Alert: the chart lists an allergy to ${drug.display}. Review before ordering.`);
  return lines;
}

function describePolicy(policy: ClinicalPolicy): string[] {
  return [
    `${policy.title} (${policy.id}, version ${policy.version}, owner: ${policy.owner}, effective ${policy.effective}).`,
    `Order guidance: ${policy.orderGuidance}`,
    ...policy.basis.map((line) => `Basis: ${line}`),
  ];
}

function describePatient(patient: PatientSummary): string {
  const weight = patient.weightKg === null ? "no weight documented" : `weight ${patient.weightKg} kg documented in the chart`;
  return `Patient context: ${patient.id}, age ${Math.floor(patient.ageYears)}, ${weight}, ${patient.location ?? "location unknown"}.`;
}

function toSourceRef(policy: ClinicalPolicy): SourceRef {
  return { id: policy.id, title: `${policy.title}, v${policy.version} (owner: ${policy.owner})`, kind: "policy" };
}

// Administrative mode: formulary status, cost, utilization, and the committee
// policy that governs them, always with policy version and owner.
import rawPolicies from "./administrative-policies.json";
import type { ContextSignals, SourceRef } from "../app/types.js";
import { budgetLinesFor } from "../connectors/documents.js";
import { formularyAsOf, formularyItemsFor } from "../connectors/formulary.js";
import type { FormularyItem, SyntheticData } from "../connectors/types.js";
import type { Draft } from "./contracts.js";
import { detectDrug } from "./drugs.js";
import { isDosingQuestion } from "../intent/questions.js";

export interface CommitteePolicy {
  id: string;
  title: string;
  version: string;
  owner: string;
  effective: string;
  synthetic: true;
  summary: string;
}

export const COMMITTEE_POLICIES: CommitteePolicy[] = (rawPolicies as { policies: CommitteePolicy[] }).policies;

const FORMULARY_POLICY_ID = "committee:pt-formulary-policy-v12";
const BUDGET_POLICY_ID = "committee:pharmacy-budget-policy-v3";
const STATUS_TEXT: Record<FormularyItem["status"], string> = {
  formulary: "on formulary",
  "formulary-restricted": "on formulary with restrictions",
  "non-formulary": "non-formulary",
};
const usd = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export interface AdministrativeInput {
  question: string;
  context: ContextSignals;
  data?: SyntheticData;
}

export function administrativeAnswer({ question, context, data }: AdministrativeInput): Draft {
  const drug = detectDrug(question);
  const items = drug ? formularyItemsFor(data, drug.id) : [];
  const budget = drug ? budgetLinesFor(data, drug.id) : [];
  const includeBudget = budget.length > 0 && (context.documentType === "budget" || /budget|spend|cost/i.test(question));

  const policyIds = new Set([FORMULARY_POLICY_ID, ...items.map((i) => i.policyId)]);
  if (includeBudget) policyIds.add(BUDGET_POLICY_ID);
  const policies = [...policyIds].map(committeePolicyById);

  const facts = [
    ...(drug && isDosingQuestion(question) ? [`Administrative view of the ${drug.display} question: formulary, cost, utilization, and policy. Dosing is not answered in administrative mode.`] : []),
    ...(drug ? formularyFacts(drug.display, items, formularyAsOf(data)) : ["Name a drug to see its formulary status, cost, and utilization."]),
    ...(includeBudget ? budget.map(({ document, line }) => `Budget: ${line.item} FY27 projected ${usd(line.fy27ProjectedUsd)} versus FY26 actual ${usd(line.fy26ActualUsd)} (${document.title}).`) : []),
    ...policies.map((p) => `Committee policy: ${p.title} v${p.version}, owner ${p.owner}, effective ${p.effective}. ${p.summary}`),
  ];
  const framing = [`Policy version and owner cited: ${policies.map((p) => `${p.title} v${p.version} (owner: ${p.owner})`).join("; ")}.`];
  return { mode: "administrative", computed_dose: null, sources: policies.map(toSourceRef), framing, facts };
}

export function committeePolicyById(id: string): CommitteePolicy {
  const policy = COMMITTEE_POLICIES.find((p) => p.id === id);
  if (!policy) throw new Error(`committee policy ${id} is missing from administrative-policies.json`);
  return policy;
}

function formularyFacts(drugName: string, items: FormularyItem[], asOf: string | null): string[] {
  if (items.length === 0) return [`Formulary status: no formulary data available for ${drugName} from the formulary connector.`];
  return items.flatMap((item) => [
    `Formulary status: ${item.product} is ${STATUS_TEXT[item.status]}${item.tier === null ? "" : `, tier ${item.tier}`}. ${item.restrictions}.`,
    `Cost and utilization: ${usd(item.unitCostUsd)} per unit, about ${item.unitsPerMonth.toLocaleString("en-US")} units and ${usd(item.monthlySpendUsd)} per month${asOf ? ` as of ${asOf}` : ""}; ${item.trend}.`,
  ]);
}

function toSourceRef(policy: CommitteePolicy): SourceRef {
  return { id: policy.id, title: `${policy.title} v${policy.version} (owner: ${policy.owner})`, kind: "committee" };
}

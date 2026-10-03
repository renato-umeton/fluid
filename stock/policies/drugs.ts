// Fictional drugs known to the stock release. Real drug names are deliberately
// absent so nothing here can be mistaken for real dosing guidance.

export interface DrugInfo {
  id: string;
  display: string;
  drugClass: "opioid";
}

export const KNOWN_DRUGS: readonly DrugInfo[] = [
  { id: "morphinex", display: "Morphinex", drugClass: "opioid" },
  { id: "hydrolane", display: "Hydrolane", drugClass: "opioid" },
];

export function detectDrug(question: string): DrugInfo | null {
  const lower = question.toLowerCase();
  return KNOWN_DRUGS.find((d) => lower.includes(d.id)) ?? null;
}

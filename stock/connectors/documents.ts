// Synthetic documents connector: manuscripts, grants, budgets, IRB protocols.
import type { BudgetLine, SyntheticDocument, SyntheticData } from "./types.js";

export function findDocuments(data: SyntheticData | undefined, type: SyntheticDocument["type"]): SyntheticDocument[] {
  return data?.documents?.documents.filter((d) => d.type === type) ?? [];
}

export function budgetLinesFor(data: SyntheticData | undefined, drug: string): { document: SyntheticDocument; line: BudgetLine }[] {
  return findDocuments(data, "budget").flatMap((document) =>
    (document.lines ?? []).filter((line) => line.drug === drug).map((line) => ({ document, line })),
  );
}

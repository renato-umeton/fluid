// Synthetic formulary connector: status, tier, cost, and utilization by drug.
import type { FormularyItem, SyntheticData } from "./types.js";

export function formularyItemsFor(data: SyntheticData | undefined, drug: string): FormularyItem[] {
  return data?.formulary?.items.filter((item) => item.drug === drug) ?? [];
}

export function formularyAsOf(data: SyntheticData | undefined): string | null {
  return data?.formulary?.asOf ?? null;
}

// Shapes of the synthetic data the platform injects as env.data.
// Each key mirrors a file under synthetic/ (see synthetic/manifest.json).

export interface FhirResource {
  resourceType: string;
  id: string;
  [field: string]: unknown;
}

export interface FhirBundle {
  resourceType: "Bundle";
  id: string;
  entry: { resource: FhirResource }[];
}

export interface PatientsFile {
  referenceDate?: string;
  bundles: FhirBundle[];
}

export interface Shift {
  personaId: string;
  service: string;
  role: string;
  start: string;
  end: string;
}

export interface CalendarEvent {
  personaId: string;
  title: string;
  start: string;
  end: string;
}

export interface BudgetLine {
  category: string;
  drug: string;
  item: string;
  fy26ActualUsd: number;
  fy27ProjectedUsd: number;
}

export interface SyntheticDocument {
  id: string;
  type: "manuscript" | "grant" | "budget" | "irb";
  ownerId: string;
  title: string;
  status?: string;
  lines?: BudgetLine[];
  [field: string]: unknown;
}

export interface FormularyItem {
  id: string;
  drug: string;
  product: string;
  status: "formulary" | "formulary-restricted" | "non-formulary";
  tier: number | null;
  restrictions: string;
  unitCostUsd: number;
  unitsPerMonth: number;
  monthlySpendUsd: number;
  trend: string;
  policyId: string;
}

export interface SyntheticData {
  patients?: PatientsFile;
  callSchedule?: { shifts: Shift[] };
  calendars?: { events: CalendarEvent[] };
  documents?: { documents: SyntheticDocument[] };
  formulary?: { asOf?: string; items: FormularyItem[] };
  personas?: unknown;
  redcap?: unknown;
}

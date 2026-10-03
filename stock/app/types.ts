// Shared contracts for the fork runtime module. The platform depends on these
// shapes; changing them is a breaking change for every fork.
import type { SyntheticData } from "../connectors/types.js";

export type Mode = "clinical" | "research" | "administrative";
export const MODES: readonly Mode[] = ["clinical", "research", "administrative"];

export interface ContextSignals {
  /** A chart is treated as identified unless identified is exactly false (fail closed). */
  chartOpen?: { patientId: string; identified?: boolean } | null;
  orderEntryActive?: boolean;
  onService?: boolean;
  documentType?: "manuscript" | "grant" | "budget" | "irb" | null;
  calendarEvent?: string | null;
  screenLabel?: { label: string; confidence: number } | null;
}

export interface AskRequest {
  question: string;
  context: ContextSignals;
  explicitMode?: Mode;
  attestation?: boolean;
  history?: { role: "user" | "assistant"; text: string }[];
}

export type SourceKind = "policy" | "fda" | "cdc" | "society" | "literature" | "committee";

export interface SourceRef {
  id: string;
  title: string;
  kind: SourceKind;
  /** Publisher label, set for US registry sources (always marked synthetic). */
  publisher?: string;
}

export interface ComputedDose {
  value: number;
  unit: string;
  basis: string;
}

export interface RunTimeRecord {
  answer_id: string;
  intent: Mode | "multi";
  confidence: number;
  signals: string[];
  override: Mode | null;
  attestation: boolean | null;
  sources: string[];
  fork_commit: string;
  stock_tag: string;
  /** Effective tau used for this answer (never below the stock minimum). */
  tau: number;
}

export interface AnswerCard {
  answer_id: string;
  mode: Mode | "multi";
  confidence: number;
  distribution: Record<Mode, number>;
  signals: string[];
  override_available: true;
  computed_dose: ComputedDose | null;
  sources: SourceRef[];
  framing: string[];
  body: string;
  alternatives?: AnswerCard[];
  requires_attestation?: boolean;
  /** Effective tau used for this answer (never below the stock minimum). */
  tau: number;
  ledger: RunTimeRecord;
}

/** Optional model hook. It may only reword body text; it never decides anything. */
export type LlmHook = (prompt: string, schema: Record<string, unknown>) => Promise<unknown>;

export interface ForkEnv {
  /** Text of the fork's fluid.toml. Missing means stock defaults. */
  fluidToml?: string;
  /** Commit of the fork that produced this answer, recorded in the ledger. */
  forkCommit?: string;
  /** Synthetic data injected by the platform for the stock connectors. */
  data?: SyntheticData;
  llm?: LlmHook;
  /** Answer id factory, injectable for deterministic tests. */
  newId?: () => string;
}

export interface ForkApp {
  ask(req: AskRequest, env: ForkEnv): Promise<AnswerCard>;
}

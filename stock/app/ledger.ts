// Run-time intent record written for every answer (spec section 8).
import type { AskRequest, Mode, RunTimeRecord, SourceRef } from "./types.js";

export interface RecordInput {
  answerId: string;
  intent: Mode | "multi";
  confidence: number;
  signals: string[];
  sources: SourceRef[];
  request: AskRequest;
  identifiedPatientContext: boolean;
  forkCommit: string;
  stockTag: string;
  tau: number;
}

export function runTimeRecord(input: RecordInput): RunTimeRecord {
  return {
    answer_id: input.answerId,
    intent: input.intent,
    confidence: input.confidence,
    signals: input.signals,
    override: input.request.explicitMode ?? null,
    attestation: attestationValue(input.request, input.identifiedPatientContext),
    sources: input.sources.map((s) => s.id),
    fork_commit: input.forkCommit,
    stock_tag: input.stockTag,
    tau: input.tau,
  };
}

/** True or false when it matters (identified patient in context) or was given; otherwise null. */
function attestationValue(request: AskRequest, identifiedPatientContext: boolean): boolean | null {
  if (typeof request.attestation === "boolean") return request.attestation;
  return identifiedPatientContext ? false : null;
}

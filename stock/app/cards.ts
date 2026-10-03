// Assembles answer cards from a decision: one mode card, or the labeled
// multi-intent card whose alternatives are mode cards in display order.
import type { Classification } from "../intent/classifier.js";
import type { Decision } from "../intent/decide.js";
import type { Signal } from "../intent/signals.js";
import { administrativeAnswer } from "../policies/administrative.js";
import { clinicalAnswer } from "../policies/clinical.js";
import { SYNTHETIC_NOTICE, enforceContract, type Draft } from "../policies/contracts.js";
import { researchAnswer } from "../policies/research.js";
import { composeBody } from "./body.js";
import type { ForkConfig } from "./config.js";
import { runTimeRecord } from "./ledger.js";
import type { AnswerCard, AskRequest, ForkEnv, Mode, SourceRef } from "./types.js";

export interface CardContext {
  request: AskRequest;
  env: ForkEnv;
  decision: Decision;
  classification: Classification;
  signals: Signal[];
  config: ForkConfig;
  answerId: string;
}

const MODE_LABEL: Record<Mode, string> = { clinical: "Clinical", research: "Research", administrative: "Administrative" };

export async function buildCard(ctx: CardContext): Promise<AnswerCard> {
  const { decision } = ctx;
  if (decision.mode !== "multi") return modeCard(decision.mode, ctx, ctx.answerId, decision.confidence);
  return multiCard(ctx);
}

export function draftFor(mode: Mode, ctx: CardContext): Draft {
  const { request, env, decision } = ctx;
  const draft =
    mode === "clinical"
      ? clinicalAnswer({ question: request.question, context: request.context, data: env.data })
      : mode === "research"
        ? researchAnswer({ question: request.question, attested: decision.identifiedPatientContext && request.attestation === true })
        : administrativeAnswer({ question: request.question, context: request.context, data: env.data });
  return enforceContract(draft, { researchNeedsAttestation: decision.researchNeedsAttestation });
}

async function modeCard(mode: Mode, ctx: CardContext, answerId: string, confidence: number): Promise<AnswerCard> {
  const draft = draftFor(mode, ctx);
  const { body, wording } = await composeBody(mode, draft.facts, ctx.env.llm, { held: draft.requires_attestation === true });
  const signals = signalLabels(ctx, wording);
  const card: AnswerCard = {
    answer_id: answerId,
    mode,
    confidence: round(confidence),
    distribution: roundedDistribution(ctx),
    signals,
    override_available: true,
    computed_dose: draft.computed_dose,
    sources: draft.sources,
    framing: draft.framing,
    body,
    tau: ctx.decision.tau,
    ledger: record(ctx, answerId, mode, confidence, signals, draft.sources),
  };
  if (draft.requires_attestation) card.requires_attestation = true;
  return card;
}

async function multiCard(ctx: CardContext): Promise<AnswerCard> {
  const { decision, classification } = ctx;
  const alternatives = await Promise.all(
    decision.answerModes.map((mode) => modeCard(mode, ctx, `${ctx.answerId}-${mode}`, classification.distribution[mode])),
  );
  const sources = uniqueSources(alternatives.flatMap((a) => a.sources));
  const signals = signalLabels(ctx, "template");
  const framing = [
    SYNTHETIC_NOTICE,
    decision.currentPatientDosing
      ? "The question describes a current patient, so the clinical answer is shown first; labeled answers are shown for each plausible intent."
      : `Top intent confidence ${round(decision.confidence)} is below the threshold ${decision.tau}; labeled answers are shown for each plausible intent.`,
    ...(decision.optionB ? ["Clinical answer shown first because a clinical signal is present; other answers are one tap away."] : []),
  ];
  const labels = decision.answerModes.map((m) => `${MODE_LABEL[m]} (${round(classification.distribution[m])})`);
  const card: AnswerCard = {
    answer_id: ctx.answerId,
    mode: "multi",
    confidence: round(decision.confidence),
    distribution: roundedDistribution(ctx),
    signals,
    override_available: true,
    computed_dose: null,
    sources,
    framing,
    body: `Intent is unclear, so this answer is shown per intent: ${labels.join(", ")}. Choose a mode to answer in that mode.`,
    alternatives,
    tau: decision.tau,
    ledger: record(ctx, ctx.answerId, "multi", decision.confidence, signals, sources),
  };
  if (alternatives.some((a) => a.requires_attestation)) card.requires_attestation = true;
  return card;
}

function record(ctx: CardContext, answerId: string, intent: Mode | "multi", confidence: number, signals: string[], sources: SourceRef[]) {
  return runTimeRecord({
    answerId,
    intent,
    confidence: round(confidence),
    signals,
    sources,
    request: ctx.request,
    identifiedPatientContext: ctx.decision.identifiedPatientContext,
    forkCommit: ctx.env.forkCommit ?? "uncommitted",
    stockTag: ctx.config.stockTag,
    tau: ctx.decision.tau,
  });
}

function signalLabels(ctx: CardContext, wording: string): string[] {
  const labels = ctx.signals.map((s) => s.label);
  return wording === "template" ? labels : [...labels, `wording:${wording}`];
}

function roundedDistribution(ctx: CardContext): Record<Mode, number> {
  const d = ctx.classification.distribution;
  return { clinical: round(d.clinical), research: round(d.research), administrative: round(d.administrative) };
}

function uniqueSources(sources: SourceRef[]): SourceRef[] {
  return sources.filter((s, i) => sources.findIndex((o) => o.id === s.id) === i);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

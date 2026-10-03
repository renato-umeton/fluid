// Platform-side safety checks on answers before they reach a user.
// - A clinical card (or clinical alternative) never carries a computed dose.
//   The fork's floor already forbids it; this is the backstop in production.
// - When a fork is served by stock instead of its own code (safety fallback
//   after a grace period, or the clinical dose backstop), the card says so
//   with a signal and a framing line, and the ledger records the signal.
import type { AnswerCardLike } from "../runtime/loader.ts";

export const SAFETY_SIGNALS = {
	/** A safety release's grace period ended and the fork still fails it: stock answered. */
	stockFallback: "safety_fallback:stock",
	/** The fork answered a clinical card with a computed dose: refused, stock answered. */
	clinicalDose: "safety_guard:clinical_dose",
} as const;

type CardShape = { mode?: unknown; computed_dose?: unknown; alternatives?: unknown };

export function hasClinicalDose(card: CardShape): boolean {
	const clinical = (c: CardShape) => c?.mode === "clinical" && c.computed_dose !== null && c.computed_dose !== undefined;
	if (clinical(card)) return true;
	return Array.isArray(card.alternatives) && (card.alternatives as CardShape[]).some(clinical);
}

export function markSafety(card: AnswerCardLike, signal: string, note: string): AnswerCardLike {
	const signals = Array.isArray(card.signals) ? (card.signals as string[]) : [];
	const framing = Array.isArray(card.framing) ? (card.framing as string[]) : [];
	const ledgerSignals = Array.isArray(card.ledger?.signals) ? (card.ledger.signals as string[]) : [];
	return { ...card, signals: [signal, ...signals], framing: [note, ...framing], ledger: { ...card.ledger, signals: [signal, ...ledgerSignals] } };
}

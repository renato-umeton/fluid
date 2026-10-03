// Safety constants owned by the mothership. Forks may change these files, but
// the invariant suite (read from stock at the pinned tag) checks the behavior.

/** Minimum confidence to answer in a single mode. Users may raise it, never lower it. */
export const STOCK_MIN_TAU = 0.85;

/** An identified chart open or active order entry puts clinical at least here. */
export const IDENTIFIED_CONTEXT_CLINICAL_FLOOR = 0.9;

/**
 * Being on service is a smaller bump. At 0.2, research can reach at most 0.8,
 * which is below the stock tau, so a dosing question asked while on service
 * always shows the clinical answer first.
 */
export const ON_SERVICE_CLINICAL_FLOOR = 0.2;

/** Below tau, an intent is shown as a labeled alternative if it reaches this. */
export const PLAUSIBLE_INTENT_MIN = 0.1;

export function effectiveTau(configured: number | undefined | null): number {
  if (configured === undefined || configured === null || !Number.isFinite(configured)) return STOCK_MIN_TAU;
  return Math.min(1, Math.max(STOCK_MIN_TAU, configured));
}

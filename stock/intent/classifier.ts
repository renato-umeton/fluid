// Turns signals into a probability distribution over the three intents.
// Evidence is summed per mode and normalized with a softmax; hard-context
// floors are applied afterwards so soft evidence can never outvote them.
import { MODES, type Mode } from "../app/types.js";
import type { Signal } from "./signals.js";

export type Distribution = Record<Mode, number>;

export interface Classification {
  distribution: Distribution;
  /** The clinical floor that was imposed, if any. */
  floor: number | null;
}

export function classify(signals: Signal[]): Classification {
  const scores = sumEvidence(signals);
  const floors = signals.map((s) => s.clinicalFloor).filter((f): f is number => f !== undefined);
  const floor = floors.length > 0 ? Math.max(...floors) : null;
  const distribution = softmax(scores);
  return { distribution: floor === null ? distribution : applyFloor(distribution, floor), floor };
}

export function applyFloor(distribution: Distribution, floor: number): Distribution {
  if (distribution.clinical >= floor) return distribution;
  const rest = 1 - distribution.clinical;
  const scale = (1 - floor) / rest;
  return {
    clinical: floor,
    research: distribution.research * scale,
    administrative: distribution.administrative * scale,
  };
}

export function topIntent(distribution: Distribution): Mode {
  return MODES.reduce((best, mode) => (distribution[mode] > distribution[best] ? mode : best));
}

function sumEvidence(signals: Signal[]): Distribution {
  const scores: Distribution = { clinical: 0, research: 0, administrative: 0 };
  for (const signal of signals) {
    for (const mode of MODES) scores[mode] += signal.evidence[mode] ?? 0;
  }
  return scores;
}

function softmax(scores: Distribution): Distribution {
  const max = Math.max(...MODES.map((m) => scores[m]));
  const exp = MODES.map((m) => Math.exp(scores[m] - max));
  const total = exp.reduce((a, b) => a + b, 0);
  return { clinical: exp[0]! / total, research: exp[1]! / total, administrative: exp[2]! / total };
}

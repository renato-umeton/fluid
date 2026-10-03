// Synthetic call schedule connector: is a persona on service at a moment?
import type { Shift, SyntheticData } from "./types.js";

export function currentShift(data: SyntheticData | undefined, personaId: string, atIso: string): Shift | null {
  const at = Date.parse(atIso);
  return data?.callSchedule?.shifts.find((s) => s.personaId === personaId && Date.parse(s.start) <= at && at < Date.parse(s.end)) ?? null;
}

export function isOnService(data: SyntheticData | undefined, personaId: string, atIso: string): boolean {
  return currentShift(data, personaId, atIso) !== null;
}

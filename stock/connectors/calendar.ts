// Synthetic calendar connector: the event a persona is in at a moment.
import type { CalendarEvent, SyntheticData } from "./types.js";

export function currentEvent(data: SyntheticData | undefined, personaId: string, atIso: string): CalendarEvent | null {
  const at = Date.parse(atIso);
  return data?.calendars?.events.find((e) => e.personaId === personaId && Date.parse(e.start) <= at && at < Date.parse(e.end)) ?? null;
}

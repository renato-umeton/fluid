// Derives the schedule-based context signals for a persona at a moment, so the
// platform can fill ContextSignals.onService and calendarEvent from stock data.
import type { ContextSignals } from "../app/types.js";
import { currentEvent } from "./calendar.js";
import { isOnService } from "./call-schedule.js";
import type { SyntheticData } from "./types.js";

export function scheduleContext(data: SyntheticData | undefined, personaId: string, atIso: string): Pick<ContextSignals, "onService" | "calendarEvent"> {
  return {
    onService: isOnService(data, personaId, atIso),
    calendarEvent: currentEvent(data, personaId, atIso)?.title ?? null,
  };
}

// Intent replay. A Fluid fork is a list of wishes and the tests that prove
// them. Recipe changes (tau, ui, REDCap, and the seeded framing wording)
// record in their intent record how to run them again: `replay` is
// { kind, params }. On a stock release the platform can then rebuild the
// fork from fresh stock at the new tag by running each wish again in commit
// order, instead of merging old text. Model-written changes record
// { kind: "model", request } and are not replayed: a fork with one of them
// upgrades by merge, as before.
import { cleanText, MAX_REQUEST_CHARS } from "./intent.ts";
import type { PlannedChange } from "./recipes.ts";
import type { UiReplayParams } from "./ui-recipe.ts";

export type ReplaySpec =
	| { kind: "redcap"; params: { protocols: string[] } }
	| { kind: "tau"; params: { value: number } }
	| { kind: "ui"; params: UiReplayParams }
	| { kind: "framing"; params: { line: string } }
	| { kind: "model"; request: string };

export type ReplayKind = ReplaySpec["kind"];

/** Kinds the platform can run again deterministically. */
export const REPLAYABLE_KINDS: readonly ReplayKind[] = ["redcap", "tau", "ui", "framing"];

/** The replay field for a new intent record: the recipe's own, the request for a model plan, or none. */
export function replayRecordFor(change: Pick<PlannedChange, "recipe" | "replay">, request: string): ReplaySpec | null {
	if (change.replay) return change.replay;
	if (change.recipe === "model") return { kind: "model", request: cleanText(request, MAX_REQUEST_CHARS) };
	return null;
}

/** Spread into an intent record: the replay field when there is one, nothing otherwise (older records have none). */
export function replayExtra(spec: ReplaySpec | null | undefined): { replay?: ReplaySpec } {
	return spec ? { replay: spec } : {};
}

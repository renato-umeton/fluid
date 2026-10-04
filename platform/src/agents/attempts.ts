// Plan, check, and load a customization, repairing model-written changes.
// Every failure to validate, transform, or load a candidate goes back to the
// model with the exact error, at most MAX_REPAIRS times. If the change still
// cannot be loaded, the run ends with a user-facing explanation (what was
// attempted, why it could not be loaded, what to try) and nothing is
// committed: the loop runs before any branch is written.
import type { PlannedChange } from "./recipes.ts";

export const MAX_REPAIRS = 2;
const MODEL_ERROR_CHARS = 2000;
const USER_ERROR_CHARS = 300;

/** A problem with the candidate change itself (not the platform): it is shown to the model and the user. */
export class CandidateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CandidateError";
	}
}

export interface AttemptHooks {
	/** Plans the change. `feedback` is the exact error of the previous attempt (null on the first). Throw CandidateError for a rejected plan. */
	plan(feedback: string | null, attempt: number): Promise<PlannedChange>;
	/** Checks and loads the candidate; any throw is a candidate failure. */
	validate(change: PlannedChange): Promise<void>;
	/** Progress callback after a failed attempt. */
	onFailure?(attempt: number, error: string, willRetry: boolean): Promise<void>;
}

export type AttemptResult =
	| { ok: true; change: PlannedChange; attempts: number }
	| { ok: false; attempts: number; error: string; lastSummary: string | null };

/**
 * Runs plan then validate, feeding each failure back into the next plan.
 * `maxRepairs` is 0 for deterministic recipes (a repeat would fail the same
 * way). Errors from plan() other than CandidateError (the model service is
 * unreachable, for example) are thrown for the workflow step to retry.
 */
export async function planWithRepairs(hooks: AttemptHooks, maxRepairs = MAX_REPAIRS): Promise<AttemptResult> {
	let feedback: string | null = null;
	let lastSummary: string | null = null;
	let error = "";
	const total = maxRepairs + 1;
	for (let attempt = 1; attempt <= total; attempt++) {
		try {
			const change = await hooks.plan(feedback, attempt);
			lastSummary = change.summary;
			try {
				await hooks.validate(change);
				return { ok: true, change, attempts: attempt };
			} catch (validation) {
				error = errorMessage(validation);
			}
		} catch (planning) {
			if (!(planning instanceof CandidateError)) throw planning;
			error = planning.message;
		}
		const willRetry = attempt < total;
		await hooks.onFailure?.(attempt, error, willRetry);
		feedback = error.slice(0, MODEL_ERROR_CHARS);
	}
	return { ok: false, attempts: total, error, lastSummary };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** First line of an error, without stack frames or tokens, short enough for the run view. */
export function userFacingError(error: string): string {
	const line = String(error ?? "")
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l && !/^at\s/.test(l)) ?? "unknown error";
	const clean = line.replace(/art_v\d+_[A-Za-z0-9_-]+(\?expires=\d+)?/g, "<redacted-token>").replace(/\s+/g, " ");
	return clean.length > USER_ERROR_CHARS ? `${clean.slice(0, USER_ERROR_CHARS - 3)}...` : clean;
}

/** The message a failed customization ends with. */
export function failureExplanation(input: { attempts: number; error: string; lastSummary: string | null; model: boolean }): string {
	const tries = input.model ? `${input.attempts} attempt${input.attempts === 1 ? "" : "s"} (the first plan and ${input.attempts - 1} repair${input.attempts - 1 === 1 ? "" : "s"} with the error sent back to the agent)` : "the fixed recipe";
	const attempted = input.lastSummary ? `Attempted: ${input.lastSummary}.` : "Attempted: a plan for this request, but no plan passed the file checks.";
	return [
		"Fluid could not apply this change, so nothing was committed: no branch was written and main is unchanged.",
		attempted,
		`Why it could not be loaded, after ${tries}: ${userFacingError(input.error)}.`,
		"What you can try: ask for a smaller change and name the answer mode or file it should affect. For look and layout (fonts, density, accent colors, a tab with charts), ask for that directly, for example \"Use Palatino fonts and add a tab with charts\"; those go into ui/preferences.json without code.",
	].join(" ");
}

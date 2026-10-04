// Yellow to green lifecycle of a fork's main (pure). Every change that passes
// the gate lands on main in the yellow state. The end-to-end suite then runs
// against the live fork; SOAK_PASSES consecutive passes turn it green, and a
// failure rolls main back to the last green commit. The Fleet Durable Object
// stores this state per fork and appends every event to the fork's history.

export type Health = "yellow" | "green" | "rolled_back";
export const HEALTHS: readonly Health[] = ["yellow", "green", "rolled_back"];

/** Consecutive passing runs of the end-to-end suite that turn a yellow fork green. */
export const SOAK_PASSES = 3;

export interface HealthFailure {
	tier: string;
	scenario: string;
	step: string | null;
	detail: string;
}

export interface BrowserSummary {
	status: "passed" | "failed" | "unavailable" | "skipped";
	detail: string;
}

export interface HealthState {
	health: Health;
	/** The commit this state is about: the yellow commit, the green commit, or the revert commit after a rollback. */
	commit: string | null;
	lastGreenCommit: string | null;
	/** The yellow run that may still change this state. */
	runId: string | null;
	pass: number;
	of: number;
	since: string;
	source: string | null;
	failure: HealthFailure | null;
	browser: BrowserSummary | null;
	/** After a rollback: the yellow commit that failed. */
	rolledBackFrom: string | null;
}

export type HealthEventKind = "yellow" | "pass" | "green" | "failed" | "rolled_back" | "superseded" | "cancelled" | "browser";

export interface HealthEvent {
	at: string;
	event: HealthEventKind;
	commit: string | null;
	runId: string | null;
	detail: string;
}

export interface Transition {
	state: HealthState;
	events: HealthEvent[];
	/** True when the run is no longer the fork's current yellow run: nothing changed. */
	stale?: boolean;
}

/** A fork with no recorded history is green at its current main (the commit is filled in when its first change lands). */
export function initialHealth(at = new Date(0).toISOString()): HealthState {
	return { health: "green", commit: null, lastGreenCommit: null, runId: null, pass: 0, of: SOAK_PASSES, since: at, source: null, failure: null, browser: null, rolledBackFrom: null };
}

/**
 * A gated change landed on main at `commit`. `previous` is main before the
 * change: a fork with no history treats it as its last green commit. A newer
 * change supersedes a yellow run that is still soaking; the last green commit
 * stays the one before both.
 */
export function startYellow(state: HealthState, input: { commit: string; runId: string; previous: string | null; source: string; at: string }): Transition {
	if (state.health === "yellow" && state.runId === input.runId) return { state, events: [] };
	const events: HealthEvent[] = [];
	if (state.health === "yellow" && state.runId) {
		events.push({ at: input.at, event: "superseded", commit: state.commit, runId: state.runId, detail: `${short(input.commit)} landed on main before ${short(state.commit)} finished its soak; the newer run decides` });
	}
	const lastGreenCommit = state.lastGreenCommit ?? (state.health === "green" ? (state.commit ?? input.previous) : input.previous);
	events.push({ at: input.at, event: "yellow", commit: input.commit, runId: input.runId, detail: `Live on main in yellow after the gate (${input.source}); last green ${lastGreenCommit ? short(lastGreenCommit) : "unknown"}` });
	return {
		state: { health: "yellow", commit: input.commit, lastGreenCommit, runId: input.runId, pass: 0, of: SOAK_PASSES, since: input.at, source: input.source, failure: null, browser: null, rolledBackFrom: null },
		events,
	};
}

/** One full run of the suite passed. The SOAK_PASSES-th consecutive pass turns the fork green. */
export function recordPass(state: HealthState, input: { runId: string; pass: number; at: string }): Transition {
	if (state.health !== "yellow" || state.runId !== input.runId) return { state, events: [], stale: true };
	const pass = Math.max(state.pass, input.pass);
	if (pass < state.of) {
		return { state: { ...state, pass }, events: [{ at: input.at, event: "pass", commit: state.commit, runId: input.runId, detail: `Soak pass ${pass} of ${state.of} passed` }] };
	}
	return {
		state: { ...state, health: "green", pass, lastGreenCommit: state.commit, runId: null, since: input.at, failure: null },
		events: [{ at: input.at, event: "green", commit: state.commit, runId: input.runId, detail: `${state.of} consecutive passes; ${short(state.commit)} is the last green commit` }],
	};
}

/** Records the once-per-yellow-period browser tier result on the current run. */
export function recordBrowser(state: HealthState, input: { runId: string; browser: BrowserSummary; at: string }): Transition {
	if (state.health !== "yellow" || state.runId !== input.runId) return { state, events: [], stale: true };
	return { state: { ...state, browser: input.browser }, events: [{ at: input.at, event: "browser", commit: state.commit, runId: input.runId, detail: `Browser checks ${input.browser.status}: ${input.browser.detail}` }] };
}

/**
 * The suite failed. With `revertCommit`, main was moved back to the last
 * green commit by that new commit: the fork is rolled back. Without it
 * (no earlier green commit to return to), the fork stays yellow with the
 * failure recorded and no run left to change it.
 */
export function recordFailure(state: HealthState, input: { runId: string; failure: HealthFailure; revertCommit: string | null; at: string }): Transition {
	if (state.health !== "yellow" || state.runId !== input.runId) return { state, events: [], stale: true };
	const failed: HealthEvent = { at: input.at, event: "failed", commit: state.commit, runId: input.runId, detail: `${input.failure.tier} scenario ${input.failure.scenario}${input.failure.step ? ` failed at step ${input.failure.step}` : " failed"}: ${input.failure.detail}` };
	if (!input.revertCommit) {
		return { state: { ...state, runId: null, failure: input.failure }, events: [failed] };
	}
	return {
		state: { ...state, health: "rolled_back", commit: input.revertCommit, runId: null, since: input.at, failure: input.failure, rolledBackFrom: state.commit },
		events: [failed, { at: input.at, event: "rolled_back", commit: input.revertCommit, runId: input.runId, detail: `main moved back to the tree of ${short(state.lastGreenCommit)} with revert commit ${short(input.revertCommit)}` }],
	};
}

/** The run stopped without a verdict (main moved on). Only the current run changes the state. */
export function cancelRun(state: HealthState, input: { runId: string; reason: string; at: string }): Transition {
	const event: HealthEvent = { at: input.at, event: "cancelled", commit: state.runId === input.runId ? state.commit : null, runId: input.runId, detail: input.reason };
	if (state.health !== "yellow" || state.runId !== input.runId) return { state, events: [event], stale: true };
	return { state: { ...state, runId: null }, events: [event] };
}

/** The display color for a fork in the fleet grid: yellow and rolled back win over an idle status. */
export function displayStatus(status: string, health: Health): string {
	const idle = status === "pinned" || status === "passed";
	if (health === "yellow" && idle) return "yellow";
	if (health === "rolled_back" && (idle || status === "repair_open")) return "rolled_back";
	return status;
}

function short(sha: string | null): string {
	return sha ? sha.slice(0, 7) : "unknown";
}

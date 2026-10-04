// Fleet baseline. Forks that existed before Stage 6 read as green without
// ever passing the end-to-end suite. A baseline is one dry run of the
// end-to-end tiers against each fork's current main: it records whether the
// fork passes, and a fork that fails is flagged for review. A baseline never
// changes main or the fork's health, so nothing is rolled back.
import type { HealthFailure } from "./state.ts";
import type { E2ERunResult } from "./run.ts";

export const BASELINE_LIMITS = { maxPage: 25, defaultPage: 10, maxConcurrency: 8, defaultConcurrency: 4 };

export interface BaselineRecord {
	at: string;
	commit: string;
	stockTag: string | null;
	runner: string;
	passed: boolean;
	failure: HealthFailure | null;
	durationMs: number;
}

export function baselineRecord(run: E2ERunResult): BaselineRecord {
	const f = run.failures[0];
	const failure = f ? { tier: f.tier, scenario: f.scenario, step: f.step, detail: `${f.path || "result"} ${f.op}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`.slice(0, 400) } : null;
	return { at: run.at, commit: run.commit, stockTag: run.stockTag, runner: run.runner, passed: run.passed, failure: run.passed ? null : failure, durationMs: run.durationMs };
}

/** One bounded slice of the fleet, and the offset of the next slice (null after the last). */
export function baselinePage(repos: string[], input: { offset: number; limit: number }): { repos: string[]; next: number | null } {
	const offset = Math.max(0, Math.floor(input.offset));
	const limit = Math.min(BASELINE_LIMITS.maxPage, Math.max(1, Math.floor(input.limit)));
	const page = repos.slice(offset, offset + limit);
	return { repos: page, next: offset + limit < repos.length ? offset + limit : null };
}

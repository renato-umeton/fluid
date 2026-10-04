// Landing a gated change on main is a push followed by the start of its
// yellow run. A workflow step (or a client) that retries after the push
// succeeded finds main already at the commit; the change still has to soak.

/**
 * True when main is exactly `commit` and the fork's health is about another
 * commit: an earlier attempt pushed the change but did not start its yellow
 * run. Starting the run again is safe, since it is keyed by (repo, commit).
 */
export function landedEarlier(input: { mainHead: string; commit: string; healthCommit: string | null }): boolean {
	return input.mainHead === input.commit && input.healthCommit !== input.commit;
}

// Limits on notMatches patterns that come from a fork (tier 3 probes, user
// end-to-end scenarios), the same as stock's tests/runner.ts from v1.11.0 on.
// The platform checks them itself, because a fork may pin a stock tag whose
// runner predates the limits: a pattern is capped in length and may not nest
// an unbounded quantifier inside another one, the shape that makes a regex
// backtrack for exponential time.

export const REGEX_LIMITS = { maxLength: 200 };

/** Why a notMatches value ("/pattern/flags" or a plain pattern) is refused, or null when it is acceptable. */
export function regexProblem(source: string): string | null {
	const literal = /^\/(.*)\/([a-z]*)$/s.exec(source);
	const pattern = literal ? literal[1]! : source;
	if (pattern.length > REGEX_LIMITS.maxLength) return `pattern must be at most ${REGEX_LIMITS.maxLength} characters, got ${pattern.length}`;
	return hasNestedQuantifier(pattern) ? "nested quantifier: a group with an unbounded quantifier (+, *, {n,}) inside may not repeat without bound" : null;
}

/** notMatches values anywhere in an assertion (including some and every). */
export function notMatchesIn(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(notMatchesIn);
	if (!value || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, v]) => (key === "notMatches" && typeof v === "string" ? [v] : notMatchesIn(v)));
}

/** True when a group that contains an unbounded quantifier is itself followed by one, as in (a+)+. */
function hasNestedQuantifier(pattern: string): boolean {
	// One flag per open group: does it contain an unbounded quantifier so far?
	const groups: boolean[] = [];
	let inner = false;
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i]!;
		if (ch === "\\") i++;
		else if (ch === "[") i = classEnd(pattern, i);
		else if (ch === "(") {
			groups.push(inner);
			inner = false;
			continue;
		} else if (ch === ")") {
			if (inner && unboundedAt(pattern, i + 1)) return true;
			inner = (groups.pop() ?? false) || inner;
		}
		if (unboundedAt(pattern, i + 1)) inner = true;
	}
	return false;
}

function classEnd(pattern: string, start: number): number {
	for (let i = start + 1; i < pattern.length; i++) {
		if (pattern[i] === "\\") i++;
		else if (pattern[i] === "]" && i > start + 1) return i;
	}
	return pattern.length;
}

function unboundedAt(pattern: string, i: number): boolean {
	const ch = pattern[i];
	if (ch === "+" || ch === "*") return true;
	return ch === "{" && /^\{\d+,\}/.test(pattern.slice(i));
}

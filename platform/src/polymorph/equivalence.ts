// Compares an answer card from a plain fork with the card its polymorphic
// copy gave for the same request. Every value must match exactly: every
// character of every string, every element of every array. Only answer_id
// (random per answer) and fork_commit (differs per commit) are ignored, at any
// depth. A card reaches the platform as JSON, so a key whose value is
// undefined counts as absent, key order does not matter, and a Date, Map, or
// other non-plain object is compared by its JSON form. equivalenceCheck runs
// that comparison on every request a gate sends.

export interface CardDifference {
	/** Dotted path into the card, as probe assertions write it ("" is the whole card). */
	path: string;
	plain: unknown;
	morphed: unknown;
}

const IGNORED_KEYS: ReadonlySet<string> = new Set(["answer_id", "fork_commit"]);

/** Up to limit differences between two cards, in document order; an empty list means the cards are equivalent. */
export function cardDifferences(plain: unknown, morphed: unknown, limit = 20): CardDifference[] {
	if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`cardDifferences: limit must be a positive integer, got ${limit}`);
	const differences: CardDifference[] = [];
	compare(plain, morphed, "", differences, limit);
	return differences;
}

function compare(plain: unknown, morphed: unknown, path: string, out: CardDifference[], limit: number): void {
	if (out.length >= limit || Object.is(plain, morphed)) return;
	if (Array.isArray(plain) && Array.isArray(morphed) && plain.length === morphed.length) {
		for (let i = 0; i < plain.length; i++) compare(plain[i], morphed[i], joinPath(path, String(i)), out, limit);
		return;
	}
	if (isPlainRecord(plain) && isPlainRecord(morphed)) {
		for (const key of new Set([...keysOf(plain), ...keysOf(morphed)])) compare(plain[key], morphed[key], joinPath(path, key), out, limit);
		return;
	}
	if ((isOtherObject(plain) || isOtherObject(morphed)) && sameJson(plain, morphed)) return;
	// Different types, different values, or arrays of different lengths (reported whole rather than as shifted elements).
	out.push({ path, plain, morphed });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** A Date, Map, class instance, or other object that is neither an array nor a plain record. */
function isOtherObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !isPlainRecord(value);
}

/** Whether two values serialize to the same JSON; a value with no JSON form (a BigInt, a cycle) counts as different. */
function sameJson(plain: unknown, morphed: unknown): boolean {
	try {
		return JSON.stringify(plain) === JSON.stringify(morphed);
	} catch {
		return false;
	}
}

function keysOf(record: Record<string, unknown>): string[] {
	return Object.keys(record).filter((key) => !IGNORED_KEYS.has(key) && record[key] !== undefined);
}

function joinPath(path: string, key: string): string {
	return path === "" ? key : `${path}.${key}`;
}

export type Ask = (request: unknown) => Promise<unknown>;

export interface EquivalenceFinding {
	/** The request both sides were asked. */
	request: unknown;
	difference: CardDifference;
}

export interface EquivalenceReport {
	/** Requests sent to both sides. */
	compared: number;
	/** Requests the two sides answered differently. */
	mismatches: number;
	/** The first differences found, in the order found, up to the limit. */
	findings: EquivalenceFinding[];
	/** Whether more differences were found than findings holds: then only mismatches says how many requests differed. */
	truncated: boolean;
}

/**
 * Compares a plain fork with its renamed copy on every request: ask sends the
 * request to both at once and answers with what the copy did, its card or its
 * error, so whoever asks sees the copy. Two cards are compared with
 * cardDifferences. Two errors match when their messages do; a card on one side
 * and an error on the other is a difference at the whole answer. Both asks
 * must already map the copy's names back (askLoaded), or every renamed name in
 * a message would count as a difference.
 */
export function equivalenceCheck(plain: Ask, copy: Ask, limit: number): { ask: Ask; report(): EquivalenceReport } {
	if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`equivalenceCheck: limit must be a positive integer, got ${limit}`);
	let compared = 0;
	let mismatches = 0;
	let truncated = false;
	const findings: EquivalenceFinding[] = [];
	const ask: Ask = async (request) => {
		const [plainOutcome, copyOutcome] = await Promise.allSettled([plain(request), copy(request)]);
		compared++;
		const differences = outcomeDifferences(plainOutcome, copyOutcome);
		if (differences.length > 0) mismatches++;
		for (const difference of differences) {
			if (findings.length < limit) findings.push({ request, difference });
			else truncated = true;
		}
		if (copyOutcome.status === "rejected") throw copyOutcome.reason;
		return copyOutcome.value;
	};
	return { ask, report: () => ({ compared, mismatches, findings: [...findings], truncated }) };
}

function outcomeDifferences(plain: PromiseSettledResult<unknown>, copy: PromiseSettledResult<unknown>): CardDifference[] {
	if (plain.status === "fulfilled" && copy.status === "fulfilled") return cardDifferences(plain.value, copy.value);
	if (plain.status === "rejected" && copy.status === "rejected" && messageOf(plain.reason) === messageOf(copy.reason)) return [];
	return [{ path: "", plain: outcomeOf(plain), morphed: outcomeOf(copy) }];
}

/** A card as it is, an error as "threw: " and its message. */
function outcomeOf(settled: PromiseSettledResult<unknown>): unknown {
	return settled.status === "fulfilled" ? settled.value : `threw: ${messageOf(settled.reason)}`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

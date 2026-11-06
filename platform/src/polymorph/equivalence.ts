// Compares an answer card from a plain fork with the card its polymorphic
// copy gave for the same request. Every value must match exactly: every
// character of every string, every element of every array. Only answer_id
// (random per answer) and fork_commit (differs per commit) are ignored, at any
// depth. Cards are JSON data, so a key whose value is undefined counts as
// absent and key order does not matter.

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
	if (isRecord(plain) && isRecord(morphed)) {
		for (const key of new Set([...keysOf(plain), ...keysOf(morphed)])) compare(plain[key], morphed[key], joinPath(path, key), out, limit);
		return;
	}
	// Different types, different values, or arrays of different lengths (reported whole rather than as shifted elements).
	out.push({ path, plain, morphed });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keysOf(record: Record<string, unknown>): string[] {
	return Object.keys(record).filter((key) => !IGNORED_KEYS.has(key) && record[key] !== undefined);
}

function joinPath(path: string, key: string): string {
	return path === "" ? key : `${path}.${key}`;
}

// Original names as tripwires. A running copy only ever uses its own renamed
// names, and requests never name internals at all, so a request key that is
// an original listed name (a decoy) was built from upstream's public source,
// and one that is another copy's renamed name (foreign) came from a different
// copy. Either way the request is probing internals and is refused. A renamed
// name anywhere in a string value is refused too, the copy's own included: the
// copy maps its own names back to the originals wherever its answer shows
// them, so an answer that echoed a value would tell a right guess from a wrong
// one.
import { VARIANT_PATTERN } from "./names.ts";

export interface TripwireHit {
	kind: "decoy" | "foreign";
	/** The listed name the key refers to. */
	name: string;
	/** Dotted path of the key, for example "context.display.researchNeedsAttestation". */
	path: string;
}

/**
 * Bounds on the walk, so a huge request cannot make it slow. Legitimate
 * requests stay far below them. A request beyond them is refused rather than
 * scanned in part, so a decoy cannot hide past the bound.
 */
export const TRIPWIRE_LIMITS = { maxDepth: 32, maxKeys: 10_000 } as const;

export class ForkTripwireError extends Error {
	/** Which key tripped which wire, for logs; never part of the message. */
	readonly hit: TripwireHit;

	constructor(hit: TripwireHit) {
		// One message for every hit, so whoever sent the request learns nothing about which wire it tripped.
		super("request refused: it names an internal identifier");
		this.name = "ForkTripwireError";
		this.hit = hit;
	}
}

/**
 * The first request key or string value that trips a wire, or null. Walks
 * plain objects and arrays at any depth. A key trips as a decoy when it is one
 * of these names, and as foreign when it is one of them with another suffix
 * than this copy's. A string value, or a key that is not exactly this copy's
 * own renamed name, trips as foreign when it holds one of these names with
 * any suffix (renamedShape). It expects JSON data, such as a parsed request
 * body: a getter on a plain object runs when its key is walked, and an object
 * with any other prototype (a Date, a Map, a class instance) is not walked.
 * Throws a RangeError for a request deeper or wider than TRIPWIRE_LIMITS:
 * callers refuse such a request.
 */
export function scanRequest(request: unknown, names: ReadonlyMap<string, string>): TripwireHit | null {
	const shape = renamedShape(names);
	const pending: { value: unknown; path: string; depth: number }[] = [{ value: request, path: "", depth: 1 }];
	let visited = 0;
	while (pending.length > 0) {
		const { value, path, depth } = pending.pop()!;
		const isArray = Array.isArray(value);
		if (!isArray && !isPlainObject(value)) continue;
		if (depth > TRIPWIRE_LIMITS.maxDepth) throw new RangeError(`tripwire: request nests deeper than ${TRIPWIRE_LIMITS.maxDepth} levels; refused`);
		const keys = isArray ? null : Object.keys(value);
		const count = isArray ? (value as unknown[]).length : keys!.length;
		visited += count;
		if (visited > TRIPWIRE_LIMITS.maxKeys) throw new RangeError(`tripwire: request has more than ${TRIPWIRE_LIMITS.maxKeys} keys; refused`);
		const children: { value: unknown; path: string; depth: number }[] = [];
		for (let i = 0; i < count; i++) {
			const key = isArray ? String(i) : keys![i]!;
			const child = (value as Record<string, unknown>)[key];
			const keyHit = isArray ? null : (wire(key, names) ?? (isOwnName(key, names) ? null : held(key, shape)));
			const hit = keyHit ?? (typeof child === "string" ? held(child, shape) : null);
			if (hit) return { ...hit, path: joinPath(path, key) };
			if (Array.isArray(child) || isPlainObject(child)) children.push({ value: child, path: joinPath(path, key), depth: depth + 1 });
		}
		// Reversed, so keys are checked in document order.
		for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]!);
	}
	return null;
}

function wire(key: string, names: ReadonlyMap<string, string>): Omit<TripwireHit, "path"> | null {
	if (names.has(key)) return { kind: "decoy", name: key };
	const variant = VARIANT_PATTERN.exec(key);
	if (variant === null) return null;
	const name = variant[1]!;
	const own = names.get(name);
	return own !== undefined && own !== key ? { kind: "foreign", name } : null;
}

function isOwnName(key: string, names: ReadonlyMap<string, string>): boolean {
	const variant = VARIANT_PATTERN.exec(key);
	return variant !== null && names.get(variant[1]!) === key;
}

/**
 * The pattern of any of these names followed by "$" and eight base36
 * characters, anywhere in a text, or null for no names. Built once per names
 * map: a copy's names never change once made.
 */
const shapes = new WeakMap<ReadonlyMap<string, string>, RegExp | null>();

function renamedShape(names: ReadonlyMap<string, string>): RegExp | null {
	let shape = shapes.get(names);
	if (shape === undefined) {
		const listed = [...names.keys()].map(escapeRegExp);
		shape = listed.length === 0 ? null : new RegExp(`(${listed.join("|")})\\$[0-9a-z]{8}`);
		shapes.set(names, shape);
	}
	return shape;
}

/** A foreign hit when text holds one of the names with a suffix (renamedShape). */
function held(text: string, shape: RegExp | null): Omit<TripwireHit, "path"> | null {
	if (shape === null || !text.includes("$")) return null;
	const found = shape.exec(text);
	return found === null ? null : { kind: "foreign", name: found[1]! };
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

const PLAIN_SEGMENT = /^[A-Za-z0-9_$]{1,64}$/;

/** Plain keys as they are; anything else quoted and cut to 64 characters, so a hostile key cannot flood a log line. */
function joinPath(path: string, key: string): string {
	const segment = PLAIN_SEGMENT.test(key) ? key : key.length > 64 ? `${JSON.stringify(key.slice(0, 64))}...` : JSON.stringify(key);
	return path === "" ? segment : `${path}.${segment}`;
}

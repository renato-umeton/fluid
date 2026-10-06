// Behavior diff for a contest. The gate asks the fork one question per probe
// through the host ask callback; the platform keeps the card it got back
// (gate/run.ts, observe). This module compares those cards between main and
// each candidate, probe by probe: which fields were added, removed, or
// changed, and whether the probe passed. Fields that change on every answer
// (answer ids, the fork commit) are ignored. Everything is capped, so the
// result fits in a run record.
import type { Json } from "../lib/json.ts";

export const BEHAVIOR_LIMITS = {
	/** Characters kept from one string in a card. */
	maxString: 300,
	/** Items kept from one list in a card. */
	maxArray: 8,
	/** Nesting kept in a card. */
	maxDepth: 6,
	/** Keys kept per object in a card (the rest are counted under "(more keys)"). */
	maxKeys: 40,
	/** Field changes kept per cell (the total is always counted). */
	maxChangesPerCell: 12,
	/** Probe rows kept in a table (rows with changes come first). */
	maxProbes: 60,
};

/** Keys whose value changes on every answer or every commit, so they never count as a behavior change. */
const VOLATILE_KEYS = new Set(["answer_id", "fork_commit"]);

/**
 * Wording fields of a card (and of its labeled alternatives). A change to only
 * these, in a mode the wish tests ask about, is what the wish targets. Any
 * other field (mode, confidence, dose, attestation, override, ledger) is not.
 */
const WORDING_PATH = /^(alternatives\.\d+\.)?(body|framing|sources)(\.|$)/;

export type ProbeTier = "invariant" | "functional" | "user" | "wish";

/** One probe as the gate ran it on one commit: its result and the card the fork answered with (null for config probes). */
export interface Observation {
	id: string;
	/** Rows are matched by key: the probe id, or "wish:<n>" for a wish test (copies of one test carry different ids). */
	key: string;
	tier: ProbeTier;
	passed: boolean | null;
	question: string | null;
	card: Json | null;
	/** The card was dropped to keep the step output small (contest/observe.ts, capObservations): compare by result only. */
	dropped?: true;
}

export interface FieldChange {
	path: string;
	kind: "added" | "removed" | "changed";
	before?: Json;
	after?: Json;
}

export interface BehaviorCell {
	passed: boolean | null;
	changed: boolean;
	/**
	 * Where a change falls: a wish test, wording in a mode the wish targets,
	 * outside the wish, or "own": a test only this candidate ran (main never
	 * did), such as a test it added itself. "own" never counts toward rule (b).
	 */
	scope?: "wish" | "target" | "outside" | "own";
	/** Number of fields that differ from main's card. */
	total: number;
	changes: FieldChange[];
	/** The candidate did not run this probe (it removed one of your tests, or the probe is another candidate's own test). */
	missing?: true;
}

export interface BehaviorRow {
	id: string;
	key: string;
	tier: ProbeTier;
	question: string | null;
	wish: boolean;
	main: { passed: boolean | null; missing?: true };
	cells: Record<string, BehaviorCell>;
}

export interface CandidateCounts {
	/** Probes outside the wish whose answer or result differs from main. */
	outside: number;
	/** Wish tests whose answer or result differs from main (expected: that is the wish). */
	inside: number;
	/** Other probes whose only change is wording in a mode the wish tests ask about (inside the wish too). */
	target: number;
	/** Tests only this candidate ran (main never did); shown as new tests, never counted against it. */
	own: number;
	wishPassed: number;
	wishTotal: number;
	failingWish: string[];
}

export interface BehaviorTable {
	rows: BehaviorRow[];
	/** Modes the wish tests ask about (the mode of main's answer to each wish test). */
	targetModes: string[];
	/** Rows left out by the cap (none of them has more changes than the rows kept). */
	omitted: number;
	counts: Record<string, CandidateCounts>;
}

/** Canonical JSON (sorted keys), so the same request sent twice has the same key. */
export function requestKey(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

/** What a probe checks, without its id or description: two copies of one test have the same key. */
export function probeContentKey(probe: { kind?: unknown; file?: unknown; request?: unknown; focusMode?: unknown; assert?: unknown }): string {
	return requestKey({ kind: probe.kind ?? "ask", file: probe.file ?? null, request: probe.request ?? null, focusMode: probe.focusMode ?? null, assert: probe.assert ?? [] });
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
	return value;
}

/** A small copy of a card for comparing and storing: no volatile fields, strings and lists clipped, nesting bounded. */
export function compactCard(card: unknown, depth = 0): Json {
	if (card === null || card === undefined) return null;
	if (typeof card === "string") return card.length > BEHAVIOR_LIMITS.maxString ? `${card.slice(0, BEHAVIOR_LIMITS.maxString)}... (${card.length} chars)` : card;
	if (typeof card === "number" || typeof card === "boolean") return card;
	if (depth >= BEHAVIOR_LIMITS.maxDepth) return "(nested too deep)";
	if (Array.isArray(card)) return card.slice(0, BEHAVIOR_LIMITS.maxArray).map((item) => compactCard(item, depth + 1));
	if (typeof card === "object") {
		const out: Record<string, Json> = {};
		const keys = Object.keys(card as Record<string, unknown>).sort().filter((key) => !VOLATILE_KEYS.has(key) && (card as Record<string, unknown>)[key] !== undefined);
		for (const key of keys.slice(0, BEHAVIOR_LIMITS.maxKeys)) out[key] = compactCard((card as Record<string, unknown>)[key], depth + 1);
		if (keys.length > BEHAVIOR_LIMITS.maxKeys) out["(more keys)"] = keys.length - BEHAVIOR_LIMITS.maxKeys;
		return out;
	}
	return String(card);
}

/** Leaf values by dotted path (list items by index). An empty object or list is a leaf of its own. */
function flatten(value: Json, prefix: string, out: Map<string, Json>): Map<string, Json> {
	if (value !== null && typeof value === "object") {
		const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
		if (entries.length === 0) {
			if (prefix) out.set(prefix, value);
			return out;
		}
		for (const [key, child] of entries) flatten(child as Json, prefix ? `${prefix}.${key}` : key, out);
		return out;
	}
	if (prefix) out.set(prefix, value);
	return out;
}

/** Field by field difference between two compacted cards; at most `max` changes are listed, all are counted. */
export function diffCards(before: Json | null, after: Json | null, max = BEHAVIOR_LIMITS.maxChangesPerCell): { changes: FieldChange[]; total: number } {
	const a = flatten(compactCard(before), "", new Map());
	const b = flatten(compactCard(after), "", new Map());
	const changes: FieldChange[] = [];
	let total = 0;
	const add = (change: FieldChange) => {
		total += 1;
		if (changes.length < max) changes.push(change);
	};
	for (const path of [...new Set([...a.keys(), ...b.keys()])]) {
		const inA = a.has(path);
		const inB = b.has(path);
		if (inA && !inB) add({ path, kind: "removed", before: a.get(path)! });
		else if (!inA && inB) add({ path, kind: "added", after: b.get(path)! });
		else if (JSON.stringify(a.get(path)) !== JSON.stringify(b.get(path))) add({ path, kind: "changed", before: a.get(path)!, after: b.get(path)! });
	}
	return { changes, total };
}

/**
 * The behavior diff: one row per probe (matched by key), one cell per
 * candidate. A cell is changed when the card differs from main's or the
 * probe's result differs, or when the candidate no longer runs the probe.
 * A change is inside the wish when the row is a wish test, or when only the
 * wording changed (body, framing, sources) in an answer whose mode the wish
 * tests ask about and the result stayed the same. A test main never ran
 * (one the candidate added itself) is "own": shown as a new test and never
 * counted against the candidate. Everything else is outside.
 * Counts are taken over every row before the cap.
 */
export function behaviorTable(main: Observation[], candidates: { label: string; observations: Observation[] }[], options: { maxProbes?: number } = {}): BehaviorTable {
	const maxProbes = options.maxProbes ?? BEHAVIOR_LIMITS.maxProbes;
	const order: string[] = [];
	const meta = new Map<string, { id: string; tier: ProbeTier; question: string | null }>();
	const remember = (o: Observation) => {
		if (meta.has(o.key)) return;
		order.push(o.key);
		meta.set(o.key, { id: o.id, tier: o.key.startsWith("wish:") ? "wish" : o.tier, question: o.question });
	};
	main.forEach(remember);
	for (const c of candidates) c.observations.forEach(remember);
	const mainBy = new Map(main.map((o) => [o.key, o]));
	const byCandidate = candidates.map((c) => ({ label: c.label, by: new Map(c.observations.map((o) => [o.key, o])) }));
	const counts: Record<string, CandidateCounts> = Object.fromEntries(candidates.map((c) => [c.label, { outside: 0, inside: 0, target: 0, own: 0, wishPassed: 0, wishTotal: 0, failingWish: [] as string[] }]));
	const modeOf = (card: Json | null) => (card && typeof card === "object" && !Array.isArray(card) && typeof card.mode === "string" ? card.mode : null);
	const targetModes = [...new Set(main.filter((o) => o.key.startsWith("wish:")).map((o) => modeOf(o.card)).filter((m): m is string => m !== null && m !== "multi"))].sort();

	const rows: BehaviorRow[] = order.map((key) => {
		const info = meta.get(key)!;
		const base = mainBy.get(key);
		const wish = key.startsWith("wish:");
		const cells: Record<string, BehaviorCell> = {};
		for (const { label, by } of byCandidate) {
			const seen = by.get(key);
			const count = counts[label]!;
			let cell: BehaviorCell;
			// A probe main never ran and this candidate did not run either (another candidate's own test): no change.
			if (!seen) cell = base || wish ? { passed: null, changed: true, total: 0, changes: [], missing: true } : { passed: null, changed: false, total: 0, changes: [], missing: true };
			else if (!base && !wish) {
				// A test only this candidate ran (main never did): new, not a change to existing behavior.
				const full = diffCards(null, seen.card, Number.POSITIVE_INFINITY);
				cell = { passed: seen.passed, changed: true, scope: "own", total: full.total, changes: full.changes.slice(0, BEHAVIOR_LIMITS.maxChangesPerCell) };
			} else {
				const full = base?.dropped || seen.dropped ? { changes: [], total: 0 } : diffCards(base?.card ?? null, seen.card, Number.POSITIVE_INFINITY);
				const sameResult = seen.passed === (base?.passed ?? null);
				cell = { passed: seen.passed, changed: full.total > 0 || !sameResult, total: full.total, changes: full.changes.slice(0, BEHAVIOR_LIMITS.maxChangesPerCell) };
				if (cell.changed && !wish && sameResult && base && targetModes.includes(modeOf(base.card) ?? "") && full.changes.every((c) => WORDING_PATH.test(c.path))) cell.scope = "target";
			}
			if (cell.changed) {
				cell.scope ??= wish ? "wish" : "outside";
				if (cell.scope === "wish") count.inside += 1;
				else if (cell.scope === "target") count.target += 1;
				else if (cell.scope === "own") count.own += 1;
				else count.outside += 1;
			}
			cells[label] = cell;
			if (wish) {
				count.wishTotal += 1;
				if (cell.passed === true) count.wishPassed += 1;
				else count.failingWish.push(info.id);
			}
		}
		return { id: info.id, key, tier: info.tier, question: info.question, wish, main: base ? { passed: base.passed } : { passed: null, missing: true }, cells };
	});

	if (rows.length <= maxProbes) return { rows, targetModes, omitted: 0, counts };
	const changed = (r: BehaviorRow) => Object.values(r.cells).some((c) => c.changed);
	const keep = new Set([...rows.filter(changed), ...rows.filter((r) => !changed(r))].slice(0, maxProbes).map((r) => r.key));
	return { rows: rows.filter((r) => keep.has(r.key)), targetModes, omitted: rows.length - keep.size, counts };
}

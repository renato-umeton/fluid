// Wishes in flight: what every agent is working on in a fork right now.
// Customize and contest runs leave a short note in the Fleet object when they
// plan a change and as it moves on (planned, gating, won, lost to X). The
// wishes route joins those notes with the fork's work/* branches, the intent
// records each branch adds, and the gate results, so the UI or any agent can
// see what else is in progress before it starts.
import type { BuildTimeIntent } from "../forks/provision.ts";
import { cleanText } from "../agents/intent.ts";

export const WISH_LIMITS = {
	/** Notes kept per fork, newest first. */
	maxNotes: 30,
	/** Notes older than this are dropped. */
	maxAgeMs: 48 * 60 * 60 * 1000,
	/** Work branches the route reads. */
	maxBranches: 20,
	/** Records read per branch. */
	maxRecordsPerBranch: 3,
};

export interface WishNote {
	/** Unique per wish: the run id, or "<run id>:<label>" for a contestant. */
	id: string;
	runId: string;
	kind: "customize" | "contest";
	branch: string | null;
	intentId: string | null;
	request: string;
	status: string;
	at: string;
	contest?: { id: string; label: string } | null;
	note?: string;
	/** The run is done with this wish (merged, failed, lost): without its branch it is no longer in flight. */
	final?: boolean;
}

export interface Wish {
	branch: string | null;
	head: string | null;
	intentId: string | null;
	request: string | null;
	purpose: string | null;
	agent: string | null;
	files: string[];
	status: string;
	runId: string | null;
	kind: "customize" | "contest" | "branch";
	contest: { id: string; label: string } | null;
	gate: { passed: boolean; commit: string; at: string } | null;
	note?: string;
}

export function wishNotesKey(repo: string): string {
	return `wishes:${repo}`;
}

/** Adds or replaces one note (by id), newest first, dropping old notes and keeping at most the cap. */
export function upsertWishNote(list: WishNote[], note: WishNote, now = Date.now()): WishNote[] {
	const clean: WishNote = { ...note, request: cleanText(note.request, 500), status: cleanText(note.status, 120), ...(note.note !== undefined ? { note: cleanText(note.note, 300) } : {}) };
	const fresh = list.filter((n) => n.id !== note.id && now - Date.parse(n.at) <= WISH_LIMITS.maxAgeMs);
	return [clean, ...fresh].slice(0, WISH_LIMITS.maxNotes);
}

/**
 * Joins branches, notes, and gate results (newest first). A branch's status
 * comes from its note when a run is following it, otherwise from the gate of
 * its current head, otherwise "open". Notes for runs whose branch is not
 * pushed yet (still planning or waiting for test decisions) come last;
 * finished runs without a branch are left out.
 */
export function listWishes(input: { branches: { branch: string; head: string; records: BuildTimeIntent[] }[]; notes: WishNote[]; gates: { ref?: unknown; commit?: unknown; passed?: unknown; at?: unknown }[] }): Wish[] {
	const used = new Set<string>();
	const wishes: Wish[] = input.branches.map((b) => {
		const note = input.notes.find((n) => n.branch === b.branch);
		if (note) used.add(note.id);
		const record = b.records[0] ?? null;
		const gate = input.gates.find((g) => g.ref === b.branch && g.commit === b.head);
		const gateView = gate ? { passed: gate.passed === true, commit: String(gate.commit), at: String(gate.at ?? "") } : null;
		return {
			branch: b.branch,
			head: b.head,
			intentId: record?.id ?? note?.intentId ?? null,
			request: record?.request ?? note?.request ?? null,
			purpose: record?.purpose ?? null,
			agent: record?.agent ?? null,
			files: record?.files ?? [],
			status: note?.status ?? (gateView ? (gateView.passed ? "gate passed" : "gate failed") : "open"),
			runId: note?.runId ?? null,
			kind: note?.kind ?? "branch",
			contest: note?.contest ?? null,
			gate: gateView,
			...(note?.note ? { note: note.note } : {}),
		};
	});
	for (const n of input.notes) {
		if (used.has(n.id) || n.final) continue;
		// Not pushed yet (still planning or waiting for test decisions): the branch it will use, with no head.
		wishes.push({ branch: n.branch, head: null, intentId: n.intentId, request: n.request, purpose: null, agent: null, files: [], status: n.status, runId: n.runId, kind: n.kind, contest: n.contest ?? null, gate: null, ...(n.note ? { note: n.note } : {}) });
	}
	return wishes;
}

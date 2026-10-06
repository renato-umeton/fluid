// The last few import outcomes per fork, kept in the Fleet object so the
// owner sees why a push from their own agent was or was not imported (a
// refused import has no run record when the quota refuses it). Plain text,
// one line each, capped.
import { cleanText } from "../agents/intent.ts";

export const IMPORT_LOG_LIMIT = 5;

export interface ImportNote {
	at: string;
	/** The inbox branch that was pushed. */
	branch: string;
	/** Short commit id. */
	commit: string;
	status: "imported" | "refused" | "not joined";
	/** Why it was refused, or what happened to it, in plain words. */
	reason: string | null;
	/** The import run, when one was created (a quota refusal has none). */
	runId: string | null;
}

export function importLogKey(fork: string): string {
	return `imports:${fork}`;
}

/** Adds a note, newest first, keeping at most `max`. */
export function addImportNote(list: ImportNote[], note: ImportNote, max = IMPORT_LOG_LIMIT): ImportNote[] {
	const clean: ImportNote = {
		at: note.at,
		branch: cleanText(note.branch, 200),
		commit: cleanText(note.commit, 40).slice(0, 7),
		status: note.status,
		reason: note.reason === null ? null : cleanText(note.reason, 300),
		runId: note.runId,
	};
	return [clean, ...list].slice(0, max);
}

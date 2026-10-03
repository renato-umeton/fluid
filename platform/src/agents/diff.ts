// Line diff statistics for the run view: added, modified, or deleted, with
// +/- line counts. Files here are small (fork sources), so a plain LCS table
// is fine; very large files fall back to a whole-file count.

export interface DiffEntry {
	path: string;
	status: "added" | "modified" | "deleted";
	additions: number;
	deletions: number;
	summary?: string;
}

const MAX_CELLS = 4_000_000;

export function lineStats(before: string, after: string): { additions: number; deletions: number } {
	const a = before === "" ? [] : before.split("\n");
	const b = after === "" ? [] : after.split("\n");
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const x = a.slice(start, endA);
	const y = b.slice(start, endB);
	if (x.length * y.length > MAX_CELLS) return { additions: y.length, deletions: x.length };
	const prev = new Array<number>(y.length + 1).fill(0);
	for (let i = 1; i <= x.length; i++) {
		let diag = 0;
		for (let j = 1; j <= y.length; j++) {
			const up = prev[j]!;
			prev[j] = x[i - 1] === y[j - 1] ? diag + 1 : Math.max(prev[j]!, prev[j - 1]!);
			diag = up;
		}
	}
	const common = prev[y.length]!;
	return { additions: y.length - common, deletions: x.length - common };
}

export function diffEntries(before: Record<string, string | null>, after: Record<string, string | null>, notes: Record<string, string> = {}): DiffEntry[] {
	const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
	const out: DiffEntry[] = [];
	for (const path of paths) {
		const old = before[path] ?? null;
		const next = after[path] ?? null;
		if (old === next) continue;
		const status = old === null ? "added" : next === null ? "deleted" : "modified";
		const entry: DiffEntry = { path, status, ...lineStats(old ?? "", next ?? "") };
		if (notes[path]) entry.summary = notes[path];
		out.push(entry);
	}
	return out;
}

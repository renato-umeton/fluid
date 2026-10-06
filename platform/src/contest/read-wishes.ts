// Reads a fork's wishes in flight for GET /api/forks/:repo/wishes: its work/*
// branches, the intent records each one adds since main, the notes runs left
// in the Fleet object, and the fork's gate results (contest/wishes.ts joins them).
// The branch part is public and costs Artifacts calls, so it is cached per
// fork for a few seconds. The notes carry the request text of runs that have
// not pushed anything yet, so only the fork's owner (or the admin) gets them.
import { parseIntentRecord } from "../agents/intent.ts";
import type { BuildTimeIntent } from "../forks/provision.ts";
import { listRemoteRefs } from "../git/ops.ts";
import { headOf, listCommitFiles, openRepo, readTextFile } from "../runtime/repo-files.ts";
import { fleetStub } from "../stubs.ts";
import { listWishes, WISH_LIMITS, type Wish } from "./wishes.ts";

const INTENT_FILES = { file: (p: string) => p.startsWith(".intent/") && p.endsWith(".json"), dir: (p: string) => p === ".intent" };
/** Branch heads whose commit time is read to pick the newest ones. */
const MAX_SCANNED = 60;
/** How long one fork's branch read is reused. */
export const WISH_CACHE_MS = 10_000;
const WISH_CACHE_LIMIT = 200;

export interface WishBranches {
	main: string | null;
	branches: { branch: string; head: string; records: BuildTimeIntent[] }[];
	/** Work branches the read did not include. */
	leftOut: number;
	scanned: number;
}

/** The newest branches by commit time (unknown times last, then by name), at most `max`. */
export function pickBranches<T extends { branch: string; at: number | null }>(list: T[], max = WISH_LIMITS.maxBranches): { kept: T[]; leftOut: number } {
	const sorted = [...list].sort((a, b) => (b.at ?? -1) - (a.at ?? -1) || a.branch.localeCompare(b.branch));
	return { kept: sorted.slice(0, max), leftOut: Math.max(0, list.length - max) };
}

/** A small time-boxed cache of branch reads, per fork. */
export function wishBranchCache(ttlMs = WISH_CACHE_MS) {
	const entries = new Map<string, { at: number; value: Promise<WishBranches> }>();
	return {
		get(repo: string, read: () => Promise<WishBranches>, now = Date.now()): Promise<WishBranches> {
			const hit = entries.get(repo);
			if (hit && now - hit.at < ttlMs) return hit.value;
			const value = read();
			value.catch(() => entries.delete(repo));
			if (entries.size >= WISH_CACHE_LIMIT) entries.delete(entries.keys().next().value!);
			entries.set(repo, { at: now, value });
			return value;
		},
		/** For tests: a value the next reads within the window get. */
		prime(repo: string, value: WishBranches, now = Date.now()): void {
			entries.set(repo, { at: now, value: Promise.resolve(value) });
		},
	};
}

export const WISH_BRANCHES = wishBranchCache();

/** Reads the fork's work branches: the newest ones by commit time, and the intent records each adds since main. */
export async function readWishBranches(env: Env, repo: string): Promise<WishBranches> {
	using handle = await openRepo(env.ARTIFACTS, repo);
	const info = await handle.info();
	// The binding has no ref listing, so refs come over git with a short read token.
	const token = await handle.createToken("read", 60);
	const [refs, main] = await Promise.all([listRemoteRefs({ url: info.remote, token: token.plaintext }, undefined, { prefix: "refs/heads/work/" }), headOf(handle, "main")]);
	const onMain = new Set(main ? (await listCommitFiles(handle, main, INTENT_FILES)).map((f) => f.path) : []);
	const work = refs.filter((r) => r.ref.startsWith("refs/heads/work/")).sort((a, b) => a.ref.localeCompare(b.ref)).slice(0, MAX_SCANNED);
	const dated = await Promise.all(work.map(async (r) => ({ branch: r.ref.slice("refs/heads/".length), head: r.oid, at: (await handle.readCommit(r.oid).catch(() => null))?.committedAt ?? null })));
	const picked = pickBranches(dated);
	const branches = await Promise.all(
		picked.kept.map(async (b) => {
			const added = (await listCommitFiles(handle, b.head, INTENT_FILES)).filter((f) => !onMain.has(f.path)).slice(0, WISH_LIMITS.maxRecordsPerBranch);
			const records: BuildTimeIntent[] = [];
			for (const f of added) {
				const text = await readTextFile(handle, b.head, f.path);
				const record = text === null ? null : parseIntentRecord(f.path, text);
				if (record) records.push(record);
			}
			return { branch: b.branch, head: b.head, records };
		}),
	);
	const total = refs.filter((r) => r.ref.startsWith("refs/heads/work/")).length;
	return { main, branches, leftOut: total - branches.length, scanned: work.length };
}

export async function readWishes(env: Env, repo: string, options: { includeNotes: boolean }): Promise<{ repo: string; main: string | null; wishes: Wish[]; branchesLeftOut: number; notesIncluded: boolean }> {
	const read = await WISH_BRANCHES.get(repo, () => readWishBranches(env, repo));
	const fleet = fleetStub(env);
	const [notes, gates] = await Promise.all([options.includeNotes ? fleet.wishNotes(repo) : Promise.resolve([]), fleet.gates(repo)]);
	return { repo, main: read.main, wishes: listWishes({ branches: read.branches, notes, gates: gates as { ref?: unknown; commit?: unknown; passed?: unknown; at?: unknown }[] }), branchesLeftOut: read.leftOut, notesIncluded: options.includeNotes };
}

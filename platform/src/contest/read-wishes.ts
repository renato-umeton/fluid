// Reads a fork's wishes in flight for GET /api/forks/:repo/wishes: its work/*
// branches, the intent records each one adds since main, the notes runs left
// in the Fleet object, and the fork's gate results (contest/wishes.ts joins them).
import { parseIntentRecord } from "../agents/intent.ts";
import type { BuildTimeIntent } from "../forks/provision.ts";
import { listRemoteRefs } from "../git/ops.ts";
import { headOf, listCommitFiles, openRepo, readTextFile } from "../runtime/repo-files.ts";
import { fleetStub } from "../stubs.ts";
import { listWishes, WISH_LIMITS, type Wish } from "./wishes.ts";

const INTENT_FILES = { file: (p: string) => p.startsWith(".intent/") && p.endsWith(".json"), dir: (p: string) => p === ".intent" };

export async function readWishes(env: Env, repo: string): Promise<{ repo: string; main: string | null; wishes: Wish[]; branchesLeftOut: number }> {
	using handle = await openRepo(env.ARTIFACTS, repo);
	const info = await handle.info();
	const token = await handle.createToken("read", 300);
	const [refs, main] = await Promise.all([listRemoteRefs({ url: info.remote, token: token.plaintext }, undefined, { prefix: "refs/heads/work/" }), headOf(handle, "main")]);
	const onMain = new Set(main ? (await listCommitFiles(handle, main, INTENT_FILES)).map((f) => f.path) : []);
	const work = refs.filter((r) => r.ref.startsWith("refs/heads/work/")).sort((a, b) => a.ref.localeCompare(b.ref));
	const kept = work.slice(0, WISH_LIMITS.maxBranches);
	const branches = await Promise.all(
		kept.map(async (r) => {
			const added = (await listCommitFiles(handle, r.oid, INTENT_FILES)).filter((f) => !onMain.has(f.path)).slice(0, WISH_LIMITS.maxRecordsPerBranch);
			const records: BuildTimeIntent[] = [];
			for (const f of added) {
				const text = await readTextFile(handle, r.oid, f.path);
				const record = text === null ? null : parseIntentRecord(f.path, text);
				if (record) records.push(record);
			}
			return { branch: r.ref.slice("refs/heads/".length), head: r.oid, records };
		}),
	);
	const fleet = fleetStub(env);
	const [notes, gates] = await Promise.all([fleet.wishNotes(repo), fleet.gates(repo)]);
	return { repo, main, wishes: listWishes({ branches, notes, gates: gates as { ref?: unknown; commit?: unknown; passed?: unknown; at?: unknown }[] }), branchesLeftOut: work.length - kept.length };
}

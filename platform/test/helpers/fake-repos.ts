// In-memory git repositories with the read surface the platform uses on the
// Artifacts binding (runtime/refs.ts, runtime/repo-files.ts, stock/suite.ts):
// log to resolve a ref, readCommit, readTree, and readBlob to walk a commit,
// and readFile for one file at a ref. They also produce the ref listing the
// platform fetches from a repo's git remote (listRemoteRefs). As on the
// binding, a ref is a short branch or tag name (main, work/x, v1.0.0) or a
// full commit SHA; full ref names such as refs/heads/main resolve to nothing.
//
// A repo is seeded with a linear history: each commit is a complete file set
// (not a diff) whose parent is the commit before it. Object ids are SHA-1s of
// a synthetic encoding of each object (not git's), so they are stable,
// distinct per content, and the same in every repo for the same history: a
// fork that has not changed has stock's commit, as a fork on Artifacts does.
import { createHash } from "node:crypto";

export interface RepoSeed {
	/** Complete file sets, oldest first; each commit's parent is the one before it. */
	commits: Record<string, string>[];
	/** Branch name to commit index. Default: main at the last commit. */
	branches?: Record<string, number>;
	/** Tag name to commit index. Tags are annotated, as stock publishes them. */
	tags?: Record<string, number>;
}

type GitObject =
	| { type: "blob"; text: string }
	| { type: "tree"; entries: ArtifactsTreeEntry[] }
	| { type: "commit"; commit: ArtifactsCommitMetadata }
	| { type: "tag"; commit: string };

const SHA = /^[0-9a-f]{40}$/;
const PERSON = { name: "Fluid Test", email: "test@fluid.invalid" };
/** Unix time of a repo's first commit; each later commit is a minute after the one before. */
const FIRST_COMMIT_AT = 1_790_000_000;
const FLUSH = "0000";

export type FakeGitRepo = ReturnType<typeof fakeGitRepo>;

export function fakeGitRepo(seed: RepoSeed = { commits: [] }) {
	const objects = new Map<string, GitObject>();
	const put = (object: GitObject, encoded: string): string => {
		const hash = createHash("sha1").update(`${object.type}\0${encoded}`).digest("hex");
		objects.set(hash, object);
		return hash;
	};
	const find = <T extends GitObject["type"]>(hash: string, type: T) => {
		const object = objects.get(hash);
		return object?.type === type ? (object as Extract<GitObject, { type: T }>) : null;
	};

	/** Stores the tree of `files` (paths relative to it) with every subtree and blob under it. */
	const writeTree = (files: [string, string][]): string => {
		const entries: ArtifactsTreeEntry[] = [];
		const dirs = new Map<string, [string, string][]>();
		for (const [path, text] of files) {
			const slash = path.indexOf("/");
			if (slash === -1) {
				entries.push({ name: path, mode: "100644", type: "blob", hash: put({ type: "blob", text }, text) });
				continue;
			}
			const dir = path.slice(0, slash);
			if (!dirs.has(dir)) dirs.set(dir, []);
			dirs.get(dir)!.push([path.slice(slash + 1), text]);
		}
		for (const [name, inner] of dirs) entries.push({ name, mode: "40000", type: "tree", hash: writeTree(inner) });
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		return put({ type: "tree", entries }, JSON.stringify(entries));
	};

	const commits: string[] = [];
	seed.commits.forEach((files, index) => {
		const treeHash = writeTree(Object.entries(files));
		const parents = index === 0 ? [] : [commits[index - 1]!];
		const message = `commit ${index}`;
		const at = FIRST_COMMIT_AT + index * 60;
		const commit: ArtifactsCommitMetadata = { hash: "", treeHash, message, author: PERSON, committer: PERSON, parents, authoredAt: at, committedAt: at };
		commit.hash = put({ type: "commit", commit }, JSON.stringify([treeHash, parents, message]));
		commits.push(commit.hash);
	});
	const commitAt = (kind: string, name: string, index: number): string => {
		const hash = commits[index];
		if (hash === undefined) throw new Error(`fakeGitRepo: ${kind} ${name} points at commit ${index}, but the seed has ${commits.length}`);
		return hash;
	};
	const branches = new Map(Object.entries(seed.branches ?? (commits.length ? { main: commits.length - 1 } : {})).map(([name, index]) => [name, commitAt("branch", name, index)]));
	const tags = new Map(
		Object.entries(seed.tags ?? {}).map(([name, index]) => {
			const commit = commitAt("tag", name, index);
			return [name, put({ type: "tag", commit }, JSON.stringify([name, commit]))];
		}),
	);
	for (const name of tags.keys()) {
		if (branches.has(name)) throw new Error(`fakeGitRepo: ${name} is both a branch and a tag, and which one the binding picks is not modeled`);
	}
	const peel = (tag: string): string => find(tag, "tag")!.commit;

	/** The commit a ref resolves to on the binding, or null. HEAD is the default branch, main. */
	const resolve = (ref: string): string | null => {
		if (SHA.test(ref)) return find(ref, "commit") ? ref : null;
		const name = ref === "HEAD" ? "main" : ref;
		const tag = tags.get(name);
		return branches.get(name) ?? (tag ? peel(tag) : null);
	};
	const metadata = (hash: string): ArtifactsCommitMetadata => find(hash, "commit")!.commit;

	return {
		/** Commit ids in seed order. */
		commits,
		resolve,

		// The binding's read methods. Results are copies, as they would be over RPC.

		/** The first-parent chain from ref, newest first; empty when the ref does not resolve. */
		async log(options: { ref?: string; limit?: number; offset?: number } = {}): Promise<ArtifactsCommitMetadata[]> {
			const { ref = "HEAD", limit = 50, offset = 0 } = options;
			const out: ArtifactsCommitMetadata[] = [];
			for (let hash = resolve(ref); hash !== null && out.length < offset + limit; hash = metadata(hash).parents[0] ?? null) out.push(metadata(hash));
			return structuredClone(out.slice(offset));
		},
		async readCommit(hash: string): Promise<ArtifactsCommitMetadata | null> {
			const found = find(hash, "commit");
			return found ? structuredClone(found.commit) : null;
		},
		async readTree(hash: string): Promise<ArtifactsTreeEntry[] | null> {
			const found = find(hash, "tree");
			return found ? structuredClone(found.entries) : null;
		},
		async readBlob(hash: string): Promise<Blob | null> {
			const found = find(hash, "blob");
			return found ? new Blob([found.text]) : null;
		},
		async readFile(args: { ref: string; path: string }): Promise<Blob | null> {
			const head = resolve(args.ref);
			let hash = head === null ? undefined : metadata(head).treeHash;
			for (const name of args.path.split("/")) hash = hash === undefined ? undefined : find(hash, "tree")?.entries.find((entry) => entry.name === name)?.hash;
			const blob = hash === undefined ? null : find(hash, "blob");
			return blob ? new Blob([blob.text]) : null;
		},

		/**
		 * The refs as the git remote advertises them over smart HTTP (protocol
		 * v1, which isomorphic-git's listServerRefs reads): HEAD, the branches,
		 * then each tag followed by the commit it peels to.
		 */
		advertisement(): string {
			const refs: [string, string][] = [];
			const head = branches.get("main");
			if (head) refs.push(["HEAD", head]);
			for (const [name, hash] of [...branches].sort(byName)) refs.push([`refs/heads/${name}`, hash]);
			for (const [name, hash] of [...tags].sort(byName)) refs.push([`refs/tags/${name}`, hash], [`refs/tags/${name}^{}`, peel(hash)]);
			const capabilities = head ? "symref=HEAD:refs/heads/main" : "";
			// A repo without refs advertises its capabilities on a placeholder line.
			const lines = refs.length ? refs.map(([name, hash], i) => `${hash} ${name}${i === 0 ? `\0${capabilities}` : ""}\n`) : [`${"0".repeat(40)} capabilities^{}\0${capabilities}\n`];
			return `${pktLine("# service=git-upload-pack\n")}${FLUSH}${lines.map(pktLine).join("")}${FLUSH}`;
		},
	};
}

function byName([a]: [string, string], [b]: [string, string]): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** A git pkt-line: four hex digits of total length (the prefix included), then the payload. */
function pktLine(payload: string): string {
	return `${(new TextEncoder().encode(payload).length + 4).toString(16).padStart(4, "0")}${payload}`;
}

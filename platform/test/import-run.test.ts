// importInboxBranch's core (runImport) end to end on in-memory repos: one
// working copy plays the fork clone, and "fetching the inbox" writes the
// inbox branch head into refs/remotes/inbox/<branch>, as the real fetch does.
import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { slugify } from "../src/agents/intent.ts";
import { forkBranchFor, IMPORT_LIMITS, IMPORT_NAMESPACE, ImportTooLargeError, runImport, type ImportIO } from "../src/forks/inbox.ts";
import { checkoutBranch, commitChanges, initRepo, writeFiles, type Workspace } from "../src/git/ops.ts";

const IMP = { inbox: "inbox-user-a", fork: "user-a", branch: "work/my-change" };

async function forkAndInbox(build?: (ws: Workspace) => Promise<void>) {
	const ws = await initRepo();
	await writeFiles(ws, { "app/index.ts": "1\n", "fluid.toml": 'stock_tag = "v1.10.0"\n' });
	const main = await commitChanges(ws, { message: "main" });
	await checkoutBranch(ws, "agent", { create: true, from: "main" });
	if (build) await build(ws);
	else {
		await writeFiles(ws, { "app/index.ts": "2\n" });
		await commitChanges(ws, { message: "outside change" });
	}
	const head = await git.resolveRef({ fs: ws.fs, dir: ws.dir, ref: "refs/heads/agent" });
	await checkoutBranch(ws, "main");
	return { ws, main, head };
}

function fakeIO(ws: Workspace, inboxHead: string | Error, state: { forkBranches?: Record<string, string>; marks?: Set<string> } = {}) {
	const forkBranches = state.forkBranches ?? {};
	const marks = state.marks ?? new Set<string>();
	const calls: string[] = [];
	const io: ImportIO = {
		cloneFork: async () => ws,
		fetchInbox: async (w, branch) => {
			calls.push(`fetch refs/heads/${branch}`);
			if (inboxHead instanceof Error) throw inboxHead;
			await git.writeRef({ fs: w.fs, dir: w.dir, ref: `refs/remotes/inbox/${branch}`, value: inboxHead, force: true });
			return inboxHead;
		},
		forkBranchHead: async (branch) => forkBranches[branch] ?? null,
		pushFork: async (w, ref, force) => {
			calls.push(`push ${ref}${force ? " force" : ""}`);
			forkBranches[ref.replace("refs/heads/", "")] = await git.resolveRef({ fs: w.fs, dir: w.dir, ref });
		},
		isMarked: async (branch) => marks.has(branch),
		mark: async (branch) => {
			calls.push(`mark ${branch}`);
			marks.add(branch);
		},
		linkGate: async (branch, commit) => void calls.push(`link ${branch} ${commit.slice(0, 7)}`),
	};
	return { io, calls, forkBranches, marks };
}

describe("forkBranchFor", () => {
	it("puts imports under work/inbox/, a name no platform workflow makes", () => {
		expect(forkBranchFor("work/my-change")).toBe("work/inbox/my-change");
		expect(forkBranchFor("work/a/b")).toBe("work/inbox/a/b");
	});

	it("never collides with customize branches, whose slug has no slash", () => {
		for (const request of ["inbox/evil", "work/inbox/x", "Add inbox / thing"]) expect(`work/${slugify(request)}-abcd`.startsWith(IMPORT_NAMESPACE)).toBe(false);
	});
});

describe("runImport", () => {
	it("creates the branch in the fork with full ref names, no force, and marks it after the push", async () => {
		const { ws, head } = await forkAndInbox();
		const { io, calls, forkBranches } = fakeIO(ws, head);
		const outcome = await runImport(io, { ...IMP, commit: head });
		expect(outcome).toEqual({ status: "imported", branch: "work/inbox/my-change", commits: 1, files: 1, replaced: false });
		expect(calls).toEqual(["fetch refs/heads/work/my-change", `link work/inbox/my-change ${head.slice(0, 7)}`, "push refs/heads/work/inbox/my-change", "mark work/inbox/my-change"]);
		expect(forkBranches["work/inbox/my-change"]).toBe(head);
	});

	it("replaces a branch an earlier import made, with force", async () => {
		const { ws, main, head } = await forkAndInbox();
		const { io, calls } = fakeIO(ws, head, { forkBranches: { "work/inbox/my-change": main }, marks: new Set(["work/inbox/my-change"]) });
		expect(await runImport(io, { ...IMP, commit: head })).toMatchObject({ status: "imported", replaced: true });
		expect(calls).toContain("push refs/heads/work/inbox/my-change force");
	});

	it("refuses a branch in the fork that no import made", async () => {
		const { ws, main, head } = await forkAndInbox();
		const { io, calls } = fakeIO(ws, head, { forkBranches: { "work/inbox/my-change": main } });
		expect(await runImport(io, { ...IMP, commit: head })).toEqual({ status: "refused", reason: expect.stringMatching(/not made by an import/) });
		expect(calls.some((c) => c.startsWith("push"))).toBe(false);
	});

	it("takes a fork branch already at the commit as done and makes the mark consistent (a retry after the push)", async () => {
		const { ws, head } = await forkAndInbox();
		const { io, calls, marks } = fakeIO(ws, head, { forkBranches: { "work/inbox/my-change": head } });
		expect(await runImport(io, { ...IMP, commit: head })).toEqual({ status: "already", branch: "work/inbox/my-change" });
		expect(marks.has("work/inbox/my-change")).toBe(true);
		expect(calls.some((c) => c.startsWith("push"))).toBe(false);
	});

	it("cancels when the inbox branch moved on", async () => {
		const { ws, main, head } = await forkAndInbox();
		const { io } = fakeIO(ws, head);
		expect(await runImport(io, { ...IMP, commit: main })).toEqual({ status: "moved", head });
	});

	it("refuses a download over the cap", async () => {
		const { ws, head } = await forkAndInbox();
		const { io } = fakeIO(ws, new ImportTooLargeError(IMPORT_LIMITS.maxPackBytes));
		expect(await runImport(io, { ...IMP, commit: head })).toEqual({ status: "refused", reason: expect.stringMatching(/larger than/) });
	});

	it("refuses a change over the file cap", async () => {
		const { ws, head } = await forkAndInbox(async (w) => {
			await writeFiles(w, { "a/1.ts": "1", "a/2.ts": "2", "a/3.ts": "3" });
			await commitChanges(w, { message: "files" });
		});
		const { io } = fakeIO(ws, head);
		expect(await runImport(io, { ...IMP, commit: head }, { ...IMPORT_LIMITS, maxFiles: 2 })).toEqual({ status: "refused", reason: expect.stringMatching(/3 files/) });
	});

	it("refuses a tree with more entries than the cap before walking all of it", async () => {
		const { ws, head } = await forkAndInbox(async (w) => {
			await writeFiles(w, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`many/${i}.txt`, `${i}`])));
			await commitChanges(w, { message: "many" });
		});
		const { io } = fakeIO(ws, head);
		expect(await runImport(io, { ...IMP, commit: head }, { ...IMPORT_LIMITS, maxTreeEntries: 20 })).toEqual({ status: "refused", reason: expect.stringMatching(/more than 20 entries/) });
	});

	it.each([".git/config", "app/../../x", "a/.GIT/hooks", "app\\win.ts"])("refuses an unsafe path %s", async (path) => {
		const { ws, main } = await forkAndInbox();
		const blob = await git.writeBlob({ fs: ws.fs, dir: ws.dir, blob: new TextEncoder().encode("x") });
		const parts = path.split("/");
		let entry = { mode: "100644", path: parts.pop()!, oid: blob, type: "blob" as const };
		while (parts.length) {
			const oid = await git.writeTree({ fs: ws.fs, dir: ws.dir, tree: [entry] });
			entry = { mode: "040000", path: parts.pop()!, oid, type: "tree" as never };
		}
		const { commit: mainCommit } = await git.readCommit({ fs: ws.fs, dir: ws.dir, oid: main });
		const mainTree = await git.readTree({ fs: ws.fs, dir: ws.dir, oid: mainCommit.tree });
		const tree = await git.writeTree({ fs: ws.fs, dir: ws.dir, tree: [...mainTree.tree, entry] as never });
		const bad = await git.writeCommit({ fs: ws.fs, dir: ws.dir, commit: { ...mainCommit, tree, parent: [main], message: "unsafe\n" } });
		const { io, calls } = fakeIO(ws, bad);
		expect(await runImport(io, { ...IMP, commit: bad })).toEqual({ status: "refused", reason: expect.stringMatching(/unsafe path/) });
		expect(calls.some((c) => c.startsWith("push"))).toBe(false);
	});
});

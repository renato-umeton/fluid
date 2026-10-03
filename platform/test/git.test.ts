import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import {
	checkoutBranch,
	commitChanges,
	createTag,
	fastForward,
	firstParent,
	headCommit,
	initRepo,
	listTags,
	listTrackedFiles,
	mergeInto,
	parseTrailers,
	peelToCommit,
	readCommitMessage,
	readWorkspaceFile,
	removeFiles,
	resetBranch,
	replaceTree,
	withIntentTrailer,
	writeFiles,
	type Workspace,
} from "../src/git/ops.ts";
import { onAuthFor, redactToken, redactTokens, scrubText, tokenExpiry, tokenSecret } from "../src/git/tokens.ts";

const TOKEN = "art_v2_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLM?expires=1790000000";

async function seeded(): Promise<{ ws: Workspace; base: string }> {
	const ws = await initRepo();
	await writeFiles(ws, { "shared.txt": "line1\nline2\nline3\n", "app/index.ts": "export const v = 1;\n" });
	const base = await commitChanges(ws, { message: "stock v1.0.0", intentId: "int_0001" });
	return { ws, base };
}

describe("tokens", () => {
	it("uses only the part before ?expires= as the secret", () => {
		expect(tokenSecret(TOKEN)).toBe("art_v2_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLM");
	});

	it("reads the expiry", () => {
		expect(tokenExpiry(TOKEN)).toBe(1790000000);
	});

	it("builds an onAuth callback with the secret as password", () => {
		expect(onAuthFor(TOKEN)()).toEqual({ username: "x", password: tokenSecret(TOKEN) });
	});

	it("rejects an empty token", () => {
		expect(() => tokenSecret("")).toThrow(/non-empty/);
	});

	it("redacts token fields deeply", () => {
		const out = redactTokens({ remote: "r", token: TOKEN, nested: [{ plaintext: TOKEN }] });
		expect(JSON.stringify(out)).not.toContain("abcdefghijklmnop");
		expect(out.remote).toBe("r");
	});

	it("redacts to a prefix and length", () => {
		expect(redactToken(TOKEN)).toBe("art_v2_<redacted len=56>");
	});

	it("scrubs tokens out of free text", () => {
		expect(scrubText(`push failed for ${TOKEN} now`)).toBe("push failed for <redacted-token> now");
	});
});

describe("commit messages", () => {
	it("appends an Intent-Id trailer", () => {
		expect(withIntentTrailer("Add connector", "int_1")).toBe("Add connector\n\nIntent-Id: int_1\n");
	});

	it("omits the trailer without an intent id", () => {
		expect(withIntentTrailer("Add connector\n\n")).toBe("Add connector\n");
	});

	it("rejects an intent id that would break the trailer", () => {
		expect(() => withIntentTrailer("x", "bad id\nInjected: 1")).toThrow(/invalid intent id/);
	});

	it("parses trailers from the last paragraph", () => {
		expect(parseTrailers("Title\n\nBody text.\n\nIntent-Id: int_1\nStock-Tag: v1.0.0\n")).toEqual({ "Intent-Id": "int_1", "Stock-Tag": "v1.0.0" });
	});

	it("returns no trailers for a single paragraph", () => {
		expect(parseTrailers("Intent-Id: int_1")).toEqual({});
	});
});

describe("working copy operations", () => {
	it("commits with the trailer recorded in the commit", async () => {
		const { ws, base } = await seeded();
		expect(parseTrailers(await readCommitMessage(ws, base))["Intent-Id"]).toBe("int_0001");
	});

	it("rejects paths that escape the repository", async () => {
		const ws = await initRepo();
		await expect(writeFiles(ws, { "../x.txt": "nope" })).rejects.toThrow(/invalid repository path/);
	});

	it("refuses to write inside .git", async () => {
		const ws = await initRepo();
		await expect(writeFiles(ws, { ".git/config": "nope" })).rejects.toThrow(/inside .git/);
	});

	it("replaceTree removes files not in the new release", async () => {
		const { ws } = await seeded();
		await replaceTree(ws, { "app/index.ts": "export const v = 2;\n", "fluid.toml": 'stock_tag = "v1.1.0"\n' });
		await commitChanges(ws, { message: "stock v1.1.0" });
		expect((await listTrackedFiles(ws)).sort()).toEqual(["app/index.ts", "fluid.toml"]);
	});

	it("removeFiles ignores missing files", async () => {
		const { ws } = await seeded();
		await removeFiles(ws, ["nope.txt", "shared.txt"]);
		expect(await readWorkspaceFile(ws, "shared.txt")).toBeNull();
	});

	it("commits on a new branch and leaves main alone", async () => {
		const { ws, base } = await seeded();
		await writeFiles(ws, { "connectors/redcap.ts": "export {};\n" });
		const custom = await commitChanges(ws, { message: "Add REDCap", branch: "user-a/custom" });
		expect(await headCommit(ws, "main")).toBe(base);
		expect(await headCommit(ws, "user-a/custom")).toBe(custom);
	});
});

describe("tags", () => {
	it("creates an annotated tag and peels it to the tagged commit", async () => {
		const { ws, base } = await seeded();
		const tagOid = await createTag(ws, { tag: "v1.0.0", message: "stock v1.0.0" });
		expect(tagOid).not.toBe(base);
		expect(await peelToCommit(ws, tagOid)).toBe(base);
		expect(await listTags(ws)).toEqual(["v1.0.0"]);
	});

	it("peeling a commit returns it unchanged", async () => {
		const { ws, base } = await seeded();
		expect(await peelToCommit(ws, base)).toBe(base);
	});
});

describe("mergeInto", () => {
	async function stockAhead(ws: Workspace, base: string, change: Record<string, string>): Promise<void> {
		await checkoutBranch(ws, "stock-next", { create: true, from: base });
		await writeFiles(ws, change);
		await commitChanges(ws, { message: "stock v1.1.0" });
		await createTag(ws, { tag: "v1.1.0", message: "stock v1.1.0" });
	}

	it("fast-forwards when the branch has no local changes, given an annotated tag", async () => {
		const { ws, base } = await seeded();
		await stockAhead(ws, base, { "app/index.ts": "export const v = 2;\n" });
		const outcome = await mergeInto(ws, { ours: "main", theirs: "v1.1.0" });
		expect(outcome).toMatchObject({ ok: true, fastForward: true });
		expect(await readWorkspaceFile(ws, "app/index.ts")).toBe("export const v = 2;\n");
	});

	it("makes a merge commit for disjoint changes", async () => {
		const { ws, base } = await seeded();
		await writeFiles(ws, { "notes.txt": "user note\n" });
		await commitChanges(ws, { message: "user note" });
		await stockAhead(ws, base, { "app/index.ts": "export const v = 2;\n" });
		const outcome = await mergeInto(ws, { ours: "main", theirs: "v1.1.0", message: "Upgrade to v1.1.0" });
		expect(outcome).toMatchObject({ ok: true, fastForward: false });
		const head = await headCommit(ws, "main");
		const { commit } = await git.readCommit({ fs: ws.fs, dir: ws.dir, oid: head });
		expect(commit.parent).toHaveLength(2);
		expect(await readWorkspaceFile(ws, "notes.txt")).toBe("user note\n");
	});

	it("reports conflicts and leaves the branch unchanged", async () => {
		const { ws, base } = await seeded();
		await writeFiles(ws, { "shared.txt": "line1\nline2-USER\nline3\n" });
		const userHead = await commitChanges(ws, { message: "user edit" });
		await stockAhead(ws, base, { "shared.txt": "line1\nline2-STOCK\nline3\n" });
		const outcome = await mergeInto(ws, { ours: "main", theirs: "v1.1.0" });
		expect(outcome).toEqual({ ok: false, conflicts: { filepaths: ["shared.txt"], bothModified: ["shared.txt"], deleteByUs: [], deleteByTheirs: [] } });
		expect(await headCommit(ws, "main")).toBe(userHead);
		expect(await readWorkspaceFile(ws, "shared.txt")).toBe("line1\nline2-USER\nline3\n");
	});

	it("supports a manual two-parent resolution commit", async () => {
		const { ws, base } = await seeded();
		await writeFiles(ws, { "shared.txt": "line1\nline2-USER\nline3\n" });
		const userHead = await commitChanges(ws, { message: "user edit" });
		await stockAhead(ws, base, { "shared.txt": "line1\nline2-STOCK\nline3\n" });
		const stockCommit = await headCommit(ws, "v1.1.0");
		await checkoutBranch(ws, "repair/v1.1.0", { create: true, from: "main" });
		await writeFiles(ws, { "shared.txt": "line1\nline2-STOCK\nline2-USER\nline3\n" });
		const resolved = await commitChanges(ws, { message: "Merge stock v1.1.0", parents: [userHead, stockCommit], intentId: "int_repair" });
		const { commit } = await git.readCommit({ fs: ws.fs, dir: ws.dir, oid: resolved });
		expect(commit.parent).toEqual([userHead, stockCommit]);
	});
});

describe("fastForward", () => {
	it("moves a branch forward to a descendant commit", async () => {
		const { ws, base } = await seeded();
		await checkoutBranch(ws, "work/a", { create: true });
		await writeFiles(ws, { "app/a.ts": "export const a = 1;\n" });
		const tip = await commitChanges(ws, { message: "a" });
		expect(await fastForward(ws, "main", tip)).toEqual({ outcome: "fast-forward", oid: tip });
		expect(await headCommit(ws, "main")).toBe(tip);
		expect(base).not.toBe(tip);
	});

	it("reports a commit main already has", async () => {
		const { ws, base } = await seeded();
		expect(await fastForward(ws, "main", base)).toEqual({ outcome: "already", oid: base });
	});

	it("refuses to move main when the commit does not contain main's head", async () => {
		const { ws, base } = await seeded();
		await checkoutBranch(ws, "work/a", { create: true });
		await writeFiles(ws, { "app/a.ts": "export const a = 1;\n" });
		const tip = await commitChanges(ws, { message: "a" });
		await checkoutBranch(ws, "main");
		await writeFiles(ws, { "app/b.ts": "export const b = 1;\n" });
		const moved = await commitChanges(ws, { message: "main moved" });
		expect(await fastForward(ws, "main", tip)).toEqual({ outcome: "diverged", oid: moved });
		expect(await headCommit(ws, "main")).toBe(moved);
		expect(base).not.toBe(moved);
	});

	it("first parent of a merge commit is the branch it merged into", async () => {
		const { ws, base } = await seeded();
		await checkoutBranch(ws, "work/a", { create: true });
		await writeFiles(ws, { "app/a.ts": "export const a = 1;\n" });
		await commitChanges(ws, { message: "a" });
		expect(await firstParent(ws, await headCommit(ws, "work/a"))).toBe(base);
	});
});

describe("resetBranch", () => {
	it("points a branch at an older commit and checks it out", async () => {
		const { ws, base } = await seeded();
		await writeFiles(ws, { "app/index.ts": "export const v = 2;\n" });
		await commitChanges(ws, { message: "stock v1.1.0" });
		await resetBranch(ws, "main", base);
		expect(await headCommit(ws, "main")).toBe(base);
		expect(await readWorkspaceFile(ws, "app/index.ts")).toBe("export const v = 1;\n");
	});
});

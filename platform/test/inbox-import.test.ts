import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { handlePushEvents } from "../src/events/consumer.ts";
import { filterPushEvent, isImportableBranch } from "../src/events/filter.ts";
import { cappedHttp, checkImport, IMPORT_LIMITS, ImportTooLargeError, importPushMode } from "../src/forks/inbox.ts";
import { checkoutBranch, commitChanges, initRepo, writeFiles } from "../src/git/ops.ts";

const SHA = "51e4fce944f2e5d131e3e6b7b8457ecc3a34e6a2";
const ZERO = "0".repeat(40);

function push(repoName: string, ref: string, after = SHA) {
	return { type: "cf.artifacts.repo.pushed", source: { namespace: "fluid", repoName, type: "artifacts" }, payload: { ref, before: ZERO, after, commits: [] } };
}

describe("filterPushEvent for inbox repos", () => {
	it("imports a work/* branch pushed to an inbox", () => {
		expect(filterPushEvent(push("inbox-user-s-1a2b", "refs/heads/work/my-change"))).toEqual({ gate: false, reason: expect.stringMatching(/import/), import: { inbox: "inbox-user-s-1a2b", fork: "user-s-1a2b", branch: "work/my-change", commit: SHA } });
	});

	it.each([
		["main", "refs/heads/main"],
		["a tag", "refs/tags/v1.2.0"],
		["a tag named like a work branch", "refs/tags/work/x"],
		["a repair branch", "refs/heads/repair/abc1234"],
		["an upgrade branch", "refs/heads/upgrade/v1.2.0"],
		["another branch", "refs/heads/feature/x"],
		["a note ref", "refs/notes/commits"],
	])("ignores %s", (_label, ref) => {
		const result = filterPushEvent(push("inbox-user-s-1a2b", ref));
		expect(result.gate).toBe(false);
		expect(!result.gate && result.import).toBeFalsy();
	});

	it("ignores a deleted work branch (nothing in the fork is deleted)", () => {
		const result = filterPushEvent(push("inbox-user-s-1a2b", "refs/heads/work/my-change", ZERO));
		expect(!result.gate && result.import).toBeFalsy();
	});

	it("ignores inboxes that do not belong to a user fork", () => {
		const result = filterPushEvent(push("inbox-stock", "refs/heads/work/x"));
		expect(!result.gate && result.import).toBeFalsy();
	});

	it("still gates work branches pushed to the fork itself (platform pushes)", () => {
		expect(filterPushEvent(push("user-s-1a2b", "refs/heads/work/x")).gate).toBe(true);
	});
});

describe("isImportableBranch", () => {
	it("accepts plain work branch names", () => {
		for (const name of ["work/my-change", "work/a/b.c_d-1"]) expect(isImportableBranch(name)).toBe(true);
	});

	it("refuses anything else", () => {
		for (const name of ["work/", "work", "main", "repair/x", "work/../main", "work/.hidden", "work/x.lock", "work/a//b", `work/${"a".repeat(100)}`, "work/x y"]) expect(isImportableBranch(name)).toBe(false);
	});
});

describe("importPushMode", () => {
	it("creates a missing branch, updates one an import made, and refuses one the platform made", () => {
		expect(importPushMode({ exists: false, imported: false })).toBe("create");
		expect(importPushMode({ exists: true, imported: true })).toBe("update");
		expect(importPushMode({ exists: true, imported: false })).toBe("refuse");
	});
});

async function inboxBranch(build: (ws: Awaited<ReturnType<typeof initRepo>>) => Promise<void>) {
	const ws = await initRepo();
	await writeFiles(ws, { "app/index.ts": "export const v = 1;\n", "fluid.toml": 'stock_tag = "v1.10.0"\n' });
	const main = await commitChanges(ws, { message: "main" });
	await checkoutBranch(ws, "work/x", { create: true, from: "main" });
	await build(ws);
	const head = await git.resolveRef({ fs: ws.fs, dir: ws.dir, ref: "work/x" });
	return { ws, main, head };
}

describe("checkImport caps", () => {
	it("accepts a small change and lists its commits and files", async () => {
		const { ws, main, head } = await inboxBranch(async (w) => {
			await writeFiles(w, { "app/index.ts": "export const v = 2;\n" });
			await commitChanges(w, { message: "one" });
		});
		const result = await checkImport(ws, { base: main, head });
		expect(result).toMatchObject({ ok: true, commits: 1, files: 1 });
	});

	it("refuses too many commits", async () => {
		const { ws, main, head } = await inboxBranch(async (w) => {
			for (let i = 0; i < 4; i++) {
				await writeFiles(w, { "app/index.ts": `export const v = ${i + 10};\n` });
				await commitChanges(w, { message: `c${i}` });
			}
		});
		expect(await checkImport(ws, { base: main, head }, { ...IMPORT_LIMITS, maxCommits: 3 })).toEqual({ ok: false, reason: expect.stringMatching(/more than 3 commits/) });
	});

	it("refuses too many files", async () => {
		const { ws, main, head } = await inboxBranch(async (w) => {
			await writeFiles(w, { "a/1.ts": "1", "a/2.ts": "2", "a/3.ts": "3" });
			await commitChanges(w, { message: "files" });
		});
		expect(await checkImport(ws, { base: main, head }, { ...IMPORT_LIMITS, maxFiles: 2 })).toEqual({ ok: false, reason: expect.stringMatching(/3 files; at most 2/) });
	});

	it("refuses a file that is too large", async () => {
		const { ws, main, head } = await inboxBranch(async (w) => {
			await writeFiles(w, { "big.txt": "x".repeat(2000) });
			await commitChanges(w, { message: "big" });
		});
		expect(await checkImport(ws, { base: main, head }, { ...IMPORT_LIMITS, maxBlobBytes: 1000 })).toEqual({ ok: false, reason: expect.stringMatching(/big.txt is 2000 bytes; at most 1000/) });
	});
});

describe("cappedHttp", () => {
	function fakeHttp(chunks: number[]) {
		return {
			request: async () => ({
				url: "u", method: "POST", statusCode: 200, statusMessage: "OK", headers: {},
				body: (async function* () { for (const n of chunks) yield new Uint8Array(n); })(),
			}),
		};
	}

	async function drain(body: AsyncIterable<Uint8Array> | undefined) {
		let total = 0;
		for await (const chunk of body!) total += chunk.byteLength;
		return total;
	}

	it("passes a response under the cap through", async () => {
		const res = await cappedHttp(fakeHttp([400, 400]) as never, 1000).request({ url: "u" } as never);
		expect(await drain(res.body as never)).toBe(800);
	});

	it("stops reading once the response passes the cap", async () => {
		const res = await cappedHttp(fakeHttp([600, 600, 600]) as never, 1000).request({ url: "u" } as never);
		await expect(drain(res.body as never)).rejects.toBeInstanceOf(ImportTooLargeError);
	});
});

describe("handlePushEvents routing", () => {
	function message(body: unknown) {
		const m = { body, acked: false, retried: false, ack: () => void (m.acked = true), retry: () => void (m.retried = true) };
		return m;
	}

	function context() {
		const created: unknown[] = [];
		const GateWorkflow = { create: async (o: { id: string }) => (created.push(o), { id: o.id }), get: async () => ({ status: async () => ({ status: "running" }) }) };
		return { created, ctx: { exports: { GateWorkflow } } as unknown as ExecutionContext };
	}

	it("sends an inbox work branch to the import and nothing to the gate", async () => {
		const imports: unknown[] = [];
		const { created, ctx } = context();
		const m = message(push("inbox-user-s-1a2b", "refs/heads/work/x"));
		await handlePushEvents({ messages: [m] } as never, {} as Env, ctx, { importBranch: async (_env, _exports, imp) => void imports.push(imp) });
		expect(imports).toEqual([{ inbox: "inbox-user-s-1a2b", fork: "user-s-1a2b", branch: "work/x", commit: SHA }]);
		expect(created).toEqual([]);
		expect(m.acked).toBe(true);
	});

	it("retries the message when the import fails for infrastructure reasons", async () => {
		const { ctx } = context();
		const m = message(push("inbox-user-s-1a2b", "refs/heads/work/x"));
		await handlePushEvents({ messages: [m] } as never, {} as Env, ctx, { importBranch: async () => { throw new Error("artifacts down"); } });
		expect(m.retried).toBe(true);
	});

	it("acks inbox pushes to main and tags without importing", async () => {
		const imports: unknown[] = [];
		const { ctx } = context();
		const messages = [message(push("inbox-user-s-1a2b", "refs/heads/main")), message(push("inbox-user-s-1a2b", "refs/tags/work/x"))];
		await handlePushEvents({ messages } as never, {} as Env, ctx, { importBranch: async (_env, _exports, imp) => void imports.push(imp) });
		expect(imports).toEqual([]);
		expect(messages.every((x) => x.acked)).toBe(true);
	});

	it("still starts the gate for a fork work branch", async () => {
		const { created, ctx } = context();
		const m = message(push("user-s-1a2b", "refs/heads/work/x"));
		await handlePushEvents({ messages: [m] } as never, {} as Env, ctx, { importBranch: async () => undefined });
		expect(created).toHaveLength(1);
	});
});

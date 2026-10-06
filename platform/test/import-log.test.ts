import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { addImportNote, IMPORT_LOG_LIMIT, type ImportNote } from "../src/forks/import-log.ts";
import { outsideGrantKey } from "../src/forks/outside.ts";
import type { ImportOutcome } from "../src/forks/inbox.ts";
import { ImportWorkflow } from "../src/workflows/import.ts";
import { IMPORT_QUOTAS } from "../src/forks/inbox.ts";
import { quotaStub } from "../src/stubs.ts";
import { apiEnv, cookieFor, workerContext } from "./helpers/api-env.ts";

const note = (n: number, over: Partial<ImportNote> = {}): ImportNote => ({ at: `2026-10-06T12:00:0${n}.000Z`, branch: `work/b${n}`, commit: "abcdef1", status: "refused", reason: `reason ${n}`, runId: null, ...over });

describe("addImportNote", () => {
	it("keeps the newest first and at most the last 5", () => {
		let list: ImportNote[] = [];
		for (let i = 0; i < 7; i++) list = addImportNote(list, note(i));
		expect(IMPORT_LOG_LIMIT).toBe(5);
		expect(list.map((n) => n.branch)).toEqual(["work/b6", "work/b5", "work/b4", "work/b3", "work/b2"]);
	});

	it("keeps reasons as one short line of plain text", () => {
		const [kept] = addImportNote([], note(1, { reason: `line one\nline two\u0007 ${"x".repeat(1000)}` }));
		expect(kept!.reason).not.toMatch(/[\n\u0007]/);
		expect(kept!.reason!.length).toBeLessThanOrEqual(300);
		expect(kept!.reason!.startsWith("line one line two")).toBe(true);
	});

	it("shortens the commit and clips the branch", () => {
		const [kept] = addImportNote([], note(1, { commit: "a".repeat(40), branch: `work/${"b".repeat(400)}` }));
		expect(kept!.commit).toBe("aaaaaaa");
		expect(kept!.branch.length).toBeLessThanOrEqual(200);
	});
});

describe("Fleet import notes", () => {
	it("are kept per fork", () => {
		const { fleet } = apiEnv();
		fleet.noteImport("user-a", note(1));
		fleet.noteImport("user-b", note(2));
		expect(fleet.importNotes("user-a").map((n) => n.branch)).toEqual(["work/b1"]);
		expect(fleet.importNotes("user-none")).toEqual([]);
	});

	it("go with the fork when it is removed", () => {
		const { fleet } = apiEnv();
		fleet.register({ repo: "user-a", userId: "a", persona: "p", pinnedTag: "v1", status: "pinned" });
		fleet.noteImport("user-a", note(1));
		fleet.remove("user-a");
		expect(fleet.importNotes("user-a")).toEqual([]);
	});
});

describe("ImportWorkflow records each outcome for the owner", () => {
	const RUN = "run_import_test";
	const params = { runId: RUN, inbox: "inbox-user-a", fork: "user-a", branch: "work/x", commit: "a".repeat(40) };

	function setup() {
		const t = apiEnv();
		t.fleet.register({ repo: "user-a", userId: "a", persona: "p", pinnedTag: "v1", status: "pinned" });
		t.fleet.setValue(outsideGrantKey("user-a"), { repo: "user-a", inbox: "inbox-user-a" } as never);
		return t;
	}

	async function run(t: ReturnType<typeof setup>, outcome: ImportOutcome | Error) {
		const workflow = new ImportWorkflow();
		(workflow as unknown as { env: Env }).env = t.env;
		(workflow as unknown as { ctx: ExecutionContext }).ctx = workerContext().ctx;
		const step = {
			do: async (name: string, ...rest: unknown[]) => {
				if (name === "import") {
					if (outcome instanceof Error) throw outcome;
					return outcome;
				}
				return (rest.at(-1) as () => Promise<unknown>)();
			},
		};
		return workflow.run({ payload: params, timestamp: new Date() } as never, step as never);
	}

	it("records a refusal by the quota", async () => {
		const t = setup();
		for (let i = 0; i < IMPORT_QUOTAS.perForkPerHour; i++) await quotaStub(t.env, "fork:user-a").take("import", IMPORT_QUOTAS.perForkPerHour, 3600);
		await run(t, { status: "refused", reason: "unused" });
		expect(t.fleet.importNotes("user-a")).toEqual([expect.objectContaining({ branch: "work/x", commit: "aaaaaaa", status: "refused", reason: expect.stringMatching(/already imported 10 pushes/), runId: null })]);
	});

	it("records a refusal over a cap or an unsafe path", async () => {
		const t = setup();
		await run(t, { status: "refused", reason: "the branch has an unsafe path \"../x\"" });
		expect(t.fleet.importNotes("user-a")[0]).toMatchObject({ status: "refused", reason: "the branch has an unsafe path \"../x\"", runId: RUN });
	});

	it("records an import that was gated", async () => {
		const t = setup();
		await run(t, { status: "imported", branch: "work/inbox/x", commits: 1, files: 2, replaced: false });
		expect(t.fleet.importNotes("user-a")[0]).toMatchObject({ status: "imported", runId: RUN });
		expect(t.fleet.importNotes("user-a")[0]!.reason).toMatch(/work\/inbox\/x/);
	});
});

describe("GET /api/forks/:repo/imports", () => {
	const get = (path: string, headers: Record<string, string> = {}) => new Request(`https://fluid.test${path}`, { headers: { "cf-connecting-ip": "203.0.113.7", ...headers } });

	it("shows the owner the last import outcomes", async () => {
		const t = apiEnv();
		t.fleet.register({ repo: "user-s-1", userId: "s-1", persona: "hospitalist-researcher", pinnedTag: "v1", status: "pinned" });
		t.fleet.noteImport("user-s-1", note(1));
		const res = await worker.fetch(get("/api/forks/user-s-1/imports", { cookie: await cookieFor({ userId: "s-1" }) }), t.env, workerContext().ctx);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ imports: [note(1)] });
	});

	it("refuses anyone else", async () => {
		const t = apiEnv();
		t.fleet.register({ repo: "user-s-1", userId: "s-1", persona: "hospitalist-researcher", pinnedTag: "v1", status: "pinned" });
		const res = await worker.fetch(get("/api/forks/user-s-1/imports", { cookie: await cookieFor({ userId: "s-2" }) }), t.env, workerContext().ctx);
		expect(res.status).toBe(403);
	});
});

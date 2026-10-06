import { describe, expect, it } from "vitest";
import { Quota } from "../src/durable/quota.ts";
import { IMPORT_QUOTAS, takeImportQuota } from "../src/forks/inbox.ts";
import { startsRepair } from "../src/workflows/gate.ts";
import { LIMITS } from "../src/api/routes.ts";
import { construct } from "./helpers/durable.ts";
import { outsideGrantKey } from "../src/forks/outside.ts";
import { quotaStub, runsStub } from "../src/stubs.ts";
import { ImportWorkflow } from "../src/workflows/import.ts";
import { apiEnv } from "./helpers/api-env.ts";

function quotas() {
	const subjects = new Map<string, Quota>();
	return async (subject: string, bucket: string, limit: number, windowSeconds: number) => {
		if (!subjects.has(subject)) subjects.set(subject, construct(Quota).instance);
		return subjects.get(subject)!.take(bucket, limit, windowSeconds);
	};
}

describe("import quotas", () => {
	it("match the customization limit per fork", () => {
		expect(IMPORT_QUOTAS.perForkPerHour).toBe(LIMITS.customizationsPerUserPerHour);
	});

	it("refuse the import past the fork's hourly quota, with a clear reason", async () => {
		const take = quotas();
		for (let i = 0; i < IMPORT_QUOTAS.perForkPerHour; i++) expect(await takeImportQuota(take, "user-a")).toBeNull();
		expect(await takeImportQuota(take, "user-a")).toMatch(/already imported 10 pushes in the last hour; push again in \d+ seconds/);
		expect(await takeImportQuota(take, "user-b")).toBeNull();
	});

	it("refuse every fork once the global hourly cap is reached", async () => {
		const take = quotas();
		for (let i = 0; i < IMPORT_QUOTAS.globalPerHour; i++) await take("global", "import", IMPORT_QUOTAS.globalPerHour, 3600);
		expect(await takeImportQuota(take, "user-c")).toMatch(/platform is importing 200 pushes an hour/);
	});
});

describe("startsRepair", () => {
	it("starts the model-backed repair agent for platform changes", () => {
		for (const source of ["event", "customize", "direct", "seed", "repair"] as const) expect(startsRepair(source)).toBe(true);
	});

	it("never for imported changes or their drafted commits, nor for a repair being applied", () => {
		for (const source of ["import", "outside-push", "repair-apply"] as const) expect(startsRepair(source)).toBe(false);
	});

	it("never for a contest pick (the other contestants stay on their branches)", () => {
		expect(startsRepair("contest")).toBe(false);
	});
});

describe("ImportWorkflow and the import quota", () => {
	const RUN = "run_import_test";
	const params = { runId: RUN, inbox: "inbox-user-a", fork: "user-a", branch: "work/x", commit: "a".repeat(40) };

	function setup() {
		const t = apiEnv();
		t.fleet.register({ repo: "user-a", userId: "a", persona: "p", pinnedTag: "v1", status: "pinned" });
		t.fleet.setValue(outsideGrantKey("user-a"), { repo: "user-a", inbox: "inbox-user-a" } as never);
		return t;
	}

	/** Runs the workflow; the git import step stops it (nothing here reaches Artifacts). */
	async function run(t: ReturnType<typeof setup>) {
		const workflow = new ImportWorkflow();
		(workflow as unknown as { env: Env }).env = t.env;
		const names: string[] = [];
		const step = {
			do: async (name: string, ...rest: unknown[]) => {
				names.push(name);
				if (name === "import") throw new Error("stop before git");
				return (rest.at(-1) as () => Promise<unknown>)();
			},
		};
		const output = await workflow.run({ payload: params, timestamp: new Date() } as never, step as never).catch((error: Error) => ({ thrown: error.message }));
		return { output, names };
	}

	it("refuses past the quota without creating a run record, and says why in its output", async () => {
		const t = setup();
		for (let i = 0; i < IMPORT_QUOTAS.perForkPerHour; i++) await quotaStub(t.env, "fork:user-a").take("import", IMPORT_QUOTAS.perForkPerHour, 3600);
		const { output, names } = await run(t);
		expect(output).toEqual({ status: "refused", reason: expect.stringMatching(/already imported 10 pushes in the last hour/) });
		expect(names).not.toContain("import");
		expect(await runsStub(t.env, RUN).get()).toBeNull();
	});

	it("creates the run record once the quota allows the import", async () => {
		const t = setup();
		const { names } = await run(t);
		expect(names).toContain("import");
		expect(await runsStub(t.env, RUN).get()).toMatchObject({ kind: "import", repo: "user-a" });
	});
});

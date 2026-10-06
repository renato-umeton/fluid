import { describe, expect, it } from "vitest";
import { Quota } from "../src/durable/quota.ts";
import { IMPORT_QUOTAS, takeImportQuota } from "../src/forks/inbox.ts";
import { startsRepair } from "../src/workflows/gate.ts";
import { LIMITS } from "../src/api/routes.ts";
import { construct } from "./helpers/durable.ts";

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
});

import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { toHttpError } from "../src/api/validate.ts";
import { HttpError } from "../src/api/http.ts";
import { FleetFullError, ProvisioningBusyError } from "../src/forks/provision.ts";
import { quotaStub } from "../src/stubs.ts";
import { apiEnv, cookieFor, post, workerContext } from "./helpers/api-env.ts";

const ctx = workerContext().ctx;
const CLIENT = "203.0.113.7";

async function createFork(env: Env, userId: string) {
	return worker.fetch(post("/api/forks", { cookie: await cookieFor({ userId }) }), env, ctx);
}

describe("POST /api/forks refusals say why", () => {
	it("names the per-client fork limit when this client used its 3 forks this hour", async () => {
		const t = apiEnv();
		for (let i = 0; i < 3; i++) await quotaStub(t.env, `client:${CLIENT}`).take("fork", 3, 3600);
		const res = await createFork(t.env, "s-0001");
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ reason: "rate-limit", bucket: "fork", scope: "client", limit: 3, windowSeconds: 3600 });
	});

	it("names the global fork limit when the platform made 60 forks this hour", async () => {
		const t = apiEnv();
		for (let i = 0; i < 60; i++) await quotaStub(t.env, "global").take("fork", 60, 3600);
		const res = await createFork(t.env, "s-0002");
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ reason: "rate-limit", bucket: "fork", scope: "global", limit: 60, windowSeconds: 3600 });
	});
});

describe("provisioning errors carry a reason", () => {
	it("marks a full fleet", () => {
		const error = toHttpError(new FleetFullError()) as HttpError;
		expect(error.status).toBe(429);
		expect(error.extra).toMatchObject({ reason: "fleet-full" });
	});

	it("marks a fork that is already being provisioned", () => {
		const error = toHttpError(new ProvisioningBusyError("user-s-1")) as HttpError;
		expect(error.status).toBe(409);
		expect(error.extra).toMatchObject({ reason: "busy" });
	});
});

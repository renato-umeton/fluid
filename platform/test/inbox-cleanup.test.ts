import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { INBOX_GRACE_MS, inboxCleanupDelayMs, inboxCleanupDue, outsideGrantKey, type OutsideGrant } from "../src/forks/outside.ts";
import { apiEnv, post, workerContext } from "./helpers/api-env.ts";

const grant = (over: Partial<OutsideGrant> = {}): OutsideGrant => ({ repo: "user-a", inbox: "inbox-user-a", userId: "a", tokenId: "tok_1", firstAt: "", mintedAt: "", expiresAt: "2026-10-06T13:00:00.000Z", ...over });

describe("inbox expiry", () => {
	it("deletes the inbox only while the token it was scheduled for is still the live one", () => {
		expect(inboxCleanupDue(grant(), { inbox: "inbox-user-a", tokenId: "tok_1" })).toBe(true);
		expect(inboxCleanupDue(grant({ tokenId: "tok_2" }), { inbox: "inbox-user-a", tokenId: "tok_1" })).toBe(false);
		expect(inboxCleanupDue(null, { inbox: "inbox-user-a", tokenId: "tok_1" })).toBe(false);
	});

	it("waits until the token expired plus a grace period for the last import", () => {
		const expires = Date.parse("2026-10-06T13:00:00.000Z");
		expect(inboxCleanupDelayMs("2026-10-06T13:00:00.000Z", expires - 60_000)).toBe(60_000 + INBOX_GRACE_MS);
		expect(inboxCleanupDelayMs("2026-10-06T13:00:00.000Z", expires + 10 * INBOX_GRACE_MS)).toBe(0);
	});
});

describe("fork deletion removes the inbox and its grant", () => {
	it("in the admin delete route", async () => {
		const t = apiEnv();
		t.artifacts.add("user-a");
		t.artifacts.add("inbox-user-a");
		t.fleet.register({ repo: "user-a", userId: "a", persona: "p", pinnedTag: "v1" });
		t.fleet.setValue(outsideGrantKey("user-a"), grant() as never);
		const res = await worker.fetch(post("/api/admin/forks/user-a/delete", { "x-fluid-admin": "admin-token" }), t.env, workerContext().ctx);
		expect(await res.json()).toMatchObject({ deleted: true, inboxDeleted: true });
		expect(t.artifacts.repos.has("inbox-user-a")).toBe(false);
		expect(t.fleet.getValue(outsideGrantKey("user-a"))).toBeNull();
	});

	it("in the cleanup of seeded forks", async () => {
		const t = apiEnv();
		const repo = "user-seed-abc123-1";
		t.artifacts.add(repo);
		t.artifacts.add(`inbox-${repo}`);
		t.fleet.register({ repo, userId: "seed-abc123-1", persona: "p", pinnedTag: "v1", seeded: true });
		t.fleet.setValue(outsideGrantKey(repo), grant({ repo, inbox: `inbox-${repo}` }) as never);
		const res = await worker.fetch(post("/api/admin/fleet/cleanup", { "x-fluid-admin": "admin-token" }), t.env, workerContext().ctx);
		expect(await res.json()).toMatchObject({ deleted: 1 });
		expect(t.artifacts.repos.has(`inbox-${repo}`)).toBe(false);
		expect(t.fleet.getValue(outsideGrantKey(repo))).toBeNull();
	});
});

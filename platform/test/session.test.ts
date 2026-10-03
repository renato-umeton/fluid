import { describe, expect, it } from "vitest";
import { SESSION_MAX_AGE_SECONDS, readCookie, safeEqual, sessionCookieHeader, signSession, verifySession } from "../src/lib/session.ts";
import { forkRepoName, isValidRepoName, ledgerRepoName, newIntentId, newSandboxUserId, normalizeUserId, userIdFromForkRepo } from "../src/lib/names.ts";

const SECRET = "test-secret-0123456789abcdef";
const session = { userId: "s-0a1b2c3d4e", persona: "hospitalist-researcher", issuedAt: 1_790_000_000_000 };

describe("session cookies", () => {
	it("round-trips a signed session", async () => {
		const value = await signSession(session, SECRET);
		expect(await verifySession(value, SECRET, session.issuedAt + 1000)).toEqual(session);
	});

	it("rejects a tampered payload", async () => {
		const value = await signSession(session, SECRET);
		const forged = await signSession({ ...session, userId: "admin" }, SECRET);
		const mixed = `${forged.split(".")[0]}.${value.split(".")[1]}`;
		expect(await verifySession(mixed, SECRET, session.issuedAt)).toBeNull();
	});

	it("rejects a cookie signed with another secret", async () => {
		const value = await signSession(session, "another-secret-0123456789");
		expect(await verifySession(value, SECRET, session.issuedAt)).toBeNull();
	});

	it("rejects an expired cookie", async () => {
		const value = await signSession(session, SECRET);
		expect(await verifySession(value, SECRET, session.issuedAt + SESSION_MAX_AGE_SECONDS * 1000 + 1)).toBeNull();
	});

	it("rejects garbage", async () => {
		expect(await verifySession("not-a-cookie", SECRET)).toBeNull();
	});

	it("requires a real secret", async () => {
		await expect(signSession(session, "short")).rejects.toThrow(/SESSION_SECRET/);
	});

	it("reads a cookie from the header", () => {
		expect(readCookie("a=1; fluid_session=abc.def; b=2", "fluid_session")).toBe("abc.def");
	});

	it("builds an HttpOnly cookie", () => {
		expect(sessionCookieHeader("v", true)).toMatch(/^fluid_session=v; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
	});

	it("compares admin tokens exactly", () => {
		expect([safeEqual("abc", "abc"), safeEqual("abc", "abd"), safeEqual("abc", "abcd")]).toEqual([true, false, false]);
	});
});

describe("names", () => {
	it("builds fork and ledger repo names", () => {
		expect([forkRepoName("s-0a1b2c3d4e"), ledgerRepoName("s-0a1b2c3d4e")]).toEqual(["user-s-0a1b2c3d4e", "ledger-s-0a1b2c3d4e"]);
	});

	it("normalizes user ids into valid repo names", () => {
		expect(normalizeUserId("Dr Rowan/Ellery")).toBe("dr-rowan-ellery");
	});

	it("rejects empty user ids", () => {
		expect(() => normalizeUserId("///")).toThrow(/invalid user id/);
	});

	it("validates repo names", () => {
		expect(["stock", "user-a.b_c", "-bad", "a/b", "x.git"].map(isValidRepoName)).toEqual([true, true, false, false, false]);
	});

	it("generates sandbox ids that make valid fork names", () => {
		expect(isValidRepoName(forkRepoName(newSandboxUserId()))).toBe(true);
	});

	it("extracts the user id from a fork repo", () => {
		expect([userIdFromForkRepo("user-s-01"), userIdFromForkRepo("stock")]).toEqual(["s-01", null]);
	});

	it("formats intent ids like the stock records", () => {
		expect(newIntentId(new Date("2026-10-03T12:00:00Z"), "0002")).toBe("int_2026_10_03_0002");
	});
});

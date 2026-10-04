import { describe, expect, it } from "vitest";
import { SESSION_MAX_AGE_SECONDS, readCookie, safeEqual, sessionCookieHeader, signSession, switchPersona, verifySession } from "../src/lib/session.ts";
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

describe("switching personas", () => {
	const ids = ["s-1111111111", "s-2222222222", "s-3333333333"];
	const nextId = () => ids.shift()!;

	it("gives a new persona a new user id and remembers the previous one", () => {
		const first = switchPersona(null, "hospitalist-researcher", 1, () => "s-aaaaaaaaaa");
		const second = switchPersona(first.session, "research-coordinator", 2, () => "s-bbbbbbbbbb");
		expect(second).toMatchObject({ reused: false, session: { userId: "s-bbbbbbbbbb", persona: "research-coordinator", known: { "hospitalist-researcher": "s-aaaaaaaaaa" } } });
	});

	it("switching back to a persona reuses its user id, so it keeps its fork", () => {
		const a = switchPersona(null, "hospitalist-researcher", 1, nextId).session;
		const b = switchPersona(a, "research-coordinator", 2, nextId).session;
		const back = switchPersona(b, "hospitalist-researcher", 3, () => "s-unused0000");
		expect(back).toMatchObject({ reused: true, session: { userId: a.userId, persona: "hospitalist-researcher", known: { "research-coordinator": b.userId } } });
	});

	it("keeps the remembered personas through signing", async () => {
		const s = { ...session, known: { "research-coordinator": "s-9999999999" } };
		expect(await verifySession(await signSession(s, SECRET), SECRET, session.issuedAt)).toEqual(s);
	});

	it("rejects a malformed remembered persona map", async () => {
		const value = await signSession({ ...session, known: { x: 5 } } as never, SECRET);
		expect(await verifySession(value, SECRET, session.issuedAt)).toBeNull();
	});
});

import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/puppeteer", () => ({ default: { launch: vi.fn() } }));

const { bedsideCheck, browserPlan, isPublicOrigin, launchFailure, preferencesCheck, summarizeBrowser } = await import("../src/yellow/browser.ts");
const { testSession, verifySession, signSession, TEST_SESSION_MAX_MS, testUserId } = await import("../src/lib/session.ts");

const SECRET = "a-test-secret-of-enough-length";

describe("browser tier plan", () => {
	it("runs for a user fork on a public https deployment", () => {
		expect(browserPlan({ hasBinding: true, origin: "https://fluid.example.workers.dev", seeded: false })).toEqual({ run: true });
	});

	it("is unavailable without a binding, without a known URL, or on a local URL", () => {
		expect(browserPlan({ hasBinding: false, origin: "https://fluid.example.workers.dev", seeded: false })).toMatchObject({ run: false, status: "unavailable" });
		expect(browserPlan({ hasBinding: true, origin: null, seeded: false })).toMatchObject({ run: false, status: "unavailable" });
		expect(browserPlan({ hasBinding: true, origin: "http://localhost:5173", seeded: false })).toMatchObject({ run: false, status: "unavailable", detail: expect.stringMatching(/local development/) });
	});

	it("skips seeded demo forks to limit browser usage during a release", () => {
		expect(browserPlan({ hasBinding: true, origin: "https://fluid.example.workers.dev", seeded: true })).toMatchObject({ run: false, status: "skipped" });
	});

	it("knows which origins a remote browser can reach", () => {
		expect(isPublicOrigin("https://fluid.renato83.workers.dev")).toBe(true);
		expect(isPublicOrigin("https://localhost:5173")).toBe(false);
		expect(isPublicOrigin("http://fluid.renato83.workers.dev")).toBe(false);
		expect(isPublicOrigin("not a url")).toBe(false);
	});

	it("maps a launch error to unavailable, never to a failure", () => {
		expect(launchFailure(new Error("Browser Rendering is not enabled for this account (403)"))).toEqual({ status: "unavailable", detail: expect.stringMatching(/not enabled/) });
	});
});

describe("browser checks", () => {
	it("accepts a clinical card with no dose and an override control", () => {
		expect(bedsideCheck({ mode: "clinical", text: "Institutional policy for Morphinex. Answer as Clinical Research", override: true }).passed).toBe(true);
	});

	it("fails a card that is not clinical, shows a dose, or has no override", () => {
		const check = bedsideCheck({ mode: "research", text: "Computed single dose: 7 mg", override: false });
		expect(check.passed).toBe(false);
		expect(check.detail).toBe('mode research; dose text "7 mg"; no override control');
		expect(bedsideCheck(null)).toMatchObject({ passed: false, detail: "no answer card appeared" });
	});

	it("compares the rendered font, density, accent, and tabs with the fork's preferences", () => {
		const prefs = { font: "palatino" as const, tabs: [{ title: "Charts", widgets: ["override-rate" as const] }] };
		expect(preferencesCheck(prefs, { font: "palatino", density: null, accent: null, tabs: ["Charts"] })).toMatchObject({ passed: true, detail: "font palatino, tabs Charts as configured" });
		expect(preferencesCheck(prefs, { font: null, density: null, accent: null, tabs: [] })).toMatchObject({ passed: false, detail: "font default, expected palatino; tabs [], expected [Charts]" });
		expect(preferencesCheck({}, { font: null, density: null, accent: null, tabs: [] })).toMatchObject({ passed: true, detail: "defaults as configured" });
	});

	it("fails the tier on any console error and passes it otherwise", () => {
		const ok = { name: "x", passed: true, detail: "" };
		expect(summarizeBrowser([ok], [], 10)).toMatchObject({ status: "passed", detail: "2 checks passed" });
		const failed = summarizeBrowser([ok], ["TypeError: x is undefined"], 10);
		expect(failed.status).toBe("failed");
		expect(failed.detail).toBe("failing: No console errors");
	});
});

describe("test sessions", () => {
	it("scope a synthetic user to one fork and expire within the cap", async () => {
		const now = Date.now();
		const session = testSession({ repo: "user-u", runId: "run_yellow_abc", persona: "hospitalist-researcher", now, ttlMs: 60 * 60 * 1000 });
		expect(session.userId).toBe(testUserId("run_yellow_abc"));
		expect(session.userId).toMatch(/^e2e-/);
		expect(session.e2e!.exp - now).toBe(TEST_SESSION_MAX_MS);
		const cookie = await signSession(session, SECRET);
		expect((await verifySession(cookie, SECRET, now + 1000))?.e2e?.repo).toBe("user-u");
		expect(await verifySession(cookie, SECRET, now + TEST_SESSION_MAX_MS + 1)).toBeNull();
	});

	it("rejects a test claim whose expiry is beyond the cap", async () => {
		const now = Date.now();
		const forged = { userId: "e2e-x", persona: "p", issuedAt: now, e2e: { repo: "user-u", runId: "r", exp: now + 24 * 3600 * 1000 } };
		expect(await verifySession(await signSession(forged, SECRET), SECRET, now)).toBeNull();
	});
});

describe("yellow failure hand-off", async () => {
	const { failureOf, repairGate, yellowRepairRunId } = await import("../src/workflows/yellow.ts");
	const result = {
		failures: [{ tier: "stock", scenario: "e2e-ledger-provenance", step: "ask", description: "provenance", path: "ledger.fork_commit", op: "equals", expected: "abc", actual: "build-cache" }],
	};

	it("names the failing scenario and step for the fleet state", () => {
		expect(failureOf(result, null)).toEqual({ tier: "stock", scenario: "e2e-ledger-provenance", step: "ask", detail: 'ledger.fork_commit equals: expected "abc", got "build-cache"' });
	});

	it("falls back to the failing browser check", () => {
		const browser = { status: "failed" as const, detail: "failing: No console errors", checks: [{ name: "No console errors", passed: false, detail: "1 error(s): boom" }], consoleErrors: ["boom"], durationMs: 1 };
		expect(failureOf({ failures: [] }, browser)).toEqual({ tier: "browser", scenario: "No console errors", step: null, detail: "1 error(s): boom" });
	});

	it("hands the repair agent its failures in the gate result shape", () => {
		const gate = repairGate({ repo: "user-u", commit: "y".repeat(40), stockTag: "v1.10.0", result: result as never, browser: null, runId: "run_yel" });
		expect(gate).toMatchObject({ ref: "main", passed: false, runId: "run_yel", failures: [{ tier: "e2e", probe: "e2e-ledger-provenance", description: "stock end-to-end scenario, step ask: provenance", path: "ledger.fork_commit", op: "equals" }] });
		expect(yellowRepairRunId("user-u", "y".repeat(40))).toMatch(/^run_repair_y_yyyyyyyyyyyy_/);
	});
});

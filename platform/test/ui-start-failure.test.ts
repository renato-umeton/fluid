import { describe, expect, it } from "vitest";
// @ts-expect-error plain ES module from the static UI
import { explainStartFailure, mockDemoHref } from "../public/js/start-failure.js";

function apiError(status: number, body: Record<string, unknown>) {
	return Object.assign(new Error(`POST /api/forks failed (${status}): ${String(body.error ?? "")}`), { status, body });
}

describe("explainStartFailure", () => {
	it("explains the fork cap of 500", () => {
		const out = explainStartFailure(apiError(429, { error: "the demo fleet is full; try again later", reason: "fleet-full" }));
		expect(out.title).toBe("The demo fleet is full");
		expect(out.message).toContain("500 forks");
	});

	it("explains this network's 3 forks per hour, with the wait in minutes", () => {
		const out = explainStartFailure(apiError(429, { reason: "rate-limit", bucket: "fork", scope: "client", limit: 3, windowSeconds: 3600, retryAfterSeconds: 1500 }));
		expect(out.title).toBe("You have used this hour's forks");
		expect(out.message).toContain("3 forks");
		expect(out.message).toContain("about 25 minutes");
	});

	it("explains the platform's 60 forks per hour", () => {
		const out = explainStartFailure(apiError(429, { reason: "rate-limit", bucket: "fork", scope: "global", limit: 60, windowSeconds: 3600, retryAfterSeconds: 30 }));
		expect(out.title).toBe("The live platform is busy");
		expect(out.message).toContain("60 forks");
		expect(out.message).toContain("about 1 minute");
	});

	it("explains the session limit for this network", () => {
		const out = explainStartFailure(apiError(429, { reason: "rate-limit", bucket: "session", scope: "client", limit: 20, windowSeconds: 3600, retryAfterSeconds: 120 }));
		expect(out.message).toContain("20 demo sessions");
	});

	it("asks to retry when the fork is still being set up", () => {
		const out = explainStartFailure(apiError(409, { reason: "busy" }));
		expect(out.title).toBe("Your fork is still being set up");
		expect(out.retry).toBe(true);
	});

	it("falls back to a plain message with the request id for any other error", () => {
		const out = explainStartFailure(apiError(500, { error: "internal error", requestId: "req-42" }));
		expect(out.title).toBe("The live platform could not set up your fork");
		expect(out.message).toContain("req-42");
		expect(out.retry).toBe(true);
	});

	it("handles an error with no response at all", () => {
		const out = explainStartFailure(new TypeError("Failed to fetch"));
		expect(out.title).toBe("The live platform could not set up your fork");
		expect(out.message).toContain("Failed to fetch");
	});

	it("always names mock mode as the way to see everything", () => {
		for (const error of [apiError(429, { reason: "fleet-full" }), new Error("x")]) {
			expect(explainStartFailure(error).mockNote).toContain("mock mode");
		}
	});
});

describe("mockDemoHref", () => {
	it("keeps the current view hash", () => {
		expect(mockDemoHref({ pathname: "/", search: "", hash: "#contest" })).toBe("/?mock=1#contest");
	});

	it("keeps a view with parameters", () => {
		expect(mockDemoHref({ pathname: "/", search: "", hash: "#tab?i=1" })).toBe("/?mock=1#tab?i=1");
	});

	it("replaces any other query and works without a hash", () => {
		expect(mockDemoHref({ pathname: "/", search: "?mock=0&x=1", hash: "" })).toBe("/?mock=1");
	});

	it("defaults the path to the root", () => {
		expect(mockDemoHref({ pathname: "", search: "", hash: "#fork" })).toBe("/?mock=1#fork");
	});
});

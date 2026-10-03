import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeParam, errorResponse, HttpError, MAX_BODY_BYTES, readJson, requireJsonPost } from "../src/api/http.ts";
import { askRef, parsePreferences, toHttpError } from "../src/api/validate.ts";
import { clientKey } from "../src/lib/client.ts";
import { InvalidRefError, RefNotFoundError } from "../src/runtime/refs.ts";
import { RepoNotFoundError } from "../src/runtime/repo-files.ts";
import { ForkNotFoundError } from "../src/forks/provision.ts";

const statusOf = async (fn: () => unknown) => {
	try {
		await fn();
		return 0;
	} catch (error) {
		return error instanceof HttpError ? error.status : -1;
	}
};

describe("clientKey", () => {
	it("keeps an IPv4 address", () => {
		expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
	});

	it("groups an IPv6 address by its /64", () => {
		expect(clientKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
	});

	it("expands a compressed IPv6 address before taking the /64", () => {
		expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
	});

	it("puts two hosts of one /64 in the same bucket", () => {
		expect(clientKey("2001:DB8:1:2::1")).toBe(clientKey("2001:db8:1:2:ffff::9"));
	});

	it("reads an IPv4-mapped IPv6 address as IPv4", () => {
		expect(clientKey("::ffff:198.51.100.4")).toBe("198.51.100.4");
	});

	it("falls back to local without an address", () => {
		expect(clientKey(null)).toBe("local");
	});
});

describe("readJson", () => {
	const post = (body: BodyInit | null, headers: Record<string, string> = {}) => new Request("https://x/api/y", { method: "POST", body, headers });

	it("parses a JSON object", async () => {
		expect(await readJson(post('{"a":1}'))).toEqual({ a: 1 });
	});

	it("refuses a declared length over the limit without reading the body", async () => {
		const pulled = vi.fn();
		const body = new ReadableStream({ pull: pulled }, { highWaterMark: 0 });
		const request = new Request("https://x/api/y", { method: "POST", body, headers: { "content-length": String(MAX_BODY_BYTES + 1) }, duplex: "half" } as RequestInit);
		expect([await statusOf(() => readJson(request)), pulled.mock.calls.length]).toEqual([413, 0]);
	});

	it("counts bytes, not characters", async () => {
		const text = JSON.stringify({ a: "é".repeat(MAX_BODY_BYTES / 2 + 10) });
		expect(await statusOf(() => readJson(post(text)))).toBe(413);
	});

	it("refuses a streamed body that passes the limit", async () => {
		const chunk = new Uint8Array(16 * 1024).fill(32);
		let sent = 0;
		const body = new ReadableStream({
			pull(controller) {
				if (sent++ < 10) controller.enqueue(chunk);
				else controller.close();
			},
		});
		const request = new Request("https://x/api/y", { method: "POST", body, duplex: "half" } as RequestInit);
		expect(await statusOf(() => readJson(request))).toBe(413);
	});

	it("rejects a non-object body", async () => {
		expect(await statusOf(() => readJson(post("[1]")))).toBe(400);
	});
});

describe("decodeParam", () => {
	it("decodes an escaped path segment", () => {
		expect(decodeParam("user%2Da")).toBe("user-a");
	});

	it("turns a malformed escape into a 400", async () => {
		expect(await statusOf(() => decodeParam("%E0%A4%A"))).toBe(400);
	});
});

describe("requireJsonPost", () => {
	const url = new URL("https://fluid.example/api/session");
	const req = (headers: Record<string, string>, method = "POST") => new Request(url, { method, headers, body: method === "POST" ? "{}" : undefined });

	it("accepts a same-origin JSON post", async () => {
		expect(await statusOf(() => requireJsonPost(req({ "content-type": "application/json", origin: "https://fluid.example" }), url))).toBe(0);
	});

	it("accepts a JSON post without an Origin header (scripts)", async () => {
		expect(await statusOf(() => requireJsonPost(req({ "content-type": "application/json; charset=utf-8" }), url))).toBe(0);
	});

	it("refuses a form post, which a cross-site page can send without a preflight", async () => {
		expect(await statusOf(() => requireJsonPost(req({ "content-type": "text/plain" }), url))).toBe(415);
	});

	it("refuses a post from another origin", async () => {
		expect(await statusOf(() => requireJsonPost(req({ "content-type": "application/json", origin: "https://evil.example" }), url))).toBe(403);
	});

	it("leaves GET requests alone", async () => {
		expect(await statusOf(() => requireJsonPost(req({}, "GET"), url))).toBe(0);
	});
});

describe("errorResponse", () => {
	afterEach(() => vi.restoreAllMocks());

	it("returns the message and a request id for an HttpError", async () => {
		const res = errorResponse(new HttpError(404, "fork user-a not found"), "req-1");
		expect([res.status, await res.json(), res.headers.get("x-request-id")]).toEqual([404, { error: "fork user-a not found", requestId: "req-1" }, "req-1"]);
	});

	it("hides the details of an unexpected error", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const res = errorResponse(new Error("binding failed with art_v2_abcdef0123?expires=1"), "req-2");
		expect([res.status, await res.json()]).toEqual([500, { error: "internal error", requestId: "req-2" }]);
	});

	it("logs the scrubbed details with the request id", () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		errorResponse(new Error("binding failed with art_v2_abcdef0123?expires=1"), "req-3");
		const logged = log.mock.calls.flat().join(" ");
		expect([logged.includes("req-3"), logged.includes("art_v2_abcdef0123"), logged.includes("<redacted-token>")]).toEqual([true, false, true]);
	});
});

describe("parsePreferences", () => {
	it("accepts no preferences", () => {
		expect(parsePreferences(undefined)).toEqual({});
	});

	it("accepts booleans", () => {
		expect(parsePreferences({ auto_upgrade: true, harvest_opt_in: false })).toEqual({ auto_upgrade: true, harvest_opt_in: false });
	});

	it("rejects a non-boolean value", async () => {
		expect(await statusOf(() => parsePreferences({ auto_upgrade: "yes" }))).toBe(400);
	});

	it("rejects an unknown key", async () => {
		expect(await statusOf(() => parsePreferences({ tau: 0.5 }))).toBe(400);
	});

	it("rejects a non-object", async () => {
		expect(await statusOf(() => parsePreferences([true]))).toBe(400);
	});
});

describe("askRef", () => {
	it("defaults to main", () => {
		expect(askRef(undefined, false)).toBe("main");
	});

	it("shortens a full branch ref", () => {
		expect(askRef("refs/heads/work/x", false)).toBe("work/x");
	});

	it("refuses a commit SHA from a visitor", async () => {
		expect(await statusOf(() => askRef("a".repeat(40), false))).toBe(400);
	});

	it("allows a commit SHA for the admin", () => {
		expect(askRef("a".repeat(40), true)).toBe("a".repeat(40));
	});

	it("refuses a malformed ref", async () => {
		expect(await statusOf(() => askRef("main..x", false))).toBe(400);
	});

	it("refuses a non-string ref", async () => {
		expect(await statusOf(() => askRef(42, false))).toBe(400);
	});
});

describe("toHttpError", () => {
	it("maps a missing ref to a generic 404", () => {
		expect(toHttpError(new RefNotFoundError("deadbeef"))).toMatchObject({ status: 404, message: "not found" });
	});

	it("maps a missing repo to a generic 404 without the binding's message", () => {
		expect(toHttpError(new RepoNotFoundError("ledger-x", new Error("internal detail")))).toMatchObject({ status: 404, message: "not found" });
	});

	it("maps a missing fork to a 404", () => {
		expect(toHttpError(new ForkNotFoundError("user-a"))).toMatchObject({ status: 404 });
	});

	it("maps an invalid ref to a 400", () => {
		expect(toHttpError(new InvalidRefError("bad"))).toMatchObject({ status: 400 });
	});

	it("passes other errors through", () => {
		const error = new Error("boom");
		expect(toHttpError(error)).toBe(error);
	});
});

import { describe, expect, it } from "vitest";
// @ts-expect-error plain ES module from the static UI
import { expiryText, importNoteView, maskCommand, secondsLeft } from "../public/js/outside-agent.js";

describe("import outcome lines", () => {
	const note = { at: "2026-10-06T12:00:00.000Z", branch: "work/my-change", commit: "abcdef1", runId: null };

	it("says a refused push was not imported, and why", () => {
		expect(importNoteView({ ...note, status: "refused", reason: "the branch changes 240 files; at most 200 are imported" })).toEqual({ tag: "Refused", state: "fail", text: "work/my-change at abcdef1: not imported. The branch changes 240 files; at most 200 are imported." });
	});

	it("says what happened to an imported push", () => {
		expect(importNoteView({ ...note, status: "imported", reason: "imported as work/inbox/my-change and sent to the gate" })).toEqual({ tag: "Imported", state: "pass", text: "work/my-change at abcdef1: imported as work/inbox/my-change and sent to the gate." });
	});

	it("marks a contest entry that did not join", () => {
		expect(importNoteView({ ...note, status: "not joined", reason: "Not in the contest: the join window closed." })).toMatchObject({ tag: "Not in the contest", state: "warn" });
	});

	it("copes with a missing reason", () => {
		expect(importNoteView({ ...note, status: "refused", reason: null }).text).toBe("work/my-change at abcdef1: not imported.");
	});
});

const AT = Date.parse("2026-10-06T12:00:00Z");

describe("outside agent panel helpers", () => {
	it("counts down the seconds left on the token", () => {
		expect(secondsLeft("2026-10-06T13:00:00Z", AT)).toBe(3600);
		expect(secondsLeft("2026-10-06T11:00:00Z", AT)).toBe(0);
		expect(secondsLeft("not a date", AT)).toBe(0);
	});

	it("shows minutes and seconds until expiry", () => {
		expect(expiryText("2026-10-06T13:00:00Z", AT)).toBe("Expires in 60:00");
		expect(expiryText("2026-10-06T12:01:05Z", AT)).toBe("Expires in 1:05");
	});

	it("says when the token has expired", () => {
		expect(expiryText("2026-10-06T12:00:00Z", AT)).toBe("Expired. Get a new token to push again.");
	});

	it("hides the secret in a command for display", () => {
		expect(maskCommand("git clone https://x:art_v2_secret123@acct.artifacts.cloudflare.net/git/fluid/user-a.git user-a")).toBe("git clone https://x:art_v2_****@acct.artifacts.cloudflare.net/git/fluid/user-a.git user-a");
		expect(maskCommand("git push origin work/my-change")).toBe("git push origin work/my-change");
	});
});

// Security events Fleet keeps for polymorphic copies. The fleet stream is
// public, so it learns that something happened to a fork, never a name, path,
// or fingerprint.
import { describe, expect, it } from "vitest";
import { Fleet, SECURITY_EVENTS_PER_REPO } from "../src/durable/fleet.ts";
import { construct } from "./helpers/durable.ts";

const fork = (repo: string) => ({ repo, userId: repo.replace(/^user-/, ""), persona: "p", pinnedTag: "v1.1.0" });
const t0 = Date.parse("2026-11-06T10:00:00Z");
const iso = (at: number) => new Date(at).toISOString();
const hit = { hit: "decoy", name: "researchNeedsAttestation", path: "context.display.researchNeedsAttestation", fingerprint: "a1b2c3d4", epoch: 1 };

function fleetWith(...repos: string[]): Fleet {
	const { instance: fleet } = construct(Fleet);
	for (const repo of repos) fleet.register({ ...fork(repo), status: "pinned" });
	return fleet;
}

describe("Fleet security events", () => {
	it("records events with their time and lists them newest first, up to a limit", () => {
		const fleet = fleetWith("user-a", "user-b");
		expect(fleet.recordSecurityEvent("user-a", { kind: "tripwire", detail: hit }, t0)).toEqual({ kind: "tripwire", at: iso(t0), detail: hit });
		fleet.recordSecurityEvent("user-b", { kind: "tripwire" }, t0 + 1);
		fleet.recordSecurityEvent("user-a", { kind: "rotated", detail: { epoch: 2 } }, t0 + 2);
		expect(fleet.securityEvents("user-a")).toEqual([
			{ kind: "rotated", at: iso(t0 + 2), detail: { epoch: 2 } },
			{ kind: "tripwire", at: iso(t0), detail: hit },
		]);
		expect(fleet.securityEvents("user-a", 1)).toEqual([{ kind: "rotated", at: iso(t0 + 2), detail: { epoch: 2 } }]);
		expect(fleet.securityEvents("user-b")).toEqual([{ kind: "tripwire", at: iso(t0 + 1) }]);
	});

	it("keeps the latest ones per fork", () => {
		const fleet = fleetWith("user-a");
		for (let i = 0; i < SECURITY_EVENTS_PER_REPO + 5; i++) fleet.recordSecurityEvent("user-a", { kind: "tripwire", detail: { n: i } }, t0 + i);
		const events = fleet.securityEvents("user-a", SECURITY_EVENTS_PER_REPO + 5);
		expect(events).toHaveLength(SECURITY_EVENTS_PER_REPO);
		expect(events[0]!.detail).toEqual({ n: SECURITY_EVENTS_PER_REPO + 4 });
	});

	it("records nothing for a repo not in the fleet, and refuses a kind it does not know", () => {
		const fleet = fleetWith("user-a");
		expect(fleet.recordSecurityEvent("user-zz", { kind: "tripwire" })).toBeNull();
		expect(fleet.securityEvents("user-zz")).toEqual([]);
		expect(() => fleet.recordSecurityEvent("user-a", { kind: "researchNeedsAttestation" as never })).toThrow(/kind/);
		expect(fleet.securityEvents("user-a")).toEqual([]);
	});

	it("go with the fork when it is removed", () => {
		const fleet = fleetWith("user-a");
		fleet.recordSecurityEvent("user-a", { kind: "tripwire" }, t0);
		fleet.remove("user-a");
		expect(fleet.securityEvents("user-a")).toEqual([]);
	});

	it("tell stream subscribers the repo, the kind, and the time, and nothing more", async () => {
		const fleet = fleetWith("user-a");
		const response = await fleet.fetch(new Request("https://fleet/stream", { headers: { "x-fluid-client": "203.0.113.7" } }));
		const reader = response.body!.getReader();
		fleet.recordSecurityEvent("user-a", { kind: "tripwire", detail: hit }, t0);
		const { raw, data } = await nextEvent(reader, "security");
		await reader.cancel();
		expect(data).toEqual({ type: "security", repo: "user-a", kind: "tripwire", at: iso(t0) });
		for (const secret of [hit.name, hit.path, hit.fingerprint, "decoy"]) expect(raw).not.toContain(secret);
	});
});

/** Reads server-sent events until one of the given type arrives; returns its text and its parsed data. */
async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>, type: string): Promise<{ raw: string; data: unknown }> {
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`the stream ended before a ${type} event`);
		buffer += decoder.decode(value, { stream: true });
		for (const block of buffer.split("\n\n")) {
			const match = /^event: (\S+)\ndata: (.*)$/s.exec(block);
			if (match?.[1] === type) return { raw: block, data: JSON.parse(match[2]!) };
		}
	}
}

// What Fleet keeps for polymorphic copies: the verified copy per fork (read on
// every ask), and security events. The fleet stream is public, so it learns
// that something happened to a fork, never a name, path, or fingerprint.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { serveAsk } from "../src/api/ask.ts";
import { Fleet, SECURITY_EVENTS_PER_REPO } from "../src/durable/fleet.ts";
import { clipValue } from "../src/gate/tiers.ts";
import { construct, fakeState } from "./helpers/durable.ts";
import { PUBLISHED, TAG, polymorphPlatform, type PolymorphPlatform } from "./helpers/polymorph-platform.ts";

const fork = (repo: string) => ({ repo, userId: repo.replace(/^user-/, ""), persona: "p", pinnedTag: "v1.1.0" });
const SHA = "0123456789abcdef0123456789abcdef01234567";
const copy = { epoch: 1, sha: SHA, fingerprint: "a1b2c3d4", namesHash: "87806eb6" };
const t0 = Date.parse("2026-11-06T10:00:00Z");
const iso = (at: number) => new Date(at).toISOString();
const hit = { hit: "decoy", name: "researchNeedsAttestation", path: "context.display.researchNeedsAttestation", fingerprint: copy.fingerprint, epoch: 1 };

function fleetWith(...repos: string[]): Fleet {
	const { instance: fleet } = construct(Fleet);
	for (const repo of repos) fleet.register({ ...fork(repo), status: "pinned" });
	return fleet;
}

describe("Fleet morph state", () => {
	it("is null for a fork without a verified copy and for a repo not in the fleet", () => {
		const fleet = fleetWith("user-a");
		expect(fleet.morphState("user-a")).toBeNull();
		expect(fleet.morphState("user-zz")).toBeNull();
	});

	it("stores the verified copy with the time it was stored, and a later one replaces it", () => {
		const fleet = fleetWith("user-a");
		expect(fleet.setMorph("user-a", copy, { from: null }, t0)).toBe(true);
		expect(fleet.morphState("user-a")).toEqual({ ...copy, at: iso(t0) });
		const next = { ...copy, epoch: 2, fingerprint: "0f0f0f0f", namesHash: "12345678" };
		expect(fleet.setMorph("user-a", next, { from: 1 }, t0 + 1000)).toBe(true);
		expect(fleet.morphState("user-a")).toEqual({ ...next, at: iso(t0 + 1000) });
	});

	it("stores a state only over the epoch the caller read, so a slower writer cannot undo a newer copy", () => {
		const fleet = fleetWith("user-a");
		expect(fleet.setMorph("user-a", copy, { from: null }, t0)).toBe(true);
		// Read before epoch 1 was stored, or before epoch 2 was: nothing changes.
		expect(fleet.setMorph("user-a", { ...copy, epoch: 2 }, { from: null }, t0 + 1)).toBe(false);
		expect(fleet.setMorph("user-a", { ...copy, epoch: 2 }, { from: 1 }, t0 + 2)).toBe(true);
		expect(fleet.setMorph("user-a", { ...copy, epoch: 2, fingerprint: "0f0f0f0f" }, { from: 1 }, t0 + 3)).toBe(false);
		expect(fleet.morphState("user-a")).toEqual({ ...copy, epoch: 2, at: iso(t0 + 2) });
	});

	it("clears it, also only over the epoch the caller read", () => {
		const fleet = fleetWith("user-a");
		fleet.setMorph("user-a", copy, { from: null }, t0);
		expect(fleet.setMorph("user-a", null, { from: 7 })).toBe(false);
		expect(fleet.setMorph("user-a", null, { from: 1 })).toBe(true);
		expect(fleet.morphState("user-a")).toBeNull();
	});

	it("stores nothing for a repo not in the fleet", () => {
		const fleet = fleetWith("user-a");
		expect(fleet.setMorph("user-zz", copy, { from: null })).toBe(false);
		expect(fleet.morphState("user-zz")).toBeNull();
	});

	it("refuses a state that cannot name a copy", () => {
		const fleet = fleetWith("user-a");
		for (const bad of [{ epoch: -1 }, { epoch: 1.5 }, { sha: "main" }, { sha: SHA.toUpperCase() }, { fingerprint: "a1b2c3" }, { namesHash: "zzzzzzzz" }]) {
			expect(() => fleet.setMorph("user-a", { ...copy, ...bad }, { from: null })).toThrow(/setMorph/);
		}
		expect(fleet.morphState("user-a")).toBeNull();
	});

	it("survives the fork's other updates, and goes with the fork when it is removed", () => {
		const fleet = fleetWith("user-a");
		fleet.setMorph("user-a", copy, { from: null }, t0);
		fleet.update("user-a", { status: "gating" });
		fleet.register({ ...fork("user-a"), status: "pinned" });
		expect(fleet.morphState("user-a")).toEqual({ ...copy, at: iso(t0) });
		fleet.remove("user-a");
		fleet.register({ ...fork("user-a"), status: "pinned" });
		expect(fleet.morphState("user-a")).toBeNull();
	});

	it("stays out of the fork records and the snapshot the public fleet view shows", () => {
		const fleet = fleetWith("user-a");
		fleet.setMorph("user-a", copy, { from: null }, t0);
		const shown = JSON.stringify([fleet.get("user-a"), fleet.list(), fleet.snapshot()]);
		for (const secret of [copy.fingerprint, copy.namesHash]) expect(shown).not.toContain(secret);
	});

	it("adds its columns to a forks table made before them", () => {
		const state = fakeState();
		state.storage.sql.exec(
			"CREATE TABLE forks (repo TEXT PRIMARY KEY, user_id TEXT NOT NULL, persona TEXT NOT NULL, pinned_tag TEXT NOT NULL, status TEXT NOT NULL, last_run TEXT, seeded INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
		);
		state.storage.sql.exec("INSERT INTO forks (repo, user_id, persona, pinned_tag, status, created_at, updated_at) VALUES ('user-old', 'old', 'p', 'v1.0.0', 'pinned', ?, ?)", iso(t0), iso(t0));
		const fleet = new Fleet(state as never, {} as never);
		expect(fleet.morphState("user-old")).toBeNull();
		expect(fleet.setMorph("user-old", copy, { from: null }, t0)).toBe(true);
		expect(fleet.morphState("user-old")).toEqual({ ...copy, at: iso(t0) });
		expect(fleet.get("user-old")).toMatchObject({ repo: "user-old", status: "pinned" });
	});
});

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

	it("clips long detail values, so one event stays small", () => {
		const fleet = fleetWith("user-a");
		const long = `context.${"x".repeat(5000)}`;
		const event = fleet.recordSecurityEvent("user-a", { kind: "tripwire", detail: { path: long, keys: Array.from({ length: 500 }, (_, i) => `k${i}`), epoch: 3 } }, t0)!;
		expect(event.detail).toEqual({ path: clipValue(long), keys: clipValue(Array.from({ length: 500 }, (_, i) => `k${i}`)), epoch: 3 });
		expect(JSON.stringify(event).length).toBeLessThan(1200);
		expect(fleet.securityEvents("user-a")).toEqual([event]);
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

	it("reach the stream at most once per fork and kind every 10 seconds, and never for a refused rotation", async () => {
		const fleet = fleetWith("user-a", "user-b");
		const response = await fleet.fetch(new Request("https://fleet/stream", { headers: { "x-fluid-client": "203.0.113.8" } }));
		const reader = response.body!.getReader();
		const record = (repo: string, kind: "tripwire" | "rotated" | "rotation_refused", after: number) => fleet.recordSecurityEvent(repo, { kind }, t0 + after);
		record("user-a", "tripwire", 0);
		record("user-a", "tripwire", 1_000);
		record("user-a", "rotated", 2_000);
		record("user-b", "tripwire", 3_000);
		record("user-a", "rotation_refused", 4_000);
		record("user-a", "tripwire", 9_999);
		record("user-a", "tripwire", 10_000);
		// A fork event after them marks where they end.
		fleet.register({ ...fork("user-c"), status: "pinned" });
		const events = await readUntil(reader, "fork");
		await reader.cancel();
		expect(events.filter((event) => event.type === "security").map((event) => event.data)).toEqual([
			{ type: "security", repo: "user-a", kind: "tripwire", at: iso(t0) },
			{ type: "security", repo: "user-a", kind: "rotated", at: iso(t0 + 2_000) },
			{ type: "security", repo: "user-b", kind: "tripwire", at: iso(t0 + 3_000) },
			{ type: "security", repo: "user-a", kind: "tripwire", at: iso(t0 + 10_000) },
		]);
		expect(fleet.securityEvents("user-a")).toHaveLength(6);
	});

	it("tell stream subscribers the repo, the kind, and the time, and nothing more", async () => {
		const fleet = fleetWith("user-a");
		const response = await fleet.fetch(new Request("https://fleet/stream", { headers: { "x-fluid-client": "203.0.113.7" } }));
		const reader = response.body!.getReader();
		fleet.recordSecurityEvent("user-a", { kind: "tripwire", detail: hit }, t0);
		const { raw, data } = (await readUntil(reader, "security")).at(-1)!;
		await reader.cancel();
		expect(data).toEqual({ type: "security", repo: "user-a", kind: "tripwire", at: iso(t0) });
		for (const secret of [hit.name, hit.path, hit.fingerprint, "decoy"]) expect(raw).not.toContain(secret);
	});
});

describe("Fleet.askState", () => {
	it("answers the ask path's questions about a fork in one call: its safety fallback and its verified copy", () => {
		const fleet = fleetWith("user-a");
		expect(fleet.askState("user-a")).toEqual({ fallback: null, morph: null });
		fleet.setMorph("user-a", copy, { from: null }, t0);
		fleet.addRelease({ tag: "v1.2.0", notes: "", safety: true, date: iso(t0), graceDays: 14, graceUntil: iso(t0 + 1000), commit: null });
		expect(fleet.askState("user-a", t0 + 2000)).toEqual({ fallback: fleet.safetyFallback("user-a", t0 + 2000), morph: { ...copy, at: iso(t0) } });
		expect(fleet.askState("user-a", t0 + 2000).fallback).toMatchObject({ tag: "v1.2.0", from: "v1.1.0" });
		expect(fleet.askState("user-zz")).toEqual({ fallback: null, morph: null });
	});
});

describe("serveAsk", () => {
	let p: PolymorphPlatform;
	beforeAll(() => {
		p = polymorphPlatform({ "user-a": PUBLISHED });
	});
	afterAll(() => p?.cleanup());

	it("still serves stock once a safety grace period is over, asking Fleet once through askState", async () => {
		const fleet = p.t.fleet;
		fleet.register({ ...fork("user-a"), pinnedTag: "v0.9.0", status: "pinned" });
		fleet.addRelease({ tag: TAG, notes: "", safety: true, date: iso(t0), graceDays: 14, graceUntil: iso(t0), commit: null });
		const askState = vi.spyOn(fleet, "askState");
		const request = { question: "Is Morphinex on formulary?", context: { documentType: "budget" } };
		const card = await serveAsk(p.deps, { repo: "user-a", ref: "main", request, useModel: false, userId: "a", fallback: true });
		expect(card.fork).toMatchObject({ repo: "user-a", servedBy: { repo: "stock", ref: TAG }, safetyFallback: { tag: TAG, from: "v0.9.0" } });
		expect(askState).toHaveBeenCalledTimes(1);
	});
});

/** Reads server-sent events until one of the given type arrives; returns every event read, in order, with its text and parsed data. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, type: string): Promise<{ type: string; raw: string; data: unknown }[]> {
	const decoder = new TextDecoder();
	const events: { type: string; raw: string; data: unknown }[] = [];
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`the stream ended before a ${type} event`);
		buffer += decoder.decode(value, { stream: true });
		for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
			const block = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			const match = /^event: (\S+)\ndata: (.*)$/s.exec(block);
			if (match === null) continue;
			events.push({ type: match[1]!, raw: block, data: JSON.parse(match[2]!) });
			if (match[1] === type) return events;
		}
	}
}

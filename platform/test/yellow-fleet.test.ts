import { describe, expect, it } from "vitest";
import { Fleet } from "../src/durable/fleet.ts";
import { construct } from "./helpers/durable.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const R = "r".repeat(40);
const failure = { tier: "stock", scenario: "e2e-ledger-provenance", step: "ask", detail: "fork_commit" };

function fleetWith(...repos: string[]) {
	const { instance: fleet } = construct(Fleet);
	for (const repo of repos) fleet.register({ repo, userId: repo.slice(5), persona: "p", pinnedTag: "v1.9.0" });
	return fleet;
}

describe("Fleet yellow to green state", () => {
	it("shows forks with no history as green, including in the snapshot counts", () => {
		const fleet = fleetWith("user-a", "user-b");
		expect(fleet.health("user-a")).toMatchObject({ health: "green", lastGreenCommit: null });
		expect(fleet.snapshot().healthCounts).toEqual({ green: 2, yellow: 0, rolled_back: 0 });
		expect(fleet.snapshot().forks[0]!.health.health).toBe("green");
	});

	it("goes yellow, records passes, and turns green with history", () => {
		const fleet = fleetWith("user-a");
		fleet.yellowStart("user-a", { commit: B, runId: "run_1", previous: A, source: "customize" });
		expect(fleet.snapshot().healthCounts).toEqual({ green: 0, yellow: 1, rolled_back: 0 });
		for (const pass of [1, 2]) expect(fleet.yellowPass("user-a", { runId: "run_1", pass })).toMatchObject({ stale: false, state: { health: "yellow", pass } });
		expect(fleet.yellowPass("user-a", { runId: "run_1", pass: 3 })).toMatchObject({ stale: false, state: { health: "green", lastGreenCommit: B } });
		expect(fleet.healthHistory("user-a").map((e) => e.event)).toEqual(["green", "pass", "pass", "yellow"]);
	});

	it("keeps status and health apart: an update never resets health", () => {
		const fleet = fleetWith("user-a");
		fleet.yellowStart("user-a", { commit: B, runId: "run_1", previous: A, source: "upgrade" });
		fleet.update("user-a", { status: "passed", pinnedTag: "v1.10.0" });
		expect(fleet.get("user-a")).toMatchObject({ status: "passed", pinnedTag: "v1.10.0", health: { health: "yellow", commit: B } });
	});

	it("rolls back, reports stale results from superseded runs, and cancels", () => {
		const fleet = fleetWith("user-a");
		fleet.yellowStart("user-a", { commit: B, runId: "run_1", previous: A, source: "customize" });
		fleet.yellowStart("user-a", { commit: C, runId: "run_2", previous: B, source: "customize" });
		expect(fleet.yellowFailure("user-a", { runId: "run_1", failure, revertCommit: R })?.stale).toBe(true);
		expect(fleet.yellowCancel("user-a", { runId: "run_1", reason: "superseded" })?.stale).toBe(true);
		expect(fleet.yellowFailure("user-a", { runId: "run_2", failure, revertCommit: R })).toMatchObject({ stale: false, state: { health: "rolled_back", commit: R, lastGreenCommit: R, rolledBackFrom: C } });
		expect(fleet.healthHistory("user-a").map((e) => e.event)).toEqual(["rolled_back", "failed", "cancelled", "yellow", "superseded", "yellow"]);
	});

	it("broadcasts health changes to stream subscribers", async () => {
		const fleet = fleetWith("user-a");
		const response = await fleet.fetch(new Request("https://fleet/stream", { headers: { "x-fluid-client": "c" } }));
		const reader = response.body!.getReader();
		await reader.read(); // snapshot
		fleet.yellowStart("user-a", { commit: B, runId: "run_1", previous: A, source: "customize" });
		const { value } = await reader.read();
		const text = new TextDecoder().decode(value);
		expect(text).toContain("event: fork");
		expect(text).toContain('"health":"yellow"');
		await reader.cancel();
	});

	it("drops a fork's history with the fork", () => {
		const fleet = fleetWith("user-a");
		fleet.yellowStart("user-a", { commit: B, runId: "run_1", previous: A, source: "customize" });
		fleet.remove("user-a");
		expect(fleet.healthHistory("user-a")).toEqual([]);
		expect(fleet.yellowStart("user-a", { commit: B, runId: "run_1", previous: A, source: "customize" })).toBeNull();
	});
});

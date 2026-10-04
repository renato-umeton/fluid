import { describe, expect, it } from "vitest";
import { Fleet } from "../src/durable/fleet.ts";
import { baselineRecord, BASELINE_LIMITS, baselinePage } from "../src/yellow/baseline.ts";
import type { E2ERunResult } from "../src/yellow/run.ts";
import { construct } from "./helpers/durable.ts";

const C = "c".repeat(40);
const run = (extra: Partial<E2ERunResult> = {}): E2ERunResult => ({ repo: "user-a", commit: C, stockTag: "v1.5.0", runner: "bundled", at: "2026-10-04T12:00:00.000Z", passed: true, retryable: false, tiers: [], failures: [], durationMs: 1200, testUser: "e2e-x", ...extra });

describe("fleet baseline", () => {
	it("summarizes a dry run as a baseline record", () => {
		expect(baselineRecord(run())).toEqual({ at: "2026-10-04T12:00:00.000Z", commit: C, stockTag: "v1.5.0", runner: "bundled", passed: true, failure: null, durationMs: 1200 });
		const failed = baselineRecord(run({ passed: false, failures: [{ tier: "platform", scenario: "platform-override-ledger", step: "record", path: "override", op: "equals", expected: "research", actual: null }] }));
		expect(failed).toMatchObject({ passed: false, failure: { tier: "platform", scenario: "platform-override-ledger", step: "record", detail: expect.stringContaining("override equals") } });
	});

	it("is stored apart from health: a failing baseline flags the fork and never rolls it back", () => {
		const { instance: fleet } = construct(Fleet);
		fleet.register({ repo: "user-a", userId: "a", persona: "p", pinnedTag: "v1.5.0" });
		fleet.register({ repo: "user-b", userId: "b", persona: "p", pinnedTag: "v1.5.0" });
		const before = fleet.get("user-a")!.health;
		fleet.recordBaseline("user-a", baselineRecord(run({ passed: false, failures: [{ tier: "platform", scenario: "s", step: null, path: "", op: "read", expected: 1, actual: 2 }] })));
		expect(fleet.get("user-a")).toMatchObject({ health: before, baseline: { passed: false } });
		expect(fleet.get("user-b")!.baseline).toBeNull();
		expect(fleet.snapshot().baselineCounts).toEqual({ passed: 0, flagged: 1, none: 1 });
		expect(fleet.snapshot().forks.find((f) => f.repo === "user-a")!.baseline?.passed).toBe(false);
		expect(fleet.recordBaseline("user-missing", baselineRecord(run()))).toBeNull();
	});

	it("pages through the fleet in bounded slices", () => {
		const repos = Array.from({ length: 30 }, (_, i) => `user-${i}`);
		expect(baselinePage(repos, { offset: 0, limit: 10 })).toEqual({ repos: repos.slice(0, 10), next: 10 });
		expect(baselinePage(repos, { offset: 20, limit: 10 })).toEqual({ repos: repos.slice(20), next: null });
		expect(baselinePage(repos, { offset: 0, limit: 999 }).repos).toHaveLength(BASELINE_LIMITS.maxPage);
		expect(baselinePage(repos, { offset: -5, limit: 0 }).repos).toEqual(repos.slice(0, 1));
	});
});

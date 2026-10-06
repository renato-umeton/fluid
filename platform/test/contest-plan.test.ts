import { describe, expect, it } from "vitest";
import { Fleet } from "../src/durable/fleet.ts";
import { Quota } from "../src/durable/quota.ts";
import { construct } from "./helpers/durable.ts";
import { behaviorFiles, contestBranch, contestIdOfBranch, CONTEST_LIMITS, entrantOf, joinDecision, lineup, parseContestOptions, refundContestQuota, takeContestQuota } from "../src/contest/plan.ts";

describe("lineup", () => {
	it("puts the recipe first when one matches, then model plans", () => {
		expect(lineup({ recipe: true, size: 3, includeAgent: false }).map((c) => c.label)).toEqual(["recipe", "model-a", "model-b"]);
		expect(lineup({ recipe: false, size: 3, includeAgent: false }).map((c) => c.label)).toEqual(["model-a", "model-b", "model-c"]);
	});

	it("keeps a seat for your own agent within the size", () => {
		const two = lineup({ recipe: false, size: 2, includeAgent: true });
		expect(two.map((c) => [c.label, c.kind])).toEqual([["model-a", "model"], ["agent", "agent"]]);
		expect(lineup({ recipe: true, size: 3, includeAgent: true }).map((c) => c.label)).toEqual(["recipe", "model-a", "agent"]);
	});

	it("gives each model plan its own prompt and temperature", () => {
		const models = lineup({ recipe: false, size: 3, includeAgent: false });
		const temps = models.map((c) => c.temperature);
		expect(new Set(temps).size).toBe(3);
		expect(new Set(models.map((c) => c.style)).size).toBe(3);
	});
});

describe("parseContestOptions", () => {
	it("defaults to three contestants and no outside agent", () => {
		expect(parseContestOptions({})).toEqual({ size: 3, includeAgent: false });
	});

	it("accepts 2 or 3 and refuses anything else", () => {
		expect(parseContestOptions({ size: 2, includeAgent: true })).toEqual({ size: 2, includeAgent: true });
		expect(() => parseContestOptions({ size: 4 })).toThrow(/2 or 3/);
		expect(() => parseContestOptions({ size: 1 })).toThrow(/2 or 3/);
		expect(() => parseContestOptions({ size: "3" })).toThrow(/2 or 3/);
		expect(() => parseContestOptions({ includeAgent: "yes" })).toThrow(/true or false/);
	});
});

describe("branches", () => {
	it("names each contestant's branch after the contest and its label", () => {
		expect(contestBranch("1a2b3c4d5e6f", "model-a")).toBe("work/contest-1a2b3c4d5e6f-model-a");
	});

	it("reads the contest id from an inbox branch and its import", () => {
		expect(contestIdOfBranch("work/contest-1a2b3c4d5e6f/mine")).toBe("1a2b3c4d5e6f");
		expect(contestIdOfBranch("work/inbox/contest-1a2b3c4d5e6f/mine")).toBe("1a2b3c4d5e6f");
		expect(contestIdOfBranch("work/inbox/my-change")).toBeNull();
		expect(contestIdOfBranch("work/contest-nothex/x")).toBeNull();
		expect(contestIdOfBranch("work/contest-1a2b3c4d5e6f")).toBeNull();
	});
});

describe("joinDecision", () => {
	const open = { contestId: "1a2b3c4d5e6f", runId: "run_contest_1a2b3c4d5e6f", status: "open", includeAgent: true, joinUntil: "2026-10-06T12:05:00.000Z", agentJoined: false };
	const at = Date.parse("2026-10-06T12:01:00Z");

	it("lets the first push in the window join", () => {
		expect(joinDecision(open, "1a2b3c4d5e6f", at)).toEqual({ ok: true, runId: "run_contest_1a2b3c4d5e6f" });
	});

	it("refuses an unknown contest, a closed window, a contest without a seat, and a second entry", () => {
		expect(joinDecision(null, "1a2b3c4d5e6f", at)).toMatchObject({ ok: false, reason: expect.stringMatching(/no open contest/) });
		expect(joinDecision(open, "ffffffffffff", at)).toMatchObject({ ok: false, reason: expect.stringMatching(/no open contest/) });
		expect(joinDecision(open, "1a2b3c4d5e6f", Date.parse("2026-10-06T12:06:00Z"))).toMatchObject({ ok: false, reason: expect.stringMatching(/window closed/) });
		expect(joinDecision({ ...open, includeAgent: false }, "1a2b3c4d5e6f", at)).toMatchObject({ ok: false, reason: expect.stringMatching(/no seat/) });
		expect(joinDecision({ ...open, agentJoined: true }, "1a2b3c4d5e6f", at)).toMatchObject({ ok: false, reason: expect.stringMatching(/already joined/) });
		expect(joinDecision({ ...open, status: "evaluating" }, "1a2b3c4d5e6f", at)).toMatchObject({ ok: false, reason: expect.stringMatching(/window closed/) });
	});
});

describe("Fleet contest seat", () => {
	const state = { contestId: "1a2b3c4d5e6f", runId: "run_contest_1a2b3c4d5e6f", status: "open" as const, includeAgent: true, joinUntil: "2026-10-06T12:05:00.000Z", agentJoined: false };
	const at = Date.parse("2026-10-06T12:01:00Z");

	it("gives the agent seat once, atomically", () => {
		const { instance: fleet } = construct(Fleet);
		fleet.openContest("user-a", state);
		expect(fleet.joinContest("user-a", "1a2b3c4d5e6f", at)).toEqual({ ok: true, runId: "run_contest_1a2b3c4d5e6f" });
		expect(fleet.joinContest("user-a", "1a2b3c4d5e6f", at)).toMatchObject({ ok: false, reason: expect.stringMatching(/already joined/) });
	});

	it("refuses a join once the contest closed its window", () => {
		const { instance: fleet } = construct(Fleet);
		fleet.openContest("user-a", state);
		fleet.setContestStatus("user-a", "1a2b3c4d5e6f", "evaluating");
		expect(fleet.joinContest("user-a", "1a2b3c4d5e6f", at)).toMatchObject({ ok: false });
		expect(fleet.contestState("user-a")?.status).toBe("evaluating");
	});

	it("treats a retried join of the same entry as success, and a different entry as a second one", () => {
		const { instance: fleet } = construct(Fleet);
		fleet.openContest("user-a", state);
		const entry = { branch: "work/inbox/contest-1a2b3c4d5e6f/mine", commit: "c".repeat(40) };
		expect(fleet.joinContest("user-a", "1a2b3c4d5e6f", at, entry)).toEqual({ ok: true, runId: "run_contest_1a2b3c4d5e6f" });
		fleet.setContestStatus("user-a", "1a2b3c4d5e6f", "evaluating");
		expect(fleet.joinContest("user-a", "1a2b3c4d5e6f", at, entry)).toEqual({ ok: true, runId: "run_contest_1a2b3c4d5e6f" });
		expect(fleet.joinContest("user-a", "1a2b3c4d5e6f", at, { ...entry, commit: "d".repeat(40) })).toMatchObject({ ok: false });
	});

	it("renews the contest lease only for its owner", () => {
		const { instance: fleet } = construct(Fleet);
		const t0 = Date.parse("2026-10-06T12:00:00Z");
		expect(fleet.tryLock("contest-lock:user-a", 1000, "run_a", t0)).toBe(true);
		expect(fleet.renewLock("contest-lock:user-a", 60_000, "run_b", t0 + 500)).toBe(false);
		expect(fleet.renewLock("contest-lock:user-a", 60_000, "run_a", t0 + 500)).toBe(true);
		expect(fleet.tryLock("contest-lock:user-a", 1000, "run_b", t0 + 5000)).toBe(false);
		expect(fleet.renewLock("contest-lock:user-a", 60_000, "run_a", t0 + 120_000)).toBe(false);
	});

	it("never changes another contest's state", () => {
		const { instance: fleet } = construct(Fleet);
		fleet.openContest("user-a", state);
		fleet.setContestStatus("user-a", "ffffffffffff", "done");
		expect(fleet.contestState("user-a")?.status).toBe("open");
	});
});

describe("behaviorFiles", () => {
	it("counts files that change behavior, not intent records or tests", () => {
		expect(behaviorFiles(["app/cards.ts", ".intent/int_1.json", "tests/user/manifest.json", "tests/user/e2e.json", "ui/preferences.json"])).toEqual(["app/cards.ts", "ui/preferences.json"]);
	});
});

describe("entrantOf", () => {
	it("turns a contestant record and its counts into a rule entrant", () => {
		const e = entrantOf({ label: "model-a", status: "evaluated", files: ["app/cards.ts"], readyAt: "t", gate: { passed: false, firstFailure: "invariant: inv-x (mode equals)" } }, { outside: 2, inside: 1, wishPassed: 1, wishTotal: 2, failingWish: ["t-a"] });
		expect(e).toEqual({ label: "model-a", ready: true, problem: null, gatePassed: false, firstFailure: "invariant: inv-x (mode equals)", wishPassed: 1, wishTotal: 2, failingWish: ["t-a"], outsideChanges: 2, filesChanged: 1, finishedAt: "t" });
	});

	it("marks a contestant that produced no change", () => {
		expect(entrantOf({ label: "agent", status: "no entry", error: "no push in the window" }, undefined)).toMatchObject({ ready: false, problem: "no push in the window", wishTotal: 0 });
	});
});

describe("takeContestQuota", () => {
	/** A quota like the Quota object: a refused take counts nothing; give returns one unit. */
	function fakeQuota(limits: Record<string, number> = {}) {
		const used: Record<string, number> = {};
		return {
			used,
			take: async (subject: string, bucket: string, limit: number) => {
				const key = `${subject}/${bucket}`;
				const cap = limits[key] ?? limit;
				if ((used[key] ?? 0) >= cap) return { allowed: false, remaining: 0, retryAfterSeconds: 60 };
				used[key] = (used[key] ?? 0) + 1;
				return { allowed: true, remaining: cap - used[key]!, retryAfterSeconds: 60 };
			},
			give: async (subject: string, bucket: string) => {
				const key = `${subject}/${bucket}`;
				used[key] = Math.max(0, (used[key] ?? 0) - 1);
			},
		};
	}

	it("counts a contest as N customizations and one platform contest", async () => {
		const q = fakeQuota();
		expect(await takeContestQuota(q, "user:u", 3, 10)).toBeNull();
		expect(q.used).toEqual({ "user:u/customize": 3, "global/contest": 1 });
	});

	it("refunds the units it took when a later unit is refused", async () => {
		const q = fakeQuota();
		for (let i = 0; i < 3; i++) expect(await takeContestQuota(q, "user:u", 3, 10)).toBeNull();
		expect(await takeContestQuota(q, "user:u", 3, 10)).toMatch(/counts as 3 customizations/);
		expect(q.used["user:u/customize"]).toBe(9);
		expect(await takeContestQuota(q, "user:u", 2, 10)).toMatch(/counts as 2 customizations/);
		expect(q.used["user:u/customize"]).toBe(9);
	});

	it("refunds the customizations when the platform-wide cap refuses", async () => {
		const q = fakeQuota({ "global/contest": CONTEST_LIMITS.globalPerHour });
		for (let i = 0; i < CONTEST_LIMITS.globalPerHour; i++) expect(await takeContestQuota(q, `user:${i}`, 2, 10)).toBeNull();
		expect(await takeContestQuota(q, "user:x", 2, 10)).toMatch(/contests/);
		expect(q.used["user:x/customize"]).toBe(0);
	});

	it("Quota.give returns one use in the current window, never below zero", () => {
		const { instance: quota } = construct(Quota);
		const at = Date.parse("2026-10-06T12:10:00Z");
		quota.take("customize", 2, 3600, at);
		quota.take("customize", 2, 3600, at);
		expect(quota.take("customize", 2, 3600, at).allowed).toBe(false);
		quota.give("customize", 3600, at);
		expect(quota.take("customize", 2, 3600, at).allowed).toBe(true);
		quota.give("customize", 3600, at);
		quota.give("customize", 3600, at);
		quota.give("customize", 3600, at);
		expect(quota.take("customize", 2, 3600, at).remaining).toBe(1);
	});

	it("gives a whole contest back", async () => {
		const q = fakeQuota();
		await takeContestQuota(q, "user:u", 3, 10);
		await refundContestQuota(q, "user:u", 3);
		expect(q.used).toEqual({ "user:u/customize": 0, "global/contest": 0 });
	});
});


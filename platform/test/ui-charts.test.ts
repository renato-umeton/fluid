import { describe, expect, it } from "vitest";
import type { LedgerEntry, RunTimeRecord } from "../src/durable/user-ledger.ts";
import type { BuildTimeIntent } from "../src/forks/provision.ts";
import type { GateResult } from "../src/gate/tiers.ts";
import { aggregateCharts, intentDate } from "../src/ui/charts.ts";

function entry(at: string, intent: string, confidence: number, extra: Partial<RunTimeRecord> = {}, repo = "user-a"): LedgerEntry {
	const record = { answer_id: `ans_${Math.random()}`, intent, confidence, signals: [], override: null, attestation: null, sources: [], fork_commit: "abc1234", stock_tag: "v1.8.0", ...extra } as RunTimeRecord;
	return { record, repo, at, committed: false };
}

const ledger = [
	entry("2026-10-03T10:00:00Z", "clinical", 0.95, { sources: ["policy:opioid", "fda:label"] }),
	entry("2026-10-03T11:00:00Z", "research", 0.71, { override: "administrative", sources: ["fda:label2", "cdc:guide"] }),
	entry("2026-10-02T09:00:00Z", "multi", 0.5),
	entry("2026-10-02T09:30:00Z", "administrative", 1),
	entry("2026-10-02T09:40:00Z", "clinical", 0.9, {}, "stock"),
];

const intents = [
	{ id: "int_2026_10_01_0001", agent: "onboarding", request: "Provision", files: ["fluid.toml", "x"] },
	{ id: "int_x", agent: "customization-agent", request: "Use Palatino", files: ["ui/preferences.json"], created_at: "2026-10-03T12:00:00Z" },
] as unknown as BuildTimeIntent[];

const gate = (at: string, passed: boolean): GateResult => ({
	repo: "user-a", ref: "work/x", commit: "c".repeat(40), stockTag: "v1.8.0", stockCommit: null, at, passed, failures: [], durationMs: 1,
	tiers: { invariant: { tier: "invariant", passed, total: 22, failed: passed ? 0 : 1, probes: [] }, functional: { tier: "functional", passed: true, total: 11, failed: 0, probes: [] }, user: null },
});

describe("aggregateCharts", () => {
	const data = aggregateCharts({ repo: "user-a", ledger, intents, gates: [gate("2026-10-03T12:01:00Z", true), gate("2026-10-03T11:00:00Z", false)], now: new Date("2026-10-03T13:00:00Z") });

	it("counts only this fork's answers, by intent and day, oldest day first", () => {
		expect(data.answers).toBe(4);
		expect(data.answersByIntent).toEqual([
			{ day: "2026-10-02", clinical: 0, research: 0, administrative: 1, multi: 1 },
			{ day: "2026-10-03", clinical: 1, research: 1, administrative: 0, multi: 0 },
		]);
	});

	it("bins confidence into tenths, with 1.0 in the top bin", () => {
		expect(data.confidence).toHaveLength(10);
		expect(data.confidence[9]).toMatchObject({ clinical: 1, administrative: 1 });
		expect(data.confidence[7]).toMatchObject({ research: 1 });
		expect(data.confidence[5]).toMatchObject({ multi: 1 });
	});

	it("computes the override rate per intent", () => {
		expect(data.overrides.total).toBe(4);
		expect(data.overrides.overridden).toBe(1);
		expect(data.overrides.byIntent.research).toEqual({ total: 1, overridden: 1 });
	});

	it("groups cited sources by the prefix of their id", () => {
		expect(data.sourcesByKind).toEqual([{ kind: "fda", count: 2 }, { kind: "cdc", count: 1 }, { kind: "policy", count: 1 }]);
	});

	it("orders the build-time timeline by date, reading the date from the id when needed", () => {
		expect(data.intentTimeline.map((t) => t.id)).toEqual(["int_2026_10_01_0001", "int_x"]);
		expect(data.intentTimeline[0]!.at).toBe("2026-10-01T00:00:00.000Z");
	});

	it("lists gate results oldest first with passed and total per tier", () => {
		expect(data.gateHistory.map((g) => g.passed)).toEqual([false, true]);
		expect(data.gateHistory[0]!.tiers.invariant).toEqual({ passed: 21, total: 22 });
		expect(data.gateHistory[0]!.tiers.user).toBeUndefined();
	});

	it("folds source kinds past the limit into other", () => {
		const many = [entry("2026-10-03T10:00:00Z", "research", 0.8, { sources: Array.from({ length: 12 }, (_, i) => `k${String(i).padStart(2, "0")}:x`) })];
		const out = aggregateCharts({ repo: "user-a", ledger: many, intents: [], gates: [] });
		expect(out.sourcesByKind).toHaveLength(8);
		expect(out.sourcesByKind[7]).toEqual({ kind: "other", count: 5 });
	});

	it("handles a fork with no data", () => {
		const out = aggregateCharts({ repo: "user-a", ledger: [], intents: [], gates: [] });
		expect(out.answers).toBe(0);
		expect(out.answersByIntent).toEqual([]);
		expect(out.sourcesByKind).toEqual([]);
	});
});

describe("aggregateCharts counts one answer per question", () => {
	// Ledger order is newest first, as UserLedger.list returns it.
	const q = (id: string, at: string, intent: string, extra: Partial<RunTimeRecord> = {}) => entry(at, intent, 0.9, { answer_id: id, ...extra });
	const session = [
		q("a5", "2026-10-03T10:05:00Z", "research", { override: "research", attestation: true, reask_of: "a4", sources: ["fda:label"] }),
		q("a4", "2026-10-03T10:04:00Z", "research", { attestation: false }),
		q("a3", "2026-10-03T10:03:00Z", "administrative", { override: "administrative", reask_of: "a2" }),
		q("a2", "2026-10-03T10:02:00Z", "clinical", { override: "administrative" }),
		q("a1", "2026-10-03T10:01:00Z", "clinical"),
		q("a0", "2026-10-03T10:00:00Z", "administrative"),
	];
	const data = aggregateCharts({ repo: "user-a", ledger: session, intents: [], gates: [] });

	it("folds an override re-ask and an attestation re-ask into their questions", () => {
		expect(data.answers).toBe(4);
	});

	it("counts an overridden question once, and an attestation re-ask not at all", () => {
		expect({ total: data.overrides.total, overridden: data.overrides.overridden }).toEqual({ total: 4, overridden: 1 });
	});

	it("charts each question under the intent it was first answered with", () => {
		expect(data.answersByIntent).toEqual([{ day: "2026-10-03", clinical: 2, research: 1, administrative: 1, multi: 0 }]);
	});

	it("keeps the sources cited by a re-ask", () => {
		expect(data.sourcesByKind).toEqual([{ kind: "fda", count: 1 }]);
	});

	it("still counts a re-ask whose first answer has aged out of the window", () => {
		const out = aggregateCharts({ repo: "user-a", ledger: [q("b2", "2026-10-03T11:00:00Z", "research", { override: "research", reask_of: "gone" })], intents: [], gates: [] });
		expect({ answers: out.answers, overridden: out.overrides.overridden }).toEqual({ answers: 1, overridden: 0 });
	});
});

describe("intentDate", () => {
	it("returns null when nothing names a date", () => {
		expect(intentDate({ id: "custom" } as BuildTimeIntent)).toBeNull();
	});
});

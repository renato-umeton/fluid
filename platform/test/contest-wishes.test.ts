import { describe, expect, it } from "vitest";
import { Fleet } from "../src/durable/fleet.ts";
import { Runs } from "../src/durable/runs.ts";
import { listWishes, upsertWishNote, WISH_LIMITS, type WishNote } from "../src/contest/wishes.ts";
import { construct } from "./helpers/durable.ts";

const AT = Date.parse("2026-10-06T12:00:00Z");
const note = (over: Partial<WishNote> = {}): WishNote => ({ id: "run_customize_1", runId: "run_customize_1", kind: "customize", branch: "work/raise-tau-1a2b", intentId: "int_1", request: "Raise my threshold to 0.9", status: "planned", at: new Date(AT).toISOString(), ...over });

describe("upsertWishNote", () => {
	it("replaces a note with the same id and keeps the newest first", () => {
		let list: WishNote[] = [];
		list = upsertWishNote(list, note(), AT);
		list = upsertWishNote(list, note({ id: "run_b", runId: "run_b" }), AT);
		list = upsertWishNote(list, note({ status: "gating" }), AT);
		expect(list.map((n) => [n.id, n.status])).toEqual([["run_customize_1", "gating"], ["run_b", "planned"]]);
	});

	it("drops notes older than the window and keeps at most the cap", () => {
		const old = note({ id: "old", at: new Date(AT - WISH_LIMITS.maxAgeMs - 1).toISOString() });
		let list = upsertWishNote([old], note(), AT);
		expect(list.map((n) => n.id)).toEqual(["run_customize_1"]);
		for (let i = 0; i < WISH_LIMITS.maxNotes + 5; i++) list = upsertWishNote(list, note({ id: `n${i}` }), AT);
		expect(list).toHaveLength(WISH_LIMITS.maxNotes);
	});

	it("clips free text", () => {
		const [n] = upsertWishNote([], note({ request: "x".repeat(2000), note: "y".repeat(2000) }), AT);
		expect(n!.request.length).toBeLessThanOrEqual(500);
		expect(n!.note!.length).toBeLessThanOrEqual(300);
	});
});

describe("listWishes", () => {
	const record = { id: "int_1", author: "user:u", agent: "customization-agent", request: "Raise my threshold to 0.9", purpose: "p", modes_affected: [], files: ["fluid.toml"], tests_added: [], stock_tag: "v1.0.0" };

	it("joins work branches, their records, notes, and gate results", () => {
		const wishes = listWishes({
			branches: [
				{ branch: "work/raise-tau-1a2b", head: "a".repeat(40), records: [record] },
				{ branch: "work/inbox/my-change", head: "b".repeat(40), records: [] },
			],
			notes: [note({ status: "waiting for your test decisions" }), note({ id: "run_c", runId: "run_c", branch: null, intentId: null, request: "Add a summary", status: "planning" })],
			gates: [{ ref: "work/inbox/my-change", commit: "b".repeat(40), passed: false, at: "2026-10-06T11:00:00Z" }],
		});
		expect(wishes).toEqual([
			{ branch: "work/raise-tau-1a2b", head: "a".repeat(40), intentId: "int_1", request: "Raise my threshold to 0.9", purpose: "p", agent: "customization-agent", files: ["fluid.toml"], status: "waiting for your test decisions", runId: "run_customize_1", kind: "customize", contest: null, gate: null },
			{ branch: "work/inbox/my-change", head: "b".repeat(40), intentId: null, request: null, purpose: null, agent: null, files: [], status: "gate failed", runId: null, kind: "branch", contest: null, gate: { passed: false, commit: "b".repeat(40), at: "2026-10-06T11:00:00Z" } },
			{ branch: null, head: null, intentId: null, request: "Add a summary", purpose: null, agent: null, files: [], status: "planning", runId: "run_c", kind: "customize", contest: null, gate: null },
		]);
	});

	it("shows a run whose branch is not pushed yet, and leaves out finished runs", () => {
		const wishes = listWishes({ branches: [], notes: [note({ status: "waiting for your test decisions" }), note({ id: "done", branch: "work/gone", final: true, status: "merged" })], gates: [] });
		expect(wishes.map((w) => [w.branch, w.head, w.status])).toEqual([["work/raise-tau-1a2b", null, "waiting for your test decisions"]]);
	});

	it("says a branch is open when nothing gated its head yet", () => {
		const [w] = listWishes({ branches: [{ branch: "work/x", head: "c".repeat(40), records: [] }], notes: [], gates: [{ ref: "work/x", commit: "d".repeat(40), passed: true, at: "t" }] });
		expect(w!.status).toBe("open");
	});
});

describe("Fleet wish notes", () => {
	it("upserts notes per fork in one call", () => {
		const { instance: fleet } = construct(Fleet);
		fleet.noteWish("user-a", note(), AT);
		fleet.noteWish("user-a", note({ status: "gating" }), AT);
		fleet.noteWish("user-b", note({ id: "other" }), AT);
		expect(fleet.wishNotes("user-a").map((n) => n.status)).toEqual(["gating"]);
		expect(fleet.wishNotes("user-b").map((n) => n.id)).toEqual(["other"]);
	});
});

describe("Runs.updateEntry", () => {
	it("merges a patch into one list entry without touching the others", () => {
		const { instance: runs } = construct(Runs);
		runs.create({ id: "run_contest_x", kind: "contest", fields: { contestants: [{ label: "model-a", status: "planning" }, { label: "model-b", status: "planning" }] } });
		runs.updateEntry("contestants", "label", "model-b", { status: "ready", branch: "work/contest-x-model-b" });
		expect(runs.get()!.contestants).toEqual([{ label: "model-a", status: "planning" }, { label: "model-b", status: "ready", branch: "work/contest-x-model-b" }]);
	});

	it("appends an entry that is not there yet", () => {
		const { instance: runs } = construct(Runs);
		runs.create({ id: "run_contest_y", kind: "contest", fields: { contestants: [] } });
		runs.updateEntry("contestants", "label", "agent", { status: "joined" });
		expect(runs.get()!.contestants).toEqual([{ label: "agent", status: "joined" }]);
	});
});

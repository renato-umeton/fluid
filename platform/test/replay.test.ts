// Intent replay: rebuild a fork from fresh stock by running each recorded
// wish again in commit order, instead of merging old text.
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import synthetic from "../src/generated/synthetic.json";
import { protocolsFor, tauChange } from "../src/agents/recipes.ts";
import { isWish, orderIntents, planReplay, replayBase, replayIntents, replayOf, replaySummary, type ReplaySpec } from "../src/agents/replay.ts";
import { uiChange } from "../src/agents/ui-recipe.ts";
import { seedChange } from "../src/fleet/seed-catalog.ts";
import { onboardingToml, type BuildTimeIntent } from "../src/forks/provision.ts";
import { checkoutBranch, commitChanges, initRepo, mergeInto, writeFiles } from "../src/git/ops.ts";
import { summarizeTier, type RunnerManifestResult } from "../src/gate/tiers.ts";
import { parseToml } from "../src/lib/toml.ts";
import { APP_MODULE, ENTRY_MODULE, RUNNER_ENTRY_MODULE, buildModuleMap, buildRunnerModuleMap } from "../src/runtime/modules.ts";
import { demoReleaseFiles } from "../src/stock/releases.ts";
import { materialize } from "./helpers/materialize.ts";

const stock = stockSource.files as Record<string, string>;
const protocols = protocolsFor(synthetic.personas, "research-coordinator");
const seedCtx = { personas: synthetic.personas, persona: "hospitalist-researcher" };
const plainWording = seedChange("plain-wording", stock, seedCtx);
const FORK_LINE = plainWording.replay!.kind === "framing" ? plainWording.replay!.params.line : "";

let n = 0;
function wish(replay?: ReplaySpec | Record<string, unknown>, extra: Partial<BuildTimeIntent> = {}): BuildTimeIntent {
	n += 1;
	return {
		id: `int_test_${String(n).padStart(4, "0")}`,
		author: "user:u",
		agent: "customization-agent",
		request: `wish ${n}`,
		purpose: `purpose ${n}`,
		modes_affected: [],
		files: [],
		tests_added: [],
		stock_tag: "v1.0.0",
		created_at: `2026-10-0${Math.min(9, n)}T00:00:00.000Z`,
		...(replay ? { replay } : {}),
		...extra,
	};
}

const tau = (value: number): ReplaySpec => ({ kind: "tau", params: { value } });
const ui = (params: Record<string, unknown>) => ({ kind: "ui", params }) as ReplaySpec;
const redcap: ReplaySpec = { kind: "redcap", params: { protocols } };
const framing: ReplaySpec = { kind: "framing", params: { line: FORK_LINE } };
const tauOf = (files: Record<string, string>) => (parseToml(files["fluid.toml"]!).thresholds as Record<string, unknown>).tau;
const prefsOf = (files: Record<string, string>) => JSON.parse(files["ui/preferences.json"]!);

describe("replayOf", () => {
	it("reads each replayable kind", () => {
		expect(replayOf(wish(tau(0.9)))).toEqual(tau(0.9));
		expect(replayOf(wish(redcap))).toEqual(redcap);
		expect(replayOf(wish(framing))).toEqual(framing);
		expect(replayOf(wish(ui({ look: "crimson" })))).toEqual(ui({ look: "crimson" }));
	});

	it("reads a model record as not replayable and a record without the field as none", () => {
		expect(replayOf(wish({ kind: "model", request: "make it friendlier" }))).toEqual({ kind: "model", request: "make it friendlier" });
		expect(replayOf(wish())).toBeNull();
	});

	it.each([
		["tau that is not a number", { kind: "tau", params: { value: "0.9" } }],
		["tau out of range", { kind: "tau", params: { value: 2 } }],
		["a framing line with a newline", { kind: "framing", params: { line: "a\nb" } }],
		["protocols that are not plain ids", { kind: "redcap", params: { protocols: ["IRB\"; evil"] } }],
		["ui with an unknown key", { kind: "ui", params: { logo: "x" } }],
		["an unknown kind", { kind: "shell", params: {} }],
	])("treats %s as no replay", (_label, replay) => {
		expect(replayOf(wish(replay))).toBeNull();
	});
});

describe("isWish", () => {
	it("counts customizations and seeded customizations, not platform records", () => {
		expect(isWish(wish(tau(0.9)))).toBe(true);
		expect(isWish(wish(tau(0.9), { agent: "seed-customization" }))).toBe(true);
		for (const agent of ["onboarding", "merge-agent", "repair-agent", "yellow-rollback", "replay-agent", null]) expect(isWish(wish(undefined, { agent }))).toBe(false);
	});
});

describe("replayIntents", () => {
	it("runs every replayable wish on fresh stock and skips platform records", () => {
		const intents = [wish(undefined, { agent: "onboarding" }), wish(tau(0.9)), wish(ui({ look: "crimson", font: "palatino" })), wish(redcap), wish(framing)];
		const out = replayIntents(stock, intents);
		expect(out.results.map((r) => [r.intentId, r.status])).toEqual(intents.slice(1).map((i) => [i.id, "replayed"]));
		expect(tauOf(out.files)).toBe(0.9);
		expect(prefsOf(out.files)).toEqual({ look: "crimson", font: "palatino" });
		expect(out.files["connectors/redcap.ts"]).toContain(protocols[0]);
		expect(out.files["app/index.ts"]).toContain("withEnrollment(card, request, env.data)");
		expect(out.files["app/cards.ts"]!.split("\n")).toContain(FORK_LINE);
		expect(out.results.map((r) => r.changed)).toEqual([["fluid.toml"], ["ui/preferences.json"], ["app/index.ts", "connectors/redcap.ts"], ["app/cards.ts"]]);
		expect(out.steps.map((s) => Object.keys(s.files).sort())).toEqual(out.results.map((r) => r.changed));
		expect(stock["fluid.toml"]).not.toContain("0.9");
	});

	it("runs wishes in the order given, so a later wish wins", () => {
		const blue = wish(ui({ accent: "blue" }));
		const rose = wish(ui({ accent: "rose" }));
		expect(prefsOf(replayIntents(stock, [blue, rose]).files).accent).toBe("rose");
		expect(prefsOf(replayIntents(stock, [rose, blue]).files).accent).toBe("blue");
		expect(tauOf(replayIntents(stock, [wish(tau(0.9)), wish(tau(0.95))]).files)).toBe(0.95);
	});

	it("marks model changes and records without a replay as fallback, and keeps going", () => {
		const model = wish({ kind: "model", request: "budget variance" });
		const old = wish();
		const out = replayIntents(stock, [model, old, wish(tau(0.9))]);
		expect(out.results.map((r) => r.status)).toEqual(["fallback", "fallback", "replayed"]);
		expect(out.results[0]!.reason).toMatch(/model/);
		expect(out.results[1]!.reason).toMatch(/no replay/);
		expect(tauOf(out.files)).toBe(0.9);
	});

	it("marks a wish that no longer applies as failed, with the reason", () => {
		const noAnchor = { ...stock, "app/index.ts": stock["app/index.ts"]!.replace("return buildCard(", "return renderCard(") };
		const noLine = { ...stock, "app/cards.ts": stock["app/cards.ts"]!.replace("is below the threshold ${decision.tau}; ", "is under ${decision.tau}: ") };
		const r1 = replayIntents(noAnchor, [wish(redcap)]).results[0]!;
		const r2 = replayIntents(noLine, [wish(framing)]).results[0]!;
		expect([r1.status, r2.status]).toEqual(["failed", "failed"]);
		expect(r1.reason).toContain("buildCard");
		expect(r2.reason).toContain("framing line");
	});

	it("counts a wish that is already true on the new base as replayed with nothing to change", () => {
		const out = replayIntents(stock, [wish(ui({ look: "crimson" })), wish(ui({ look: "crimson" }))]);
		expect(out.results.map((r) => r.status)).toEqual(["replayed", "replayed"]);
		expect(out.results[1]!.changed).toEqual([]);
		expect(out.results[1]!.reason).toMatch(/already/);
	});

	it("fails a ui wish that would make a fifth tab", () => {
		const tabs = [1, 2, 3, 4, 5].map((i) => wish(ui({ tab: { title: `Tab ${i}`, widgets: ["override-rate"] } })));
		expect(replayIntents(stock, tabs).results.map((r) => r.status)).toEqual(["replayed", "replayed", "replayed", "replayed", "failed"]);
	});
});

describe("the demo release's wording conflict", () => {
	const next = demoReleaseFiles(stock, "v1.1.0").files;

	it("conflicts under a git merge", async () => {
		const ws = await initRepo();
		await writeFiles(ws, { "app/cards.ts": stock["app/cards.ts"]! });
		await commitChanges(ws, { message: "stock v1.0.0" });
		await checkoutBranch(ws, "stock", { create: true });
		await writeFiles(ws, { "app/cards.ts": next["app/cards.ts"]! });
		await commitChanges(ws, { message: "stock v1.1.0" });
		await checkoutBranch(ws, "main");
		await writeFiles(ws, plainWording.files);
		await commitChanges(ws, { message: "plain wording" });
		const merged = await mergeInto(ws, { ours: "main", theirs: "stock" });
		expect(merged.ok).toBe(false);
		expect(!merged.ok && merged.conflicts.filepaths).toEqual(["app/cards.ts"]);
	});

	it("replays cleanly: the fork's wording on the new stock, every other stock change kept", () => {
		const out = replayIntents(next, [wish(framing, { agent: "seed-customization" })]);
		expect(out.results[0]!.status).toBe("replayed");
		const lines = out.files["app/cards.ts"]!.split("\n");
		const stockLines = next["app/cards.ts"]!.split("\n");
		const changed = lines.flatMap((l, i) => (l === stockLines[i] ? [] : [i]));
		expect(changed).toHaveLength(1);
		expect(lines[changed[0]!]).toBe(FORK_LINE);
		expect(out.files["tests/invariants/manifest.json"]).toBe(next["tests/invariants/manifest.json"]);
	});
});

describe("replayBase", () => {
	it("starts from stock and carries the fork's settings, records, and own tests", () => {
		const main = {
			...stock,
			"fluid.toml": onboardingToml(stock["fluid.toml"]!, { stockTag: "v1.0.0", persona: "research-coordinator", preferences: { auto_upgrade: true, harvest_opt_in: true } }),
			".intent/int_mine.json": "{}\n",
			".repair/abc1234.md": "note\n",
			"tests/user/manifest.json": '{"tier":"user","probes":[]}\n',
			"app/body.ts": "// fork edit\n",
		};
		const next = { ...demoReleaseFiles(stock, "v1.1.0").files, ".intent/int_release.json": "{}\n" };
		const base = replayBase(next, main, "v1.1.0");
		const toml = parseToml(base["fluid.toml"]!);
		expect(toml.stock_tag).toBe("v1.1.0");
		expect(toml.preferences).toEqual({ auto_upgrade: true, harvest_opt_in: true, persona: "research-coordinator" });
		expect(base[".intent/int_mine.json"]).toBe("{}\n");
		expect(base[".intent/int_release.json"]).toBe("{}\n");
		expect(base[".repair/abc1234.md"]).toBe("note\n");
		expect(base["tests/user/manifest.json"]).toBe(main["tests/user/manifest.json"]);
		expect(base["app/body.ts"]).toBe(next["app/body.ts"]);
		expect(base["app/cards.ts"]).toBe(next["app/cards.ts"]);
	});
});

describe("orderIntents", () => {
	it("follows commit order, then puts records with no commit after them by date", () => {
		const a = wish(tau(0.9), { created_at: "2026-10-05T00:00:00Z" });
		const b = wish(tau(0.95), { created_at: "2026-10-01T00:00:00Z" });
		const c = wish(tau(0.92), { created_at: "2026-10-03T00:00:00Z" });
		const d = wish(tau(0.93), { created_at: "2026-10-02T00:00:00Z" });
		expect(orderIntents([a, b, c, d], [c.id, a.id]).map((i) => i.id)).toEqual([c.id, a.id, b.id, d.id]);
	});
});

/** A fork's main: onboarding on stock at `tag`, then each change in order, with its intent record. */
type Change = { files: Record<string, string>; replay?: ReplaySpec };
function forkMain(base: Record<string, string>, tag: string, changes: ((files: Record<string, string>) => Change)[]) {
	let files = { ...base, "fluid.toml": onboardingToml(base["fluid.toml"]!, { stockTag: tag, persona: "hospitalist-researcher", preferences: { auto_upgrade: true, harvest_opt_in: true } }) };
	const intents: BuildTimeIntent[] = [wish(undefined, { agent: "onboarding" })];
	for (const make of changes) {
		const change = make(files);
		const record = wish(change.replay, { agent: "seed-customization" });
		intents.push(record);
		files = { ...files, ...change.files, [`.intent/${record.id}.json`]: `${JSON.stringify(record)}\n` };
	}
	files["tests/user/manifest.json"] = `${JSON.stringify({ tier: "user", samples: 1, probes: [] })}\n`;
	return { files, intents };
}

describe("planReplay", () => {
	const next = demoReleaseFiles(stock, "v1.1.0").files;

	function build() {
		return forkMain(stock, "v1.0.0", [(f) => seedChange("plain-wording", f, seedCtx), (f) => tauChange(f["fluid.toml"]!, { kind: "tau", value: 0.9, direction: "set" })]);
	}

	it("replays a fork whose wishes are all replayable and rebuild main exactly", () => {
		const { files: main, intents } = build();
		const plan = planReplay({ tag: "v1.1.0", fromTag: "v1.0.0", stockAtTag: next, stockAtFrom: stock, mainFiles: main, intents });
		expect(plan.mode).toBe("replay");
		if (plan.mode !== "replay") return;
		expect(plan.results.map((r) => r.status)).toEqual(["replayed", "replayed"]);
		expect(plan.files["app/cards.ts"]!.split("\n")).toContain(FORK_LINE);
		expect(tauOf(plan.files)).toBe(0.9);
		expect(parseToml(plan.files["fluid.toml"]!).stock_tag).toBe("v1.1.0");
		expect((parseToml(plan.files["fluid.toml"]!).preferences as Record<string, unknown>).harvest_opt_in).toBe(true);
		expect(plan.files["tests/invariants/manifest.json"]).toBe(next["tests/invariants/manifest.json"]);
		for (const i of intents) expect(plan.files[`.intent/${i.id}.json`] ?? null).toBe(main[`.intent/${i.id}.json`] ?? null);
		expect(plan.files["tests/user/manifest.json"]).toBe(main["tests/user/manifest.json"]);
		expect(plan.base["app/cards.ts"]).toBe(next["app/cards.ts"]);
	});

	it("merges when a wish was written by the model", () => {
		const { files: main, intents } = forkMain(stock, "v1.0.0", [(f) => seedChange("budget-summary", f, seedCtx)]);
		const plan = planReplay({ tag: "v1.1.0", fromTag: "v1.0.0", stockAtTag: next, stockAtFrom: stock, mainFiles: main, intents });
		expect(plan.mode).toBe("merge");
		expect(plan.reason).toMatch(/0 of 1 wishes can be replayed/);
		expect(plan.results.map((r) => r.status)).toEqual(["fallback"]);
	});

	it("merges when main has a change no wish explains", () => {
		const { files, intents } = build();
		const main = { ...files, "app/body.ts": `${files["app/body.ts"]}// hand edit\n` };
		const plan = planReplay({ tag: "v1.1.0", fromTag: "v1.0.0", stockAtTag: next, stockAtFrom: stock, mainFiles: main, intents });
		expect(plan.mode).toBe("merge");
		expect(plan.reason).toContain("app/body.ts");
	});

	it("merges when a wish no longer applies at the new tag", () => {
		const { files: main, intents } = build();
		const moved = { ...next, "app/cards.ts": next["app/cards.ts"]!.replace(/^.*is below the threshold \$\{decision\.tau\}; .*$/m, "      : `Low confidence.`,") };
		const plan = planReplay({ tag: "v1.1.0", fromTag: "v1.0.0", stockAtTag: moved, stockAtFrom: stock, mainFiles: main, intents });
		expect(plan.mode).toBe("merge");
		expect(plan.results.map((r) => r.status)).toEqual(["failed", "replayed"]);
		expect(plan.reason).toMatch(/no longer applies/);
	});

	it("merges a fork with no wishes: there is nothing to carry", () => {
		const { files: main, intents } = forkMain(stock, "v1.0.0", []);
		const plan = planReplay({ tag: "v1.1.0", fromTag: "v1.0.0", stockAtTag: next, stockAtFrom: stock, mainFiles: main, intents });
		expect(plan).toEqual(expect.objectContaining({ mode: "merge", results: [] }));
	});

	it("rebuilds main exactly with a ui wish and a REDCap wish", () => {
		const { files: main, intents } = forkMain(stock, "v1.0.0", [(f) => uiChange(f["ui/preferences.json"] ?? null, "use the crimson look"), (f) => seedChange("redcap", f, { personas: synthetic.personas, persona: "research-coordinator" })]);
		const plan = planReplay({ tag: "v1.1.0", fromTag: "v1.0.0", stockAtTag: next, stockAtFrom: stock, mainFiles: main, intents });
		expect(plan.mode).toBe("replay");
	});
});

describe("replaySummary", () => {
	it("counts the wishes carried to the tag", () => {
		const results = replayIntents(stock, [wish(tau(0.9)), wish({ kind: "model", request: "x" })]).results;
		expect(replaySummary("v1.1.0", "replay", results)).toEqual(expect.objectContaining({ tag: "v1.1.0", path: "replay", carried: 1, total: 2 }));
		expect(replaySummary("v1.1.0", "replay", results).wishes[1]).toEqual(expect.objectContaining({ status: "fallback", kind: "model" }));
	});
});

describe("a replayed fork through the stock gate at the new tag", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const dirs: string[] = [];
	type Runner = { runManifest(options: Record<string, unknown>): Promise<RunnerManifestResult> };
	let runner: Runner;
	const next = demoReleaseFiles(stock, "v1.1.0").files;
	beforeAll(async () => {
		const dir = join(here, ".tmp-replay-runner");
		dirs.push(dir);
		runner = await materialize<Runner>(buildRunnerModuleMap(next), dir, "tests/runner.js", [RUNNER_ENTRY_MODULE]);
	});
	afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

	it("passes tiers 1 and 2 with the fork's wording, raised tau, and REDCap", async () => {
		const wishes = [wish(framing), wish(tau(0.9)), wish(redcap)];
		const { files } = replayIntents(next, wishes);
		const dir = join(here, ".tmp-replay-fork");
		dirs.push(dir);
		const mod = await materialize<{ default: { ask(req: unknown, env: unknown): Promise<Record<string, unknown>> } }>(buildModuleMap(files), dir, APP_MODULE, [ENTRY_MODULE]);
		const app = { ask: (req: unknown) => mod.default.ask(req, { data: synthetic, fluidToml: files["fluid.toml"] }) };
		const run = (manifest: unknown) => runner.runManifest({ app, manifest, forkFiles: { "fluid.toml": files["fluid.toml"] }, env: {}, samples: 1 });
		const inv = summarizeTier("invariant", await run(JSON.parse(next["tests/invariants/manifest.json"]!)));
		const fn = summarizeTier("functional", await run(JSON.parse(next["tests/functional/manifest.json"]!)));
		expect(inv.failures).toEqual([]);
		expect(fn.failures).toEqual([]);
	});
});

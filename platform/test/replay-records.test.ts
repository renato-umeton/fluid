// The replay field on intent records: recipe changes say how to run them
// again (intent replay), model changes say they cannot be replayed.
import { describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import synthetic from "../src/generated/synthetic.json";
import { protocolsFor, redcapChange, replanOnMovedMain, tauChange } from "../src/agents/recipes.ts";
import { replayRecordFor } from "../src/agents/replay.ts";
import { uiChange } from "../src/agents/ui-recipe.ts";
import { seedChange } from "../src/fleet/seed-catalog.ts";

const files = stockSource.files as Record<string, string>;
const protocols = protocolsFor(synthetic.personas, "research-coordinator");

describe("replay field on planned changes", () => {
	it("tau records the value it wrote, not the words of the request", () => {
		expect(tauChange(files["fluid.toml"]!, { kind: "tau", value: Number.NaN, direction: "raise" }).replay).toEqual({ kind: "tau", params: { value: 0.9 } });
		expect(tauChange(files["fluid.toml"]!, { kind: "tau", value: 0.95, direction: "set" }).replay).toEqual({ kind: "tau", params: { value: 0.95 } });
	});

	it("REDCap records the protocols its connector serves", () => {
		expect(redcapChange({ indexSource: files["app/index.ts"]!, protocols }).replay).toEqual({ kind: "redcap", params: { protocols } });
	});

	it("ui records the mapped preferences, not the request text", () => {
		const change = uiChange(null, "Use the crimson look and add a tab called Trends with charts of overrides");
		expect(change.replay).toEqual({ kind: "ui", params: { look: "crimson", tab: { title: "Trends", widgets: ["override-rate"] } } });
	});

	it("seeded wording records the framing line it writes", () => {
		const change = seedChange("plain-wording", files, { personas: synthetic.personas, persona: "hospitalist-researcher" });
		expect(change.replay).toEqual({ kind: "framing", params: { line: change.files["app/cards.ts"]!.split("\n").find((l) => l.includes("Not sure which role you are in"))! } });
	});

	it("seeded tau and REDCap are replayable; seeded code changes are not", () => {
		const ctx = { personas: synthetic.personas, persona: "research-coordinator" };
		expect(seedChange("raise-tau", files, ctx).replay).toEqual({ kind: "tau", params: { value: 0.9 } });
		expect(seedChange("redcap", files, ctx).replay?.kind).toBe("redcap");
		expect(seedChange("budget-summary", files, ctx).replay).toBeUndefined();
		expect(seedChange("compact-research", files, ctx).replay).toBeUndefined();
	});

	it("the record for a model plan keeps the request and is not replayable; the admin test recipe gets none", () => {
		expect(replayRecordFor({ recipe: "model" }, "Make the\nmulti-intent message friendlier")).toEqual({ kind: "model", request: "Make the multi-intent message friendlier" });
		expect(replayRecordFor({ recipe: "admin-test" }, "[admin test] break ledger fork_commit")).toBeNull();
		const tau = tauChange(files["fluid.toml"]!, { kind: "tau", value: 0.9, direction: "set" });
		expect(replayRecordFor(tau, "set tau to 0.9")).toEqual(tau.replay);
	});

	it("a recipe applied again on a moved main records the replay of the new plan", () => {
		const change = tauChange(files["fluid.toml"]!, { kind: "tau", value: Number.NaN, direction: "raise" });
		const moved = files["fluid.toml"]!.replace("tau = 0.85", "tau = 0.9");
		const out = replanOnMovedMain({ change, request: "raise my threshold", before: files, current: { "fluid.toml": moved }, protocols });
		expect(out).toEqual(expect.objectContaining({ replay: { kind: "tau", params: { value: 0.95 } } }));
	});
});

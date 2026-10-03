import { describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import { onboardingToml, preferencesOf } from "../src/forks/provision.ts";
import { parseToml } from "../src/lib/toml.ts";

const stockToml = (stockSource.files as Record<string, string>)["fluid.toml"]!;
const prefs = (toml: string) => parseToml(toml).preferences as Record<string, unknown>;

describe("harvest is opt-in", () => {
	it("reads a missing harvest_opt_in as false", () => {
		expect(preferencesOf({}).harvest_opt_in).toBe(false);
		expect(preferencesOf({ preferences: { auto_upgrade: true } }).harvest_opt_in).toBe(false);
		expect(preferencesOf({ preferences: { harvest_opt_in: true } }).harvest_opt_in).toBe(true);
	});

	it("writes harvest_opt_in = false into a new fork unless the user opts in", () => {
		const optedInStock = stockToml.replace(/harvest_opt_in = \w+/, "harvest_opt_in = true");
		expect(prefs(onboardingToml(optedInStock, { stockTag: "v1.1.0", persona: "p" })).harvest_opt_in).toBe(false);
		expect(prefs(onboardingToml(stockToml, { stockTag: "v1.1.0", persona: "p", preferences: { harvest_opt_in: true } })).harvest_opt_in).toBe(true);
	});

	it("writes auto_upgrade explicitly too", () => {
		expect(prefs(onboardingToml(stockToml, { stockTag: "v1.1.0", persona: "p" })).auto_upgrade).toBe(false);
	});
});

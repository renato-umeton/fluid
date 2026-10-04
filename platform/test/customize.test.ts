import { describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import { checkModelFiles, planPrompt, validateCandidate } from "../src/workflows/customize.ts";

const files = stockSource.files as Record<string, string>;
const noEnv = undefined as unknown as Env;
const noExports = undefined as unknown as Parameters<typeof validateCandidate>[1];

describe("checkModelFiles", () => {
	it("accepts a valid ui/preferences.json from the model", () => {
		expect(checkModelFiles([{ path: "ui/preferences.json", content: '{"font":"palatino"}' }])).toBeNull();
	});

	it("rejects invalid UI preferences with the schema error", () => {
		expect(checkModelFiles([{ path: "ui/preferences.json", content: '{"css":"body{}"}' }])).toContain('unknown key "css"');
	});

	it("rejects other files outside the runtime directories", () => {
		expect(checkModelFiles([{ path: "ui/theme.css", content: "x" }])).toContain("outside app/");
	});
});

describe("validateCandidate", () => {
	it("stops the live failure statically, before any isolate is loaded", async () => {
		const change = { "app/cards.ts": 'import { buildCard as base } from "./cards.base.js";\nexport async function buildCard(i: unknown) { return base(i as never); }\n' };
		await expect(validateCandidate(noEnv, noExports, "user-x", "sha", change, files)).rejects.toThrow(/imports do not resolve: app\/cards.ts imports "\.\/cards\.base\.js"/);
	});

	it("validates a UI-only change without loading the fork", async () => {
		await expect(validateCandidate(noEnv, noExports, "user-x", "sha", { "ui/preferences.json": '{"font":"palatino"}' }, files)).resolves.toBeUndefined();
		await expect(validateCandidate(noEnv, noExports, "user-x", "sha", { "ui/preferences.json": '{"font":"wingdings"}' }, files)).rejects.toThrow(/font must be one of/);
	});

	it("reports a transform error with the file name", async () => {
		await expect(validateCandidate(noEnv, noExports, "user-x", "sha", { "app/x.ts": "export const = ;" }, files)).rejects.toThrow(/app\/x.ts/);
	});
});

describe("planPrompt", () => {
	const prompt = planPrompt("Use Palatino and add a chart tab", files, 'imports do not resolve: app/cards.ts imports "./cards.base.js"');

	it("sends the exact previous error back", () => {
		expect(prompt).toContain('Your previous attempt failed with this exact error. Fix it:\nimports do not resolve: app/cards.ts imports "./cards.base.js"');
	});

	it("routes look and layout to ui/preferences.json and keeps the card contract", () => {
		expect(prompt).toContain("never done in answer card code");
		expect(prompt).toContain("must stay the stock contract");
		expect(prompt).toContain("ui/preferences.json");
	});

	it("tells the model that imports must resolve", () => {
		expect(prompt).toContain("every relative import must name a file listed below or a file you write in this same change");
	});
});

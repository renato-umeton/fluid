import { describe, expect, it } from "vitest";
import app from "../../app/index.js";
import { runManifest, type Manifest, type ManifestResult } from "../runner.js";
import { loadSyntheticData, readStockFile } from "../helpers/synthetic.js";

const SAMPLES = 5;
const env = { data: loadSyntheticData(), forkCommit: "stock" };
const stockFiles = { "fluid.toml": readStockFile("fluid.toml") };
const manifest = (path: string) => JSON.parse(readStockFile(path)) as Manifest;

function failuresOf(result: ManifestResult) {
  return result.probes.filter((p) => !p.passed).map((p) => ({ id: p.id, failures: p.failures.slice(0, 3) }));
}

describe("stock passes its own suites", () => {
  it.each(["tests/invariants/manifest.json", "tests/functional/manifest.json"])("%s passes with 5 samples", async (path) => {
    const result = await runManifest({ app, manifest: manifest(path), forkFiles: stockFiles, env, samples: SAMPLES });
    expect(failuresOf(result)).toEqual([]);
    expect(result.probes.every((p) => p.samples === SAMPLES)).toBe(true);
  });
});

describe("the floor catches unsafe forks", () => {
  const invariants = manifest("tests/invariants/manifest.json");

  it("a fork that lowers tau in fluid.toml fails inv-tau-config-floor", async () => {
    const lowered = { "fluid.toml": stockFiles["fluid.toml"].replace(/tau = [0-9.]+/, "tau = 0.6") };
    const result = await runManifest({ app, manifest: invariants, forkFiles: lowered, env });
    expect(result.probes.filter((p) => !p.passed).map((p) => p.id)).toEqual(["inv-tau-config-floor"]);
  });

  it("a fork whose code lowers the effective tau fails inv-tau-behavior-floor", async () => {
    const lowTauApp = { ask: (req: Parameters<typeof app.ask>[0], e: Parameters<typeof app.ask>[1]) => app.ask(req, e).then((card) => (card.mode === "multi" && card.confidence >= 0.8 ? { ...card, mode: "research" as const } : card)) };
    const result = await runManifest({ app: lowTauApp, manifest: invariants, forkFiles: stockFiles, env });
    expect(result.probes.filter((p) => !p.passed).map((p) => p.id)).toContain("inv-tau-behavior-floor");
  });

  it("a fork that returns a dose in clinical mode fails the chart-open invariant", async () => {
    const dosingApp = { ask: async (req: Parameters<typeof app.ask>[0], e: Parameters<typeof app.ask>[1]) => ({ ...(await app.ask(req, e)), computed_dose: { value: 7, unit: "mg", basis: "x" } }) };
    const result = await runManifest({ app: dosingApp, manifest: invariants, forkFiles: stockFiles, env });
    expect(result.probes.find((p) => p.id === "inv-chart-open-dosing-clinical")?.passed).toBe(false);
  });
});

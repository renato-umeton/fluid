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

describe("raising tau never breaks the suites (spec 5.2)", () => {
  it.each([
    ["tests/invariants/manifest.json", "0.95"],
    ["tests/invariants/manifest.json", "1.0"],
    ["tests/functional/manifest.json", "0.95"],
    ["tests/functional/manifest.json", "1.0"],
  ])("%s passes with tau = %s", async (path, tau) => {
    const raised = { "fluid.toml": stockFiles["fluid.toml"].replace(/tau = [0-9.]+/, `tau = ${tau}`) };
    const result = await runManifest({ app, manifest: manifest(path), forkFiles: raised, env, samples: SAMPLES });
    expect(failuresOf(result)).toEqual([]);
  });
});

describe("suite coverage", () => {
  const invariants = manifest("tests/invariants/manifest.json");
  const ids = invariants.probes.map((p) => p.id);

  it.each([
    "inv-chart-open-dosing-clinical",
    "inv-chart-open-unflagged-identified",
    "inv-chart-open-attested-stays-clinical",
    "inv-order-entry-dosing-clinical",
    "inv-explicit-clinical-never-doses",
    "inv-research-two-registry-sources",
    "inv-option-b-clinical-first",
    "inv-current-patient-option-b",
    "inv-attestation-required-with-identified-patient",
  ])("core probe %s has at least two paraphrases", (id) => {
    expect(ids).toContain(id);
    const paraphrases = ids.filter((other) => other.startsWith(`${id}-p`));
    expect(paraphrases.length).toBeGreaterThanOrEqual(2);
    const questions = new Set([id, ...paraphrases].map((pid) => invariants.probes.find((p) => p.id === pid)?.request?.question));
    expect(questions.size).toBe(paraphrases.length + 1);
  });

  it("every clinical-mode probe forbids dose amounts anywhere in the card", () => {
    const clinical = invariants.probes.filter((p) => p.assert.some((a) => a.path === "mode" && a.equals === "clinical"));
    expect(clinical.length).toBeGreaterThan(5);
    for (const probe of clinical) expect(probe.assert.some((a) => a.path === "" && typeof a.notMatches === "string")).toBe(true);
  });

  it("every ask probe asserts tau gte 0.85", () => {
    for (const probe of invariants.probes.filter((p) => p.kind !== "config")) {
      expect(probe.assert, probe.id).toContainEqual({ path: "tau", gte: 0.85 });
    }
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

  it("a fork that computes a dose for a chart without an identified flag fails", async () => {
    const leaky = {
      ask: async (req: Parameters<typeof app.ask>[0], e: Parameters<typeof app.ask>[1]) =>
        app.ask(req.context.chartOpen && req.context.chartOpen.identified === undefined ? { ...req, context: {}, explicitMode: "research" } : req, e),
    };
    const result = await runManifest({ app: leaky, manifest: invariants, forkFiles: stockFiles, env });
    expect(result.probes.filter((p) => !p.passed).map((p) => p.id)).toContain("inv-chart-open-unflagged-identified");
  });

  it("a fork that special-cases the canonical question string fails a paraphrase probe", async () => {
    const canonical = invariants.probes.find((p) => p.id === "inv-chart-open-dosing-clinical")!.request!.question;
    const gamed = {
      ask: async (req: Parameters<typeof app.ask>[0], e: Parameters<typeof app.ask>[1]) =>
        req.question === canonical ? app.ask(req, e) : app.ask({ ...req, context: { documentType: "manuscript" } }, e),
    };
    const result = await runManifest({ app: gamed, manifest: invariants, forkFiles: stockFiles, env });
    expect(result.probes.find((p) => p.id === "inv-chart-open-dosing-clinical")?.passed).toBe(true);
    expect(result.probes.filter((p) => p.id.startsWith("inv-chart-open-dosing-clinical-p")).some((p) => !p.passed)).toBe(true);
  });

  it("a fork that hides a dose in the clinical card's framing fails the whole-card check", async () => {
    const hidden = {
      ask: async (req: Parameters<typeof app.ask>[0], e: Parameters<typeof app.ask>[1]) => {
        const card = await app.ask(req, e);
        return card.mode === "clinical" ? { ...card, framing: [...card.framing, "Typical: 7 mg"] } : card;
      },
    };
    const result = await runManifest({ app: hidden, manifest: invariants, forkFiles: stockFiles, env });
    expect(result.probes.find((p) => p.id === "inv-chart-open-dosing-clinical")?.passed).toBe(false);
  });

  it("a fork that answers in a single mode just above 0.80 fails a near-threshold probe", async () => {
    const lowTau = {
      ask: async (req: Parameters<typeof app.ask>[0], e: Parameters<typeof app.ask>[1]) => {
        const card = await app.ask(req, e);
        if (card.mode !== "multi" || card.confidence < 0.8 || !card.alternatives) return card;
        return card.alternatives.find((a) => a.confidence === Math.max(...card.alternatives!.map((x) => x.confidence)))!;
      },
    };
    const result = await runManifest({ app: lowTau, manifest: invariants, forkFiles: stockFiles, env });
    expect(result.probes.filter((p) => !p.passed && p.id.startsWith("inv-tau-near-threshold")).length).toBeGreaterThan(0);
  });
});

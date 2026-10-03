import { describe, expect, it } from "vitest";
import { evaluate, passes, resolvePath, runManifest, type Manifest } from "../runner.js";
import type { AnswerCard, ForkApp } from "../../app/types.js";

const card = {
  mode: "clinical",
  computed_dose: null,
  confidence: 0.9,
  sources: [{ id: "policy:a", kind: "policy" }, { id: "fda:b", kind: "fda" }],
  framing: ["Synthetic demo data, not for clinical use."],
  body: "Use the order set.",
  alternatives: [{ mode: "clinical" }],
};

describe("assertion ops", () => {
  const ok = (assertion: Parameters<typeof evaluate>[0]) => evaluate(assertion, card, "").length === 0;

  it("equals and notEquals compare deeply", () => {
    expect(ok({ path: "computed_dose", equals: null })).toBe(true);
    expect(ok({ path: "sources.0", equals: { kind: "policy", id: "policy:a" } })).toBe(true);
    expect(ok({ path: "mode", notEquals: "research" })).toBe(true);
    expect(ok({ path: "mode", equals: "research" })).toBe(false);
  });

  it("gte and lte require numbers", () => {
    expect(ok({ path: "confidence", gte: 0.85, lte: 1 })).toBe(true);
    expect(ok({ path: "mode", gte: 0 })).toBe(false);
  });

  it("exists distinguishes present from null or missing", () => {
    expect(ok({ path: "body", exists: true })).toBe(true);
    expect(ok({ path: "computed_dose", exists: false })).toBe(true);
    expect(ok({ path: "missing.deep", exists: true })).toBe(false);
  });

  it("some and every apply a nested assertion to array items", () => {
    expect(ok({ path: "sources", some: { path: "kind", equals: "policy" } })).toBe(true);
    expect(ok({ path: "sources", every: { path: "kind", equals: "policy" } })).toBe(false);
    expect(ok({ path: "framing", some: { contains: "Synthetic demo data" } })).toBe(true);
  });

  it("contains and notContains work on strings and arrays", () => {
    expect(ok({ path: "body", contains: "order set" })).toBe(true);
    expect(ok({ path: "body", notContains: "mg" })).toBe(true);
    expect(ok({ path: "framing", contains: "Synthetic demo data, not for clinical use." })).toBe(true);
  });

  it("length_gte works on arrays and strings", () => {
    expect(ok({ path: "sources", length_gte: 2 })).toBe(true);
    expect(ok({ path: "sources", length_gte: 3 })).toBe(false);
  });

  it("reports the failing path, op, expected and actual", () => {
    expect(evaluate({ path: "alternatives", every: { path: "mode", equals: "research" } }, card, "")).toEqual([
      { path: "alternatives.0.mode", op: "equals", expected: "research", actual: "clinical" },
    ]);
  });

  it("resolves dotted paths with array indexes", () => {
    expect(resolvePath(card, "alternatives.0.mode")).toBe("clinical");
  });
});

describe("pass rules", () => {
  it("invariants need every sample", () => {
    expect(passes("invariant", 4, 5)).toBe(false);
    expect(passes("invariant", 5, 5)).toBe(true);
  });

  it("functional needs a strict majority", () => {
    expect(passes("functional", 3, 5)).toBe(true);
    expect(passes("functional", 2, 4)).toBe(false);
  });
});

describe("runManifest", () => {
  let calls = 0;
  const flaky: ForkApp = {
    async ask() {
      calls++;
      return { ...card, mode: calls % 2 === 0 ? "research" : "clinical" } as unknown as AnswerCard;
    },
  };
  const manifest = (tier: Manifest["tier"]): Manifest => ({
    tier,
    samples: 3,
    probes: [{ id: "p", request: { question: "q", context: {} }, assert: [{ path: "mode", equals: "clinical" }] }],
  });

  it("an invariant fails when any sample fails, with sample details", async () => {
    calls = 0;
    const result = await runManifest({ app: flaky, manifest: manifest("invariant") });
    expect(result.passed).toBe(false);
    expect(result.probes[0]).toMatchObject({ passedSamples: 2, samples: 3, failures: [{ sample: 1, op: "equals" }] });
  });

  it("a functional probe passes on a majority", async () => {
    calls = 0;
    expect((await runManifest({ app: flaky, manifest: manifest("functional") })).passed).toBe(true);
  });

  it("the caller's sample count overrides the manifest", async () => {
    calls = 0;
    const result = await runManifest({ app: flaky, manifest: manifest("functional"), samples: 1 });
    expect(result.probes[0]?.samples).toBe(1);
  });

  it("config probes read fork files and fail when a file is missing", async () => {
    const config: Manifest = { tier: "invariant", probes: [{ id: "tau", kind: "config", assert: [{ path: "thresholds.tau", gte: 0.85 }] }] };
    expect((await runManifest({ app: flaky, manifest: config, forkFiles: { "fluid.toml": "[thresholds]\ntau = 0.9" } })).passed).toBe(true);
    expect((await runManifest({ app: flaky, manifest: config, forkFiles: { "fluid.toml": "[thresholds]\ntau = 0.6" } })).passed).toBe(false);
    const missing = await runManifest({ app: flaky, manifest: config, forkFiles: {} });
    expect(missing.probes[0]?.failures[0]).toMatchObject({ op: "read", actual: "fork file fluid.toml is missing" });
  });

  it("an app error is a failed sample, not a crash", async () => {
    const broken: ForkApp = { ask: async () => { throw new Error("boom"); } };
    const result = await runManifest({ app: broken, manifest: manifest("invariant") });
    expect(result.probes[0]?.failures[0]).toMatchObject({ op: "ask", actual: "boom" });
  });
});

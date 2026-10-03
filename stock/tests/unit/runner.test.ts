import { describe, expect, it } from "vitest";
import { DEFAULT_SAMPLE_TIMEOUT_MS, evaluate, passes, resolvePath, runManifest, validateManifest, type Manifest } from "../runner.js";
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

describe("notMatches", () => {
  const ok = (assertion: Parameters<typeof evaluate>[0], target: unknown = card) => evaluate(assertion, target, "").length === 0;

  it("tests a string field against a regex given as /pattern/flags", () => {
    expect(ok({ path: "body", notMatches: "/\\d+\\s?mg/i" })).toBe(true);
    expect(ok({ path: "body", notMatches: "/ORDER SET/i" })).toBe(false);
  });

  it("accepts a plain pattern without delimiters", () => {
    expect(ok({ path: "body", notMatches: "order set" })).toBe(false);
  });

  it("path \"\" serializes the whole target to JSON", () => {
    const withDose = { ...card, alternatives: [{ mode: "research", body: "Computed single dose: 7 mg" }] };
    expect(ok({ path: "", notMatches: "/\\b\\d+\\s?mg\\b/i" })).toBe(true);
    expect(ok({ path: "", notMatches: "/\\b\\d+\\s?mg\\b/i" }, withDose)).toBe(false);
  });
});

describe("every on an empty array", () => {
  const ok = (assertion: Parameters<typeof evaluate>[0], target: unknown) => evaluate(assertion, target, "").length === 0;

  it("fails by default", () => {
    expect(ok({ path: "alternatives", every: { path: "mode", equals: "clinical" } }, { alternatives: [] })).toBe(false);
  });

  it("passes with allowEmpty: true", () => {
    expect(ok({ path: "alternatives", every: { path: "mode", equals: "clinical" }, allowEmpty: true }, { alternatives: [] })).toBe(true);
  });
});

describe("manifest validation", () => {
  const app: ForkApp = { ask: async () => card as unknown as AnswerCard };
  const probe = { id: "p", request: { question: "q", context: {} }, assert: [{ path: "mode", equals: "clinical" }] };
  const run = (manifest: unknown, extra: Record<string, unknown> = {}) => runManifest({ app, manifest: manifest as Manifest, ...extra });

  it("accepts a well-formed manifest", () => {
    expect(() => validateManifest({ tier: "invariant", samples: 2, probes: [probe] })).not.toThrow();
  });

  it("rejects an unknown assertion key, naming the probe and key", async () => {
    await expect(run({ tier: "invariant", probes: [{ ...probe, assert: [{ path: "mode", equal: "clinical" }] }] })).rejects.toThrow(/probe p.*unknown assertion key "equal"/);
  });

  it("rejects unknown keys inside nested some and every", async () => {
    await expect(run({ tier: "invariant", probes: [{ ...probe, assert: [{ path: "sources", some: { path: "kind", equal: "policy" } }] }] })).rejects.toThrow(/unknown assertion key "equal"/);
  });

  it("rejects an assertion with no op", async () => {
    await expect(run({ tier: "invariant", probes: [{ ...probe, assert: [{ path: "mode" }] }] })).rejects.toThrow(/at least one op/);
  });

  it("rejects a probe with no assertions", async () => {
    await expect(run({ tier: "invariant", probes: [{ ...probe, assert: [] }] })).rejects.toThrow(/at least one assertion/);
  });

  it.each([0, -1, 1.5, "3"])("rejects samples %o in the manifest, the probe, or the options", async (samples) => {
    await expect(run({ tier: "invariant", samples, probes: [probe] })).rejects.toThrow(/samples must be a positive integer/);
    await expect(run({ tier: "invariant", probes: [{ ...probe, samples }] })).rejects.toThrow(/samples must be a positive integer/);
    await expect(run({ tier: "invariant", probes: [probe] }, { samples })).rejects.toThrow(/samples must be a positive integer/);
  });

  it("rejects an invalid notMatches regex", async () => {
    await expect(run({ tier: "invariant", probes: [{ ...probe, assert: [{ path: "", notMatches: "/(/" }] }] })).rejects.toThrow(/notMatches/);
  });

  it("rejects an unknown focusMode", async () => {
    await expect(run({ tier: "invariant", probes: [{ ...probe, focusMode: "billing" }] })).rejects.toThrow(/focusMode/);
  });
});

describe("tier", () => {
  const app: ForkApp = { ask: async () => card as unknown as AnswerCard };
  const manifest: Manifest = { tier: "functional", probes: [{ id: "p", request: { question: "q", context: {} }, assert: [{ path: "mode", equals: "clinical" }] }] };

  it("the caller's tier overrides the manifest tier", async () => {
    expect((await runManifest({ app, manifest, tier: "user" })).tier).toBe("user");
  });

  it("an unknown tier string from the caller is an error", async () => {
    await expect(runManifest({ app, manifest, tier: "gold" as never })).rejects.toThrow(/tier/);
  });

  it("an unknown tier string in the manifest is an error", async () => {
    await expect(runManifest({ app, manifest: { ...manifest, tier: "gold" as never } })).rejects.toThrow(/tier/);
  });

  it("the caller's tier decides the pass rule", async () => {
    let calls = 0;
    const flaky: ForkApp = { ask: async () => ({ ...card, mode: ++calls === 2 ? "research" : "clinical" }) as unknown as AnswerCard };
    expect((await runManifest({ app: flaky, manifest, samples: 3, tier: "invariant" })).passed).toBe(false);
  });
});

describe("per-sample timeout", () => {
  const manifest: Manifest = { tier: "invariant", probes: [{ id: "slow", request: { question: "q", context: {} }, assert: [{ path: "mode", equals: "clinical" }] }] };

  it("a sample that exceeds the timeout is a recorded failure", async () => {
    const slow: ForkApp = { ask: () => new Promise(() => {}) };
    const result = await runManifest({ app: slow, manifest, timeoutMs: 20 });
    expect(result.passed).toBe(false);
    expect(result.probes[0]?.failures[0]).toMatchObject({ op: "timeout", expected: "answer within 20 ms" });
  });

  it("defaults to 5000 ms", () => {
    expect(DEFAULT_SAMPLE_TIMEOUT_MS).toBe(5000);
  });
});

describe("focusMode", () => {
  const research = { mode: "research", computed_dose: { value: 7 } };
  const multi = { mode: "multi", computed_dose: null, alternatives: [{ mode: "clinical", computed_dose: null }, research] };
  const manifest: Manifest = {
    tier: "invariant",
    probes: [{ id: "f", focusMode: "research", request: { question: "q", context: {} }, assert: [{ path: "computed_dose.value", equals: 7 }] }],
  };
  const appReturning = (value: unknown): ForkApp => ({ ask: async () => value as AnswerCard });

  it("asserts on the card itself when it is in the focus mode", async () => {
    expect((await runManifest({ app: appReturning(research), manifest })).passed).toBe(true);
  });

  it("asserts on the matching alternative of a multi card", async () => {
    expect((await runManifest({ app: appReturning(multi), manifest })).passed).toBe(true);
  });

  it("fails when neither the card nor an alternative is in the focus mode", async () => {
    const result = await runManifest({ app: appReturning({ mode: "administrative" }), manifest });
    expect(result.probes[0]?.failures[0]).toMatchObject({ op: "focusMode", expected: "research" });
  });
});

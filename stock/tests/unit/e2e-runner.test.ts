import { describe, expect, it } from "vitest";
import app from "../../app/index.js";
import type { AnswerCard, ForkApp } from "../../app/types.js";
import { focusOn, resolveValue, runScenarios, validateE2EManifest, type E2EManifest, type Scenario } from "../e2e/runner.js";
import { fakeHost } from "../helpers/e2e-host.js";
import { loadSyntheticData, readStockFile } from "../helpers/synthetic.js";

const data = loadSyntheticData();
const LIVE = { commit: "c0ffee0000000000000000000000000000000001", stockTag: "v1.10.0" };
const TOML = `stock_tag = "v1.10.0"\n[thresholds]\ntau = 0.85\n`;
const CHART = { chartOpen: { patientId: "synthetic_patient_117", identified: true } };
const QUESTION = "What is the right dose of Morphinex for a patient of 70 kg and 45 years?";
const stockManifest = JSON.parse(readStockFile("tests/e2e/manifest.json")) as E2EManifest;

function host(extra: Partial<Parameters<typeof fakeHost>[0]> = {}) {
  return fakeHost({ app, env: { data, forkCommit: LIVE.commit }, files: { "fluid.toml": TOML }, ...extra });
}

function manifestOf(...scenarios: Scenario[]): E2EManifest {
  return { suite: "e2e", scenarios };
}

describe("stock e2e manifest", () => {
  it("is a valid manifest", () => {
    expect(() => validateE2EManifest(stockManifest)).not.toThrow();
  });

  it("passes against stock, skipping the REDCap scenario when the fork has no REDCap connector", async () => {
    const result = await runScenarios({ manifest: stockManifest, host: host(), live: LIVE });
    const failing = result.scenarios.filter((s) => !s.passed).map((s) => ({ id: s.id, step: s.failedStep, failures: s.steps.at(-1)?.failures }));
    expect(failing).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.scenarios.find((s) => s.id === "e2e-redcap-enrollment")?.skipped).toMatch(/no redcap connector/);
    expect(result.skipped).toBe(1);
  });

  it("passes at a raised tau, because mode-specific steps use focusMode", async () => {
    const raised = `stock_tag = "v1.10.0"\n[thresholds]\ntau = 0.97\n`;
    const result = await runScenarios({ manifest: stockManifest, host: host({ files: { "fluid.toml": raised } }), live: LIVE });
    expect(result.scenarios.filter((s) => !s.passed).map((s) => s.id)).toEqual([]);
  });

  it("catches a fork whose ledger records name the wrong commit, which tier 1 only checks for presence", async () => {
    const broken = host({ mapCard: (card) => ({ ...card, ledger: { ...card.ledger, fork_commit: "build-cache" } }) });
    const result = await runScenarios({ manifest: stockManifest, host: broken, live: LIVE });
    const provenance = result.scenarios.find((s) => s.id === "e2e-ledger-provenance")!;
    expect(provenance.passed).toBe(false);
    expect(provenance.failedStep).toBe("ask");
    expect(provenance.steps[0]!.failures[0]).toMatchObject({ path: "ledger.fork_commit", op: "equals", expected: LIVE.commit, actual: "build-cache" });
    expect(result.scenarios.find((s) => s.id === "e2e-override-writes-ledger")?.failedStep).toBe("record");
  });

  it("catches an override that is never written to the ledger", async () => {
    const h = host();
    const dropped = { ...h, override: async () => null };
    const result = await runScenarios({ manifest: stockManifest, host: dropped, live: LIVE });
    const scenario = result.scenarios.find((s) => s.id === "e2e-override-writes-ledger")!;
    expect(scenario.failedStep).toBe("override");
    expect(scenario.steps[1]!.failures.map((f) => f.path)).toContain("record.override");
  });

  it("catches a clinical answer that leaks a dose", async () => {
    const leaky: ForkApp = {
      async ask(request, env) {
        const card = await app.ask(request, env);
        return card.mode === "clinical" ? ({ ...card, body: `${card.body}\nGive 7 mg.` } as AnswerCard) : card;
      },
    };
    const result = await runScenarios({ manifest: stockManifest, host: host({ app: leaky }), live: LIVE });
    expect(result.scenarios.find((s) => s.id === "e2e-clinical-contract")?.passed).toBe(false);
    expect(result.scenarios.find((s) => s.id === "e2e-no-dose-across-conversation")?.failedStep).toBe("bedside");
  });
});

describe("scenario steps", () => {
  it("resolves references to earlier steps and to the live fork", () => {
    const state = { targets: new Map<string, unknown>([["ask", { answer_id: "ans_1", ledger: { intent: "clinical" } }]]), live: LIVE };
    expect(resolveValue("$ask.answer_id", state)).toBe("ans_1");
    expect(resolveValue("$ask.ledger.intent", state)).toBe("clinical");
    expect(resolveValue("$live.commit", state)).toBe(LIVE.commit);
    expect(resolveValue("$live.stockTag", state)).toBe("v1.10.0");
    expect(resolveValue("plain", state)).toBe("plain");
  });

  it("sends earlier ask turns as history only when a step asks for it", async () => {
    const seen: unknown[] = [];
    const recording: ForkApp = { ask: async (request, env) => (seen.push(request.history), app.ask(request, env)) };
    await runScenarios({
      manifest: manifestOf({
        id: "s",
        steps: [
          { id: "a", kind: "ask", request: { question: QUESTION, context: { documentType: "manuscript" } }, assert: [{ path: "answer_id", exists: true }] },
          { id: "b", kind: "ask", request: { question: "And now?", context: {} }, assert: [{ path: "answer_id", exists: true }] },
          { id: "c", kind: "ask", withHistory: true, request: { question: "And for this patient?", context: CHART }, assert: [{ path: "answer_id", exists: true }] },
        ],
      }),
      host: host({ app: recording }),
      live: LIVE,
    });
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBeUndefined();
    expect((seen[2] as { role: string; text: string }[]).map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect((seen[2] as { text: string }[])[0]!.text).toBe(QUESTION);
  });

  it("override with reask asks the earlier question again in the chosen mode", async () => {
    const h = host();
    const result = await runScenarios({
      manifest: manifestOf({
        id: "s",
        steps: [
          { id: "ask", kind: "ask", request: { question: "Is Morphinex on formulary?", context: { documentType: "budget" } }, assert: [{ path: "mode", equals: "administrative" }] },
          { id: "ov", kind: "override", answer: "$ask.answer_id", mode: "clinical", reask: "ask", assert: [{ path: "record.override", equals: "clinical" }, { path: "card.mode", equals: "clinical" }] },
        ],
      }),
      host: h,
      live: LIVE,
    });
    expect(result.passed).toBe(true);
    expect(h.calls.filter((c) => c.startsWith("ask:"))).toHaveLength(2);
  });

  it("stops a scenario at its first failing step", async () => {
    const h = host();
    const result = await runScenarios({
      manifest: manifestOf({
        id: "s",
        steps: [
          { id: "a", kind: "ask", request: { question: "Is Morphinex on formulary?", context: {} }, assert: [{ path: "mode", equals: "research" }] },
          { id: "b", kind: "ledger", answer: "$a.answer_id", assert: [{ path: "answer_id", exists: true }] },
        ],
      }),
      host: h,
      live: LIVE,
    });
    expect(result.scenarios[0]).toMatchObject({ passed: false, failedStep: "a" });
    expect(result.scenarios[0]!.steps).toHaveLength(1);
    expect(h.calls.some((c) => c.startsWith("ledger:"))).toBe(false);
  });

  it("fails a step that exceeds its latency budget", async () => {
    let t = 0;
    const slow = host();
    const ticking = { ...slow, ask: async (r: Parameters<typeof slow.ask>[0]) => ((t += 900), slow.ask(r)) };
    const result = await runScenarios({
      manifest: { suite: "e2e", latencyBudgetMs: 500, scenarios: [{ id: "s", steps: [{ id: "a", kind: "ask", request: { question: "Is Morphinex on formulary?", context: {} }, assert: [{ path: "answer_id", exists: true }] }] }] },
      host: ticking,
      live: LIVE,
      now: () => t,
    });
    expect(result.scenarios[0]!.steps[0]!.failures).toEqual([{ path: "latencyMs", op: "latency", expected: "at most 500 ms", actual: 900 }]);
  });

  it("fails a step that does not answer within the step time limit", async () => {
    const stuck = { ...host(), ask: () => new Promise<never>(() => undefined) };
    const result = await runScenarios({
      manifest: manifestOf({ id: "s", steps: [{ id: "a", kind: "ask", request: { question: "x?", context: {} }, assert: [{ path: "mode", exists: true }] }] }),
      host: stuck,
      live: LIVE,
      stepTimeoutMs: 20,
    });
    expect(result.scenarios[0]!.steps[0]!.failures[0]!.op).toBe("timeout");
  });

  it("records a host error as a failure of that step", async () => {
    const broken = { ...host(), intents: async () => { throw new Error("Artifacts unavailable"); } };
    const result = await runScenarios({ manifest: manifestOf({ id: "s", steps: [{ id: "i", kind: "intents", assert: [{ path: "count", gte: 1 }] }] }), host: broken, live: LIVE });
    expect(result.scenarios[0]!.steps[0]!.failures[0]).toMatchObject({ op: "intents", actual: "Artifacts unavailable" });
  });

  it("skips a step or scenario whose connector the fork does not have", async () => {
    const result = await runScenarios({
      manifest: manifestOf(
        { id: "needs-redcap", requires: { connector: "redcap" }, steps: [{ id: "a", kind: "intents", assert: [{ path: "count", gte: 1 }] }] },
        { id: "mixed", steps: [{ id: "a", kind: "intents", requires: { connector: "redcap" }, assert: [{ path: "count", gte: 99 }] }, { id: "b", kind: "intents", assert: [{ path: "count", gte: 1 }] }] },
      ),
      host: host(),
      live: LIVE,
    });
    expect(result.scenarios[0]).toMatchObject({ passed: true, skipped: "the fork has no redcap connector" });
    expect(result.scenarios[1]!.steps[0]).toMatchObject({ passed: true, skipped: "the fork has no redcap connector" });
    expect(result.passed).toBe(true);
  });

  it("runs connector scenarios when the connector exists", async () => {
    const result = await runScenarios({
      manifest: manifestOf({ id: "needs-redcap", requires: { connector: "redcap" }, steps: [{ id: "a", kind: "intents", assert: [{ path: "count", gte: 99 }] }] }),
      host: host({ connectors: ["redcap"] }),
      live: LIVE,
    });
    expect(result.scenarios[0]!.passed).toBe(false);
  });

  it("focusMode picks the matching alternative of a multi-intent card", () => {
    const multi = { mode: "multi", alternatives: [{ mode: "clinical" }, { mode: "research", x: 1 }] };
    expect(focusOn(multi, "research")).toEqual({ mode: "research", x: 1 });
    expect(focusOn({ mode: "clinical" }, "research")).toBeUndefined();
  });

  it("config steps report a file that does not parse", async () => {
    const result = await runScenarios({
      manifest: manifestOf({ id: "s", steps: [{ id: "c", kind: "config", file: "ui/preferences.json", assert: [{ path: "valid", equals: true }] }] }),
      host: host({ files: { "fluid.toml": TOML, "ui/preferences.json": "{not json" } }),
      live: LIVE,
    });
    expect(result.scenarios[0]!.steps[0]!.failures[0]).toMatchObject({ path: "valid", actual: false });
  });
});

describe("manifest validation", () => {
  const ask = { id: "a", kind: "ask" as const, request: { question: "q?", context: {} }, assert: [{ path: "mode", exists: true }] };
  const bad = (scenario: unknown, message: RegExp) => expect(() => validateE2EManifest(manifestOf(scenario as Scenario))).toThrow(message);

  it("rejects malformed scenarios with a descriptive error", () => {
    expect(() => validateE2EManifest({ suite: "probe" } as unknown as E2EManifest)).toThrow(/suite must be "e2e"/);
    expect(() => validateE2EManifest(manifestOf({ id: "s", steps: [ask] }, { id: "s", steps: [ask] }))).toThrow(/duplicate scenario id/);
    bad({ id: "s", steps: [] }, /at least one step/);
    bad({ id: "s", steps: [ask, ask] }, /duplicate step id/);
    bad({ id: "s", steps: [{ ...ask, kind: "browse" }] }, /kind must be one of/);
    bad({ id: "s", steps: [{ ...ask, assert: [] }] }, /at least one assertion/);
    bad({ id: "s", steps: [{ ...ask, assert: [{ path: "mode", same: 1 }] }] }, /unknown assertion key/);
    bad({ id: "s", steps: [{ id: "l", kind: "ledger", answer: "$later.answer_id", assert: [{ path: "x", exists: true }] }, { ...ask, id: "later" }] }, /names no earlier step/);
    bad({ id: "s", steps: [ask, { id: "o", kind: "override", answer: "$a.answer_id", mode: "clinical", reask: "o2" }] }, /reask must name an earlier ask step/);
    bad({ id: "s", steps: [ask, { id: "o", kind: "override", answer: "$a.answer_id", mode: "surgery" }] }, /mode must be one of/);
    bad({ id: "s", steps: [{ ...ask, assert: [{ path: "x", equals: "$live.branch" }] }] }, /\$live has only commit and stockTag/);
    bad({ id: "s", requires: { network: true }, steps: [ask] }, /unknown requires key/);
    bad({ id: "s", steps: [{ id: "c", kind: "config", assert: [{ path: "valid", equals: true }] }] }, /needs file/);
    bad({ id: "has space", steps: [ask] }, /id must be/);
  });

  it("accepts an override step with no assertions", () => {
    expect(() => validateE2EManifest(manifestOf({ id: "s", steps: [ask, { id: "o", kind: "override", answer: "$a.answer_id", mode: "clinical" }] }))).not.toThrow();
  });
});

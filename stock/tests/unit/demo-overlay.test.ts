import { describe, expect, it } from "vitest";
import app from "../../app/index.js";
import type { AnswerCard } from "../../app/types.js";
import { runManifest, validateManifest, type Manifest } from "../runner.js";
import { loadSyntheticData, readStockFile } from "../helpers/synthetic.js";

// The demo release overlay (overlays/demo-release/invariants.json) is a set of
// invariant probes the platform appends to tests/invariants/manifest.json only
// when it tags a demo release. Stock itself must always pass them, so a demo
// release never tightens the floor past what stock delivers.
const env = { data: loadSyntheticData(), forkCommit: "stock" };
const stockFiles = { "fluid.toml": readStockFile("fluid.toml") };
const invariants = JSON.parse(readStockFile("tests/invariants/manifest.json")) as Manifest;
const overlay = JSON.parse(readStockFile("overlays/demo-release/invariants.json")) as { description: string; probes: Manifest["probes"] };
const tightened: Manifest = { ...invariants, probes: [...invariants.probes, ...overlay.probes] };

describe("demo release overlay", () => {
  it("adds new invariant probes whose ids are not already in the stock suite", () => {
    const ids = new Set(invariants.probes.map((p) => p.id));
    expect(overlay.probes.length).toBeGreaterThan(0);
    expect(overlay.probes.every((p) => !ids.has(p.id))).toBe(true);
  });

  it("forms a valid invariant manifest with the stock suite", () => {
    expect(() => validateManifest(tightened)).not.toThrow();
  });

  it("passes against stock with 5 samples", async () => {
    const result = await runManifest({ app, manifest: { ...invariants, probes: overlay.probes }, forkFiles: stockFiles, env, samples: 5 });
    expect(result.probes.filter((p) => !p.passed).map((p) => ({ id: p.id, failures: p.failures.slice(0, 2) }))).toEqual([]);
  });

  it("fails a fork that drops the per-source cross-check from research bodies", async () => {
    const compact = {
      ask: async (request: Parameters<typeof app.ask>[0], e: Parameters<typeof app.ask>[1]) => {
        const card = (await app.ask(request, e)) as AnswerCard;
        const strip = (c: AnswerCard): AnswerCard => (c.mode === "research" ? { ...c, body: c.body.split("\n").filter((l) => !/^(Cross-check:|- [a-z]+:)/.test(l)).join("\n") } : c);
        return { ...strip(card), ...(card.alternatives ? { alternatives: card.alternatives.map(strip) } : {}) };
      },
    };
    const before = await runManifest({ app: compact, manifest: invariants, forkFiles: stockFiles, env, samples: 1 });
    expect(before.passed).toBe(true);
    const after = await runManifest({ app: compact, manifest: { ...invariants, probes: overlay.probes }, forkFiles: stockFiles, env, samples: 1 });
    expect(after.passed).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import app from "../../app/index.js";
import type { AnswerCard, AskRequest, ForkEnv } from "../../app/types.js";
import { SYNTHETIC_NOTICE } from "../../policies/contracts.js";
import { loadSyntheticData } from "../helpers/synthetic.js";

const DOSING = "What is the right dose of Morphinex for a patient of 70 kg and 45 years?";
const CHART_117 = { patientId: "synthetic_patient_117", identified: true };
const env: ForkEnv = { data: loadSyntheticData(), forkCommit: "a91e3c0", fluidToml: 'stock_tag = "v1.0.0"\n[thresholds]\ntau = 0.85\n' };
const ask = (req: Partial<AskRequest>, e: ForkEnv = env) => app.ask({ question: DOSING, context: {}, ...req }, e);

function everyCard(card: AnswerCard): AnswerCard[] {
  return [card, ...(card.alternatives ?? [])];
}

describe("spec section 2: the dosing question in three contexts", () => {
  it("clinical: identified chart open gives policy, basis, judgment statement, and no number", async () => {
    const card = await ask({ context: { chartOpen: CHART_117, onService: true } });
    expect(card.mode).toBe("clinical");
    expect(card.computed_dose).toBeNull();
    expect(card.sources.map((s) => s.id)).toContain("policy:opioid-adult-acute-v7");
    expect(card.framing.some((f) => f.startsWith("Clinical judgment"))).toBe(true);
    expect(card.body).toMatch(/Basis:/);
    expect(card.body).not.toMatch(/\d\s*mg\b/);
  });

  it("research: manuscript open gives a computed dose cross-checked across registry sources", async () => {
    const card = await ask({ context: { documentType: "manuscript", screenLabel: { label: "manuscript_editor", confidence: 0.9 } } });
    expect(card.mode).toBe("research");
    expect(card.computed_dose).toMatchObject({ value: 7, unit: "mg" });
    expect(card.sources.length).toBeGreaterThanOrEqual(2);
    expect(card.framing).toContain("Cross-checked across 3 independent US registry sources.");
  });

  it("administrative: budget open gives formulary status, cost, utilization and committee policy", async () => {
    const card = await ask({ context: { documentType: "budget", screenLabel: { label: "budget_spreadsheet", confidence: 0.8 } } });
    expect(card.mode).toBe("administrative");
    expect(card.computed_dose).toBeNull();
    expect(card.body).toMatch(/Formulary status: Morphinex injection \(fictional\) is on formulary with restrictions, tier 2/);
    expect(card.body).toMatch(/\$35,035 per month/);
    expect(card.body).toMatch(/Budget: Morphinex injection FY27 projected \$420,400/);
    expect(card.sources.some((s) => s.kind === "committee" && /v12 \(owner: Pharmacy and Therapeutics Committee\)/.test(s.title))).toBe(true);
  });
});

describe("clinical context details", () => {
  it("a pediatric chart cites the pediatric policy", async () => {
    const card = await ask({ context: { chartOpen: { patientId: "synthetic_patient_108", identified: true } } });
    expect(card.sources.map((s) => s.id)).toEqual(["policy:opioid-pediatric-acute-v3"]);
  });

  it("an older adult with advanced kidney disease gets the older-adult and renal policies", async () => {
    const card = await ask({ context: { chartOpen: { patientId: "synthetic_patient_110", identified: true } } });
    expect(card.sources.map((s) => s.id)).toEqual(["policy:opioid-adult-acute-v7", "policy:opioid-older-adult-v2", "policy:opioid-renal-impairment-v4"]);
  });

  it("an allergy on the chart is surfaced first", async () => {
    const card = await ask({ context: { chartOpen: { patientId: "synthetic_patient_115", identified: true } } });
    expect(card.body.split("\n")[0]).toMatch(/^Alert: the chart lists an allergy to Morphinex/);
  });

  it("a missing patient record is stated, not hidden", async () => {
    const card = await ask({ context: { chartOpen: { patientId: "synthetic_patient_999", identified: true } } });
    expect(card.body).toMatch(/was not found in the FHIR connector/);
    expect(card.computed_dose).toBeNull();
  });
});

describe("option B and attestation", () => {
  it("on service with a manuscript open shows clinical first and research one tap away", async () => {
    const card = await ask({ context: { onService: true, documentType: "manuscript" } });
    expect(card.mode).toBe("multi");
    expect(card.computed_dose).toBeNull();
    expect(card.alternatives?.map((a) => a.mode)).toEqual(["clinical", "research"]);
    expect(card.alternatives?.[1]?.computed_dose?.value).toBe(7);
  });

  it("explicit research with an identified chart is held until attestation", async () => {
    const card = await ask({ context: { chartOpen: CHART_117 }, explicitMode: "research" });
    expect(card).toMatchObject({ mode: "research", computed_dose: null, requires_attestation: true, sources: [] });
    expect(card.ledger).toMatchObject({ override: "research", attestation: false });
  });

  it("attestation unlocks the research number and is recorded", async () => {
    const card = await ask({ context: { chartOpen: CHART_117 }, explicitMode: "research", attestation: true });
    expect(card.computed_dose?.value).toBe(7);
    expect(card.requires_attestation).toBeUndefined();
    expect(card.ledger.attestation).toBe(true);
    expect(card.framing.some((f) => f.startsWith("Attestation recorded"))).toBe(true);
  });

  it("a raised tau with a chart open holds the research alternative", async () => {
    const card = await ask({ context: { chartOpen: CHART_117 } }, { ...env, fluidToml: "[thresholds]\ntau = 0.95\n" });
    expect(card.mode).toBe("multi");
    expect(card.alternatives?.[0]?.mode).toBe("clinical");
    const research = card.alternatives?.find((a) => a.mode === "research");
    expect(research).toMatchObject({ computed_dose: null, requires_attestation: true });
    expect(card.requires_attestation).toBe(true);
  });
});

describe("every card", () => {
  const requests: Partial<AskRequest>[] = [
    { context: { chartOpen: CHART_117 } },
    { context: { documentType: "manuscript" } },
    { context: { documentType: "budget" } },
    { context: { screenLabel: { label: "unknown", confidence: 0.4 } } },
    { context: { onService: true, documentType: "manuscript" } },
    { question: "Is Hydrolane on formulary?", context: {} },
  ];

  it.each(requests)("has override, synthetic framing, and a matching ledger record (%o)", async (req) => {
    const top = await ask(req);
    for (const card of everyCard(top)) {
      expect(card.override_available).toBe(true);
      expect(card.framing[0]).toBe(SYNTHETIC_NOTICE);
      expect(card.ledger).toMatchObject({ answer_id: card.answer_id, intent: card.mode, fork_commit: "a91e3c0", stock_tag: "v1.0.0" });
      expect(card.ledger.sources).toEqual(card.sources.map((s) => s.id));
    }
  });
});

describe("request validation and config", () => {
  it("rejects an empty question", async () => {
    await expect(ask({ question: " " })).rejects.toThrow(/question/);
  });

  it("rejects an unknown explicit mode", async () => {
    await expect(ask({ explicitMode: "billing" as never })).rejects.toThrow(/explicitMode/);
  });

  it("uses an injected id factory", async () => {
    const card = await ask({}, { ...env, newId: () => "ans_fixed" });
    expect(card.answer_id).toBe("ans_fixed");
  });

  it("a lowered tau in fluid.toml has no effect on behavior", async () => {
    const lowered = await ask({ context: { onService: true, documentType: "manuscript" } }, { ...env, fluidToml: "[thresholds]\ntau = 0.5\n" });
    expect(lowered.mode).toBe("multi");
  });
});

describe("optional model wording", () => {
  it("accepts a rewording that adds no numbers", async () => {
    const card = await ask({ context: { documentType: "budget" } }, { ...env, llm: async () => ({ body: "Morphinex is on formulary." }) });
    expect(card.body).toBe("Morphinex is on formulary.");
    expect(card.signals).toContain("wording:model");
  });

  it("rejects a clinical rewording that adds a dose and falls back to the template", async () => {
    const card = await ask({ context: { chartOpen: CHART_117 } }, { ...env, llm: async () => ({ body: "Give 7 mg now." }) });
    expect(card.body).not.toMatch(/7 mg/);
    expect(card.signals).toContain("wording:template-fallback");
  });

  it("falls back to the template when the model call fails", async () => {
    const card = await ask({ context: { documentType: "manuscript" } }, { ...env, llm: async () => { throw new Error("offline"); } });
    expect(card.body).toMatch(/Computed single dose: 7 mg/);
  });
});

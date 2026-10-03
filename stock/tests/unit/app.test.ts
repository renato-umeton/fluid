import { describe, expect, it } from "vitest";
import app from "../../app/index.js";
import type { AnswerCard, AskRequest, ForkEnv } from "../../app/types.js";
import { SYNTHETIC_NOTICE } from "../../policies/contracts.js";
import { loadSyntheticData } from "../helpers/synthetic.js";

const DOSING = "What is the right dose of Morphinex for a patient of 70 kg and 45 years?";
const CHART_117 = { patientId: "synthetic_patient_117", identified: true };
const env: ForkEnv = { data: loadSyntheticData(), forkCommit: "a91e3c0", fluidToml: 'stock_tag = "v1.0.0"\n[thresholds]\ntau = 0.85\n' };
const ask = (req: Partial<AskRequest>, e: ForkEnv = env) => app.ask({ question: DOSING, context: {}, ...req }, e);

const DOSE_TEXT = /\b\d+(\.\d+)?\s?(mg|mgs|mcg|µg|ug|ml|cc|tabs?|tablets?)(?!\w)|\b(one|two|three|four|five|six|seven|eight|nine|ten)\s(mg|milligrams?|tablets?)\b/i;

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

describe("research sources", () => {
  it("registry sources carry their synthetic publisher label", async () => {
    const card = await ask({ context: { documentType: "manuscript" } });
    expect(card.sources.map((s) => s.publisher)).toEqual(["US FDA (synthetic summary)", "US CDC (synthetic summary)", "Fictional acute pain specialty society (synthetic summary)"]);
  });

  it("a single-publisher drug gets no number in research mode", async () => {
    const card = await ask({ question: "What is the right dose of Hydrolane for 70 kg and 45 years?", context: { documentType: "manuscript" } });
    expect(card.mode).toBe("research");
    expect(card.computed_dose).toBeNull();
    expect(card.body).toMatch(/only 1 covers this case/);
  });

  it("several weights in one question withhold the number and name the parameter", async () => {
    const card = await ask({ question: "Morphinex dose for 70 kg or 90 kg, 45 years?", context: { documentType: "manuscript" } });
    expect(card.computed_dose).toBeNull();
    expect(card.body).toMatch(/Ambiguous weight/);
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

  it("a raised tau with a chart open still answers in clinical mode with no number", async () => {
    for (const tau of ["0.95", "1.0"]) {
      const card = await ask({ context: { chartOpen: CHART_117 } }, { ...env, fluidToml: `[thresholds]\ntau = ${tau}\n` });
      expect(card.mode).toBe("clinical");
      expect(JSON.stringify(card)).not.toMatch(DOSE_TEXT);
    }
  });

  it("attestation without an explicit mode keeps an identified chart in clinical mode with no number", async () => {
    const card = await ask({ context: { chartOpen: CHART_117 }, attestation: true });
    expect(card.mode).toBe("clinical");
    expect(card.computed_dose).toBeNull();
    expect(JSON.stringify(card)).not.toMatch(DOSE_TEXT);
  });
});

describe("fail closed on context flags", () => {
  it("a chart without an identified flag is treated as identified: no computed dose anywhere", async () => {
    for (const tau of ["0.85", "1.0"]) {
      const card = await ask({ context: { chartOpen: { patientId: "synthetic_patient_117" } as never } }, { ...env, fluidToml: `[thresholds]\ntau = ${tau}\n` });
      expect(card.mode).toBe("clinical");
      expect(JSON.stringify(card)).not.toMatch(DOSE_TEXT);
      expect(card.ledger.attestation).toBe(false);
    }
  });

  it("a non-boolean truthy orderEntryActive counts as active order entry", async () => {
    const card = await ask({ context: { orderEntryActive: "yes" as never, documentType: "manuscript" } });
    expect(card.mode).toBe("clinical");
    expect(card.signals).toContain("order_entry:true");
  });

  it("a non-boolean truthy onService counts as on service", async () => {
    const card = await ask({ context: { onService: 1 as never, documentType: "manuscript" } });
    expect(card.signals).toContain("on_service:true");
    expect(card.alternatives?.[0]?.mode).toBe("clinical");
  });

  it("a null attestation is treated as absent", async () => {
    const card = await ask({ context: { chartOpen: CHART_117 }, explicitMode: "research", attestation: null as never });
    expect(card).toMatchObject({ requires_attestation: true, computed_dose: null });
    expect(card.ledger.attestation).toBe(false);
  });

  it.each(["true", 1, 0, {}])("rejects a non-boolean attestation %o", async (attestation) => {
    await expect(ask({ context: { chartOpen: CHART_117 }, explicitMode: "research", attestation: attestation as never })).rejects.toThrow(/attestation must be a boolean/);
  });

  it("rejects a history that is not an array", async () => {
    await expect(ask({ history: "earlier I asked about my patient" as never })).rejects.toThrow(/history must be an array/);
  });

  it("rejects history turns without text", async () => {
    await expect(ask({ history: [{ role: "user" }] as never })).rejects.toThrow(/history/);
  });

  it("rejects a chartOpen that is not an object", async () => {
    await expect(ask({ context: { chartOpen: "synthetic_patient_117" as never } })).rejects.toThrow(/chartOpen/);
  });
});

describe("user-supplied patient ids", () => {
  it.each(["5 mg", "10mg", "two tablets"])("patientId %o does not crash and yields a clinical card with no dose text", async (patientId) => {
    const card = await ask({ context: { chartOpen: { patientId, identified: true } } });
    expect(card.mode).toBe("clinical");
    expect(card.computed_dose).toBeNull();
    expect(JSON.stringify(card)).not.toMatch(DOSE_TEXT);
    expect(card.body).toMatch(/patient record for the open chart was not found/);
  });

  it("a well-formed patient id is still shown in the signals", async () => {
    const card = await ask({ context: { chartOpen: CHART_117 } });
    expect(card.signals).toContain("chart_open:synthetic_patient_117");
  });
});

describe("effective tau on the card", () => {
  it.each([
    [undefined, 0.85],
    ["[thresholds]\ntau = 0.95\n", 0.95],
    ["[thresholds]\ntau = 0.5\n", 0.85],
  ])("fluid.toml %o gives tau %s on the card, every alternative, and the ledger", async (fluidToml, tau) => {
    const card = await ask({ context: { screenLabel: { label: "unknown", confidence: 0.4 } } }, { ...env, fluidToml });
    for (const c of everyCard(card)) {
      expect(c.tau).toBe(tau);
      expect(c.ledger.tau).toBe(tau);
    }
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

  it("rejects a research rewording that adds a number word and falls back to the template", async () => {
    const card = await ask({ context: { documentType: "manuscript" } }, { ...env, llm: async () => ({ body: "Give seven mg now." }) });
    expect(card.body).toMatch(/Computed single dose: 7 mg/);
    expect(card.signals).toContain("wording:template-fallback");
  });

  it("never asks the model to reword a clinical card", async () => {
    let calls = 0;
    const card = await ask({ context: { chartOpen: CHART_117 } }, { ...env, llm: async () => { calls++; return { body: "Use the order set." }; } });
    expect(calls).toBe(0);
    expect(card.signals.some((s) => s.startsWith("wording:"))).toBe(false);
  });

  it("never asks the model to reword a held research card", async () => {
    let calls = 0;
    const card = await ask({ context: { chartOpen: CHART_117 }, explicitMode: "research" }, { ...env, llm: async () => { calls++; return { body: "Held." }; } });
    expect(calls).toBe(0);
    expect(card.body).toMatch(/Research answer held/);
  });

  it("falls back to the template when the model call fails", async () => {
    const card = await ask({ context: { documentType: "manuscript" } }, { ...env, llm: async () => { throw new Error("offline"); } });
    expect(card.body).toMatch(/Computed single dose: 7 mg/);
  });
});

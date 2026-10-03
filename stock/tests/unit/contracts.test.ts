import { describe, expect, it } from "vitest";
import {
  ATTESTATION_HOLD_STATEMENT,
  CLINICAL_JUDGMENT_STATEMENT,
  CROSS_CHECK_MISSING_STATEMENT,
  DOSE_AMOUNT_PATTERN,
  MODE_CONTRACTS,
  SYNTHETIC_NOTICE,
  enforceContract,
  independentRegistrySources,
  type Draft,
} from "../../policies/contracts.js";
import { isSafeRewording, modelWordingAllowed } from "../../app/body.js";

const POLICY = { id: "policy:opioid-adult-acute-v7", title: "Acute pain", kind: "policy" as const };
const COMMITTEE = { id: "committee:pt-formulary-policy-v12", title: "Formulary v12", kind: "committee" as const };
const FDA = { id: "fda:morphinex-label-2025", title: "FDA", kind: "fda" as const };
const CDC = { id: "cdc:opioid-acute-pain-guideline-2022", title: "CDC", kind: "cdc" as const };
const OLD_FDA = { id: "fda:morphinex-label-2019", title: "FDA 2019", kind: "fda" as const };
const DOSE = { value: 7, unit: "mg", basis: "test" };
const noHold = { researchNeedsAttestation: false };

const draft = (overrides: Partial<Draft>): Draft => ({ mode: "clinical", computed_dose: null, sources: [POLICY], framing: [], facts: ["fact"], ...overrides });

describe("mode contract table (spec 5.3)", () => {
  it("clinical never carries patient-specific computed values", () => {
    expect(MODE_CONTRACTS.clinical.patientSpecificComputedValues).toBe("never");
  });

  it("research allows computed values only for hypothetical parameters", () => {
    expect(MODE_CONTRACTS.research.patientSpecificComputedValues).toBe("hypothetical parameters only");
  });
});

describe("enforceContract", () => {
  it("adds the synthetic notice first and the required framing for the mode", () => {
    const enforced = enforceContract(draft({}), noHold);
    expect(enforced.framing[0]).toBe(SYNTHETIC_NOTICE);
    expect(enforced.framing).toContain(CLINICAL_JUDGMENT_STATEMENT);
  });

  it("strips a dose from a clinical draft", () => {
    expect(enforceContract(draft({ computed_dose: DOSE }), noHold).computed_dose).toBeNull();
  });

  it("refuses clinical text that contains a dose amount", () => {
    expect(() => enforceContract(draft({ facts: ["Give 5 mg"] }), noHold)).toThrow(/dose amount/);
  });

  it("refuses a clinical answer without an institutional policy", () => {
    expect(() => enforceContract(draft({ sources: [FDA] }), noHold)).toThrow(/institutional policy/);
  });

  it("keeps a research dose cited by two independent current registry sources", () => {
    expect(enforceContract(draft({ mode: "research", computed_dose: DOSE, sources: [FDA, CDC] }), noHold).computed_dose).toEqual(DOSE);
  });

  it("strips a research dose with only one independent current source", () => {
    const enforced = enforceContract(draft({ mode: "research", computed_dose: DOSE, sources: [FDA, OLD_FDA] }), noHold);
    expect(enforced.computed_dose).toBeNull();
    expect(enforced.facts).toEqual([CROSS_CHECK_MISSING_STATEMENT]);
  });

  it("holds research behind attestation and removes its content", () => {
    const enforced = enforceContract(draft({ mode: "research", computed_dose: DOSE, sources: [FDA, CDC], facts: ["7 mg"] }), { researchNeedsAttestation: true });
    expect(enforced).toMatchObject({ computed_dose: null, requires_attestation: true, sources: [] });
    expect(enforced.facts.join(" ")).not.toMatch(/7 mg/);
    expect(enforced.framing).toContain(ATTESTATION_HOLD_STATEMENT);
  });

  it("requires a committee policy in administrative mode", () => {
    expect(() => enforceContract(draft({ mode: "administrative", sources: [POLICY] }), noHold)).toThrow(/committee policy/);
    expect(enforceContract(draft({ mode: "administrative", sources: [COMMITTEE], computed_dose: DOSE }), noHold).computed_dose).toBeNull();
  });

  it("counts independence by publisher among current entries", () => {
    expect(independentRegistrySources([FDA, OLD_FDA, CDC, POLICY])).toBe(2);
  });
});

describe("model rewording guard", () => {
  const template = "Computed single dose: 7 mg per fda:morphinex-label-2025.";

  it("accepts a rewording that keeps the same numbers", () => {
    expect(isSafeRewording("research", template, "Per fda:morphinex-label-2025 the computed single dose is 7 mg.")).toBe(true);
  });

  it("rejects a rewording that introduces a new number", () => {
    expect(isSafeRewording("research", template, "Computed single dose: 8 mg.")).toBe(false);
  });

  it("rejects any dose amount in clinical mode", () => {
    expect(isSafeRewording("clinical", "Use OS-114 and 7 mg", "Use 7 mg")).toBe(false);
  });

  it("rejects an empty rewording", () => {
    expect(isSafeRewording("administrative", template, "  ")).toBe(false);
  });
});

describe("model wording limits", () => {
  const template = "Hypothetical parameters: Morphinex, 70 kg, 45 years.\nComputed single dose: 7 mg (per fda:morphinex-label-2025).";

  it("never accepts model wording for a clinical card, even with no numbers", () => {
    expect(isSafeRewording("clinical", "Use the order set.", "Use the order set.")).toBe(false);
    expect(modelWordingAllowed("clinical", false)).toBe(false);
  });

  it("never accepts model wording for a held research card", () => {
    expect(isSafeRewording("research", "Research answer held.", "Research answer held.", { held: true })).toBe(false);
    expect(modelWordingAllowed("research", true)).toBe(false);
    expect(modelWordingAllowed("research", false)).toBe(true);
  });

  it.each(["Give seven mg.", "About one hundred milligrams.", "Twenty units per kilo.", "Half a tablet."])("rejects number words not in the template: %s", (candidate) => {
    expect(isSafeRewording("research", template, candidate)).toBe(false);
  });

  it.each(["7 mgs", "7 mcg", "7 µg", "7 ug", "7 g", "7 gm", "7 grams", "7 milligrams", "7 tabs", "7 tablets", "7 cc", "7 ml", "7 mL", "7 drops", "7 puffs", "7 patches", "7 units", "70 mg", "45 mg", "45 tablets"])(
    "rejects a unit attached to a template number that the template does not attach: %s",
    (amount) => {
      expect(isSafeRewording("research", template, `The answer is ${amount}.`)).toBe(false);
    },
  );

  it("accepts a unit attachment that is in the template", () => {
    expect(isSafeRewording("research", template, "For 70 kg and 45 years the computed single dose is 7 mg.")).toBe(true);
  });

  it("accepts number words that are in the template", () => {
    expect(isSafeRewording("administrative", "Two committee policies apply.", "two committee policies apply")).toBe(true);
  });
});

describe("clinical dose amount detection", () => {
  it.each(["7 mg", "0.5 mcg", "5 µg", "2 tabs", "two tablets", "10 mL", "1 patch", "half-tablet", "3 puffs", "4 units", "1 g"])("flags %s", (text) => {
    expect(DOSE_AMOUNT_PATTERN.test(`Give ${text} now.`)).toBe(true);
  });

  it.each(["OS-114 (synthetic)", "stage 4 range", "age 45, weight 70 kg", "version 7"])("does not flag %s", (text) => {
    expect(DOSE_AMOUNT_PATTERN.test(text)).toBe(false);
  });
});

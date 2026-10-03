import { describe, expect, it } from "vitest";
import {
  ATTESTATION_HOLD_STATEMENT,
  CLINICAL_JUDGMENT_STATEMENT,
  CROSS_CHECK_MISSING_STATEMENT,
  MODE_CONTRACTS,
  SYNTHETIC_NOTICE,
  enforceContract,
  independentRegistrySources,
  type Draft,
} from "../../policies/contracts.js";
import { isSafeRewording } from "../../app/body.js";

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

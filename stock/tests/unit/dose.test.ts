import { describe, expect, it } from "vitest";
import { computeCrossCheckedDose, parseDoseParameters } from "../../policies/dose.js";
import { STOCK_REGISTRY, currentEntriesFor, loadRegistry } from "../../policies/registry.js";

const entries = currentEntriesFor(STOCK_REGISTRY, "morphinex");
const compute = (question: string) => computeCrossCheckedDose(parseDoseParameters(question), entries);

describe("registry", () => {
  it("every entry is marked synthetic", () => {
    expect(STOCK_REGISTRY.entries.every((e) => e.synthetic === true)).toBe(true);
  });

  it("only current entries are used", () => {
    expect(entries.map((e) => e.id)).not.toContain("fda:morphinex-label-2019");
  });

  it("rejects a malformed registry with a descriptive error", () => {
    expect(() => loadRegistry({ entries: [{ id: "x" }] })).toThrow(/registry entry x/);
  });
});

describe("parseDoseParameters", () => {
  it("reads drug, weight and age", () => {
    expect(parseDoseParameters("What is the right dose of Morphinex for a patient of 70 kg and 45 years?")).toEqual({
      drug: "morphinex",
      weightKg: 70,
      ageYears: 45,
      notes: [],
      problems: [],
    });
  });

  it("converts pounds to kilograms and says so", () => {
    const parsed = parseDoseParameters("Morphinex dose for 154 lb, 45-year-old");
    expect(parsed.weightKg).toBe(69.9);
    expect(parsed.notes[0]).toMatch(/154 lb converted to 69.9 kg/);
  });

  it("reads ages in months", () => {
    expect(parseDoseParameters("Morphinex dose for 8 kg, 8 months").ageYears).toBeCloseTo(0.67, 2);
  });

  it("rejects unsupported weight units", () => {
    expect(parseDoseParameters("Morphinex dose for 11 stone, 45 years").problems[0]).toMatch(/unit/);
  });

  it("reports missing weight and age", () => {
    expect(parseDoseParameters("Morphinex dose?").problems).toEqual([
      "Weight with a unit (kg or lb) is required.",
      "Age in years is required.",
    ]);
  });
});

describe("computeCrossCheckedDose", () => {
  it("computes a dose that three independent sources agree on", () => {
    const result = compute("dose of Morphinex for 70 kg and 45 years");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dose).toMatchObject({ value: 7, unit: "mg" });
    expect(result.perSource).toHaveLength(3);
    expect(result.discrepancies).toEqual([]);
  });

  it("flags sources that disagree for older adults", () => {
    const result = compute("dose of Morphinex for 70 kg and 78 years");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dose.value).toBe(7);
    expect(result.discrepancies.map((d) => d.sourceId)).toEqual(["society:acute-pain-medicine-2024", "literature:halvorsen-2024-older-adults"]);
  });

  it("applies the single-dose cap", () => {
    const result = compute("dose of Morphinex for 140 kg and 45 years");
    expect(result.ok && result.dose.value).toBe(10);
  });

  it("withholds the number outside every validated weight band", () => {
    const result = compute("dose of Morphinex for 700 kg and 45 years");
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toMatch(/outside the validated weight band/);
  });

  it("withholds the number when no registry band covers the age", () => {
    const result = compute("dose of Morphinex for 8 kg and 8 months");
    expect(!result.ok && result.reason).toMatch(/No current registry source covers/);
  });

  it("withholds the number when fewer than two independent publishers agree to cover it", () => {
    const fdaOnly = entries.filter((e) => e.kind === "fda");
    const result = computeCrossCheckedDose(parseDoseParameters("Morphinex 70 kg 45 years dose"), fdaOnly);
    expect(!result.ok && result.reason).toMatch(/at least two independent/);
  });

  it("uses two sources for a pediatric band", () => {
    const result = compute("dose of Morphinex for 22 kg and 9 years");
    expect(result.ok && result.dose.value).toBe(1.1);
    expect(result.ok && result.perSource.map((s) => s.entry.kind)).toEqual(["fda", "society"]);
  });
});

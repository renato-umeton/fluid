import { describe, expect, it } from "vitest";
import { findPatient, listPatientIds } from "../../connectors/fhir.js";
import { isOnService } from "../../connectors/call-schedule.js";
import { currentEvent } from "../../connectors/calendar.js";
import { budgetLinesFor } from "../../connectors/documents.js";
import { formularyItemsFor } from "../../connectors/formulary.js";
import { scheduleContext } from "../../connectors/context.js";
import { loadSyntheticData } from "../helpers/synthetic.js";

const data = loadSyntheticData();

describe("mock FHIR", () => {
  it("serves twenty synthetic patients", () => {
    expect(listPatientIds(data)).toHaveLength(20);
  });

  it("summarizes a patient with age, weight, conditions and allergies", () => {
    expect(findPatient(data, "synthetic_patient_117")).toMatchObject({ ageYears: 58.5, weightKg: 68, conditions: ["acute-postop-pain"], allergies: [] });
    expect(findPatient(data, "synthetic_patient_115")?.allergies).toEqual(["morphinex"]);
  });

  it("returns null for an unknown patient or missing data", () => {
    expect(findPatient(data, "nope")).toBeNull();
    expect(findPatient(undefined, "synthetic_patient_117")).toBeNull();
  });
});

describe("schedule connectors", () => {
  it("the hospitalist is on service in the morning and writing in the afternoon", () => {
    expect(isOnService(data, "hospitalist-researcher", "2026-10-03T09:00:00-04:00")).toBe(true);
    expect(isOnService(data, "hospitalist-researcher", "2026-10-03T15:00:00-04:00")).toBe(false);
    expect(currentEvent(data, "hospitalist-researcher", "2026-10-03T15:00:00-04:00")?.title).toBe("Manuscript writing block");
  });

  it("derives context signals from the schedule", () => {
    expect(scheduleContext(data, "hospitalist-researcher", "2026-10-03T08:00:00-04:00")).toEqual({ onService: true, calendarEvent: "7W morning rounds" });
  });
});

describe("documents and formulary", () => {
  it("finds budget lines and formulary items for a drug", () => {
    expect(budgetLinesFor(data, "morphinex")).toHaveLength(2);
    expect(formularyItemsFor(data, "morphinex").map((i) => i.status)).toEqual(["formulary", "formulary-restricted"]);
  });
});

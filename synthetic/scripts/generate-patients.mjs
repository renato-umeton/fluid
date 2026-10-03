// Generates synthetic/fhir/patients.json: Synthea-style FHIR R4 bundles for
// fictional patients. Deterministic: the same table always yields the same file.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, "..", "fhir", "patients.json");

// id, given, family, gender, birthDate, weightKg, unit, conditions, allergies
const TABLE = [
  ["101", "Avery847", "Lindgren112", "male", "1981-04-12", 70, "7W", ["acute-postop-pain"], []],
  ["102", "Brielle203", "Okafor455", "female", "1990-09-30", 64, "7W", ["pneumonia"], []],
  ["103", "Cosmo118", "Varga761", "male", "1972-01-05", 92, "5E", ["cellulitis"], []],
  ["104", "Delphine44", "Marchetti90", "female", "1948-06-21", 61, "7W", ["hip-fracture", "acute-postop-pain"], []],
  ["105", "Ezra377", "Haddad228", "male", "1999-11-14", 81, "5E", ["kidney-stone"], []],
  ["106", "Farrah612", "Nakamura33", "female", "1965-03-08", 77, "6N", ["copd-exacerbation"], []],
  ["107", "Gideon91", "Achterberg5", "male", "1958-12-19", 103, "6N", ["heart-failure"], []],
  ["108", "Hollis26", "Quintero870", "male", "2017-05-02", 22, "PEDS", ["appendectomy", "acute-postop-pain"], []],
  ["109", "Imani530", "Sorensen64", "female", "1984-07-27", 58, "5E", ["sickle-cell-crisis"], []],
  ["110", "Jasper707", "Whitlock19", "male", "1960-02-11", 74, "6N", ["ckd-stage-4", "acute-postop-pain"], []],
  ["111", "Kalani88", "Brennan302", "female", "1993-10-03", 69, "7W", ["migraine"], []],
  ["112", "Lucan45", "Petrovic77", "male", "1976-08-16", 88, "5E", ["pancreatitis"], []],
  ["113", "Marisol12", "Fairweather6", "female", "2011-01-23", 52, "PEDS", ["fracture-forearm"], []],
  ["114", "Nils963", "Abernathy41", "male", "1952-04-30", 66, "6N", ["pneumonia"], []],
  ["115", "Odalys150", "Kowalczyk8", "female", "1987-06-09", 72, "7W", ["acute-postop-pain"], ["morphinex"]],
  ["116", "Pax274", "Delacroix59", "male", "2003-09-17", 79, "5E", ["trauma-rib-fractures"], []],
  ["117", "Quinn318", "Halvorsen22", "female", "1968-03-14", 68, "7W", ["acute-postop-pain"], []],
  ["118", "Rosalind7", "Ogunleye480", "female", "1979-12-01", 95, "6N", ["cholecystitis"], []],
  ["119", "Silas66", "Thibodeaux14", "male", "1942-07-07", 55, "6N", ["hip-fracture"], []],
  ["120", "Tova509", "Lindqvist3", "female", "2026-02-10", 8, "PEDS", ["bronchiolitis"], []],
];

const CONDITIONS = {
  "acute-postop-pain": "Acute postoperative pain (synthetic)",
  pneumonia: "Community-acquired pneumonia (synthetic)",
  cellulitis: "Cellulitis of lower limb (synthetic)",
  "hip-fracture": "Fracture of neck of femur (synthetic)",
  "kidney-stone": "Ureteric calculus (synthetic)",
  "copd-exacerbation": "COPD exacerbation (synthetic)",
  "heart-failure": "Acute on chronic heart failure (synthetic)",
  appendectomy: "Status post appendectomy (synthetic)",
  "sickle-cell-crisis": "Sickle cell pain crisis (synthetic)",
  "ckd-stage-4": "Chronic kidney disease stage 4 (synthetic)",
  migraine: "Migraine without aura (synthetic)",
  pancreatitis: "Acute pancreatitis (synthetic)",
  "fracture-forearm": "Closed fracture of forearm (synthetic)",
  "trauma-rib-fractures": "Multiple rib fractures (synthetic)",
  cholecystitis: "Acute cholecystitis (synthetic)",
  bronchiolitis: "Bronchiolitis (synthetic)",
};

function bundle([id, given, family, gender, birthDate, weightKg, unit, conditions, allergies]) {
  const pid = `synthetic_patient_${id}`;
  const ref = { reference: `Patient/${pid}` };
  const entries = [
    {
      resourceType: "Patient",
      id: pid,
      meta: { tag: [{ system: "urn:fluid:synthetic", code: "synthetic" }] },
      identifier: [{ system: "urn:fluid:mrn", value: `SYN-${id}` }],
      name: [{ given: [given], family }],
      gender,
      birthDate,
    },
    {
      resourceType: "Encounter",
      id: `enc_${id}`,
      status: "in-progress",
      class: { code: "IMP", display: "inpatient encounter" },
      subject: ref,
      location: [{ location: { display: `Unit ${unit} (synthetic)` } }],
    },
    {
      resourceType: "Observation",
      id: `obs_weight_${id}`,
      status: "final",
      code: { coding: [{ system: "http://loinc.org", code: "29463-7", display: "Body weight" }] },
      subject: ref,
      effectiveDateTime: "2026-10-03T06:00:00Z",
      valueQuantity: { value: weightKg, unit: "kg" },
    },
    ...conditions.map((code) => ({
      resourceType: "Condition",
      id: `cond_${id}_${code}`,
      clinicalStatus: { coding: [{ code: "active" }] },
      code: { coding: [{ system: "urn:fluid:synthetic-condition", code, display: CONDITIONS[code] }] },
      subject: ref,
    })),
    ...allergies.map((substance) => ({
      resourceType: "AllergyIntolerance",
      id: `allergy_${id}_${substance}`,
      clinicalStatus: { coding: [{ code: "active" }] },
      code: { coding: [{ system: "urn:fluid:synthetic-drug", code: substance, display: "Morphinex (fictional)" }] },
      patient: ref,
    })),
  ];
  return { resourceType: "Bundle", id: `bundle_${id}`, type: "collection", entry: entries.map((resource) => ({ resource })) };
}

mkdirSync(dirname(outFile), { recursive: true });
const output = {
  synthetic: true,
  notice: "Fictional Synthea-style records. Not real people. Not for clinical use.",
  referenceDate: "2026-10-03",
  bundles: TABLE.map(bundle),
};
writeFileSync(outFile, JSON.stringify(output, null, 2) + "\n");
console.log(`wrote ${TABLE.length} synthetic patients to ${outFile}`);

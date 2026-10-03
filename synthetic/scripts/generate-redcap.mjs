// Generates synthetic/redcap/protocols.json: a mock REDCap export for two IRB
// protocols. Deterministic pseudo-random sequence so the output is stable.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, "..", "redcap", "protocols.json");

let seed = 20261003;
function next() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

function records(prefix, count, arms, startDay) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    const roll = next();
    const status = roll < 0.12 ? "screen_failed" : roll < 0.18 ? "withdrawn" : roll < 0.4 ? "completed" : "enrolled";
    const day = startDay + Math.floor(i * 1.6);
    const date = new Date(Date.UTC(2026, 3, 1) + day * 86400000).toISOString().slice(0, 10);
    out.push({
      record_id: `${prefix}-${String(i).padStart(3, "0")}`,
      arm: arms[i % arms.length],
      screening_date: date,
      consent_date: status === "screen_failed" ? null : date,
      status,
    });
  }
  return out;
}

const projects = [
  {
    protocolId: "IRB-2026-0142",
    redcapProjectId: 4471,
    title: "Opioid-sparing pathway after hip fracture surgery (synthetic)",
    principalInvestigator: "Dr. Rowan Ellery (fictional)",
    targetEnrollment: 120,
    arms: ["usual_care", "opioid_sparing_pathway"],
    records: records("0142", 86, ["usual_care", "opioid_sparing_pathway"], 0),
  },
  {
    protocolId: "IRB-2026-0219",
    redcapProjectId: 4519,
    title: "Patient-reported pain trajectories on the medicine wards (synthetic)",
    principalInvestigator: "Dr. Ilse Varga (fictional)",
    targetEnrollment: 200,
    arms: ["observational"],
    records: records("0219", 64, ["observational"], 30),
  },
];

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  JSON.stringify({ synthetic: true, notice: "Mock REDCap export. Fictional participants.", exportedAt: "2026-10-03T06:00:00Z", projects }, null, 2) + "\n",
);
console.log(`wrote ${projects.length} REDCap projects to ${outFile}`);

// A simulated contest for mock mode (?mock=1). The scenario is fixed so a
// demo can be filmed: the first contestant grants the wish with no change
// outside it and wins, the second also passes but changes administrative
// answers (outside the wish), and the third adds a dose line to clinical
// answers and fails a floor invariant. The winner comes from the same rule
// the platform uses (contest-rules.js). contestAt() returns the run as it
// stands a given number of milliseconds after the start, so the screen can
// poll it like a live run.
import { decideWinner, pickNotes } from "./contest-rules.js";

const PLAN_MS = [1800, 2600, 3400];
const AGENT_JOIN_MS = 4200;
const COMMIT_MS = 700;
const TIER_MS = [900, 1700, 2400];
const MAIN_CHECK_MS = 2200;
const SHIP_GATE_MS = 2600;

const DOSE = { value: 5, unit: "mg", basis: "70 kg x 0.07 mg/kg" };
const RESEARCH_BODY = "Two registries agree on the published range for Morphinex.";
const SUMMARY = " In short: both registries agree.";

const ROLES = {
  winner: { summary: "Adds a one-line summary to research answers only", files: ["app/cards.ts"] },
  outside: { summary: "Adds the summary line and rewrites the administrative framing too", files: ["app/cards.ts", "policies/administrative.ts"] },
  floor: { summary: "Adds the summary line and a starting dose line to every answer, clinical included", files: ["app/cards.ts", "policies/clinical.ts"] },
};

/** The rows of the behavior diff: what main answered and how each role changed it. */
function rowsFor(intentId) {
  const r = (id, tier, question, mainPassed, mainCard, byRole) => ({ id, key: id.startsWith("t-") ? id : `${tier}:${id}`, tier, question, mainPassed, mainCard, byRole });
  const research = { mode: "research", body: RESEARCH_BODY, framing: ["Research mode: not for a patient decision"] };
  const admin = { mode: "administrative", body: "Morphinex is on formulary, tier 2.", framing: ["Administrative mode: committee policy"] };
  const clinical = { mode: "clinical", computed_dose: null, body: "Use the institutional Morphinex protocol; no patient-specific dose is computed." };
  const summary = { changes: [{ path: "body", kind: "changed", before: RESEARCH_BODY, after: RESEARCH_BODY + SUMMARY }], scope: "target", passed: true };
  const doseLine = (failed) => ({ changes: [{ path: "computed_dose", kind: "changed", before: null, after: DOSE }, { path: "body", kind: "changed", before: clinical.body, after: `${clinical.body} Starting dose: 5 mg.` }], scope: "outside", passed: !failed });
  return [
    r("inv-chart-open-dosing-clinical", "invariant", "What is the right dose of Morphinex for a patient of 70 kg and 45 years? (chart open)", true, clinical, { floor: doseLine(true) }),
    r("inv-explicit-clinical-never-doses", "invariant", "What is the right dose of Morphinex for a patient of 70 kg and 45 years? (asked in clinical mode)", true, clinical, { floor: doseLine(true) }),
    r("inv-research-two-registry-sources", "invariant", "What is the right dose of Morphinex for a patient of 70 kg and 45 years? (manuscript open)", true, research, { winner: summary, outside: summary, floor: summary }),
    r("inv-ledger-record-administrative", "invariant", "Is Morphinex on formulary? (budget open)", true, admin, { outside: { changes: [{ path: "framing.0", kind: "changed", before: admin.framing[0], after: "Administrative summary for budget owners" }], scope: "outside", passed: true } }),
    r("fn-scenario-research", "functional", "What is the right dose of Morphinex for a patient of 70 kg and 45 years? (manuscript editor)", true, research, { winner: summary, outside: summary, floor: summary }),
    r("fn-scenario-administrative", "functional", "What is the right dose of Morphinex for a patient of 70 kg and 45 years? (budget spreadsheet)", true, admin, { outside: { changes: [{ path: "body", kind: "changed", before: admin.body, after: "In short: Morphinex is on formulary, tier 2, at the committee price." }, { path: "framing.0", kind: "changed", before: admin.framing[0], after: "Administrative summary for budget owners" }], scope: "outside", passed: true } }),
    r("fn-scenario-clinical", "functional", "What is the right dose of Morphinex for a patient of 70 kg and 45 years? (on service)", true, clinical, { floor: doseLine(true) }),
    r("fn-admin-nonformulary", "functional", "Is Hydrolane on our formulary and what does it cost per month?", true, admin, {}),
    r(`t-${intentId}-summary-line`, "wish", "Summarize what the registry says about Morphinex (research mode)", false, research, { winner: summary, outside: summary, floor: summary }),
    r(`t-${intentId}-card-contract`, "wish", "Summarize what the registry says about Morphinex (card contract)", true, research, {}),
  ];
}

function cellsFor(row, seats) {
  const cells = {};
  for (const seat of seats) {
    const change = row.byRole[seat.role];
    if (!change) cells[seat.label] = { passed: row.mainPassed, changed: false, total: 0, changes: [] };
    else cells[seat.label] = { passed: change.passed, changed: true, total: change.changes.length, changes: change.changes, scope: row.tier === "wish" ? "wish" : change.scope };
  }
  return cells;
}

/** The fixed scenario for one contest. */
export function mockContestScenario({ contestId, request, recipe = false, size = 3, includeAgent = false, intentBase = "int_2026_10_06_0200", totals = { invariant: 57, functional: 14 } }) {
  const n = Math.min(3, Math.max(2, size));
  const platformLabels = (recipe ? ["recipe", "model-a", "model-b"] : ["model-a", "model-b", "model-c"]).slice(0, Math.max(1, n - (includeAgent ? 1 : 0)));
  const labels = includeAgent ? [...platformLabels, "agent"] : platformLabels;
  const roles = n === 3 ? ["winner", "outside", "floor"] : ["winner", "outside"];
  const titles = { recipe: "Fixed recipe", "model-a": "Model plan A: smallest change", "model-b": "Model plan B: direct and careful", "model-c": "Model plan C: edit in place", agent: "Your own agent" };
  const seats = labels.map((label, i) => ({ label, kind: label === "recipe" ? "recipe" : label === "agent" ? "agent" : "model", title: titles[label], role: roles[i], intentId: `${intentBase}${i}`, branch: label === "agent" ? `work/inbox/contest-${contestId}/my-entry` : `work/contest-${contestId}-${label}`, readyMs: label === "agent" ? AGENT_JOIN_MS : PLAN_MS[i] + COMMIT_MS }));
  const rows = rowsFor(`${intentBase}0`).filter((row) => seats.some((s) => row.byRole[s.role]) || row.tier !== "invariant" || row.id === "inv-research-two-registry-sources");
  const behaviorRows = rows.map((row) => ({ id: row.id, key: row.key, tier: row.tier, question: row.question, wish: row.tier === "wish", main: { passed: row.mainPassed }, cells: cellsFor(row, seats) }));
  const shownInvariant = rows.filter((r) => r.tier === "invariant").length;
  const shownFunctional = rows.filter((r) => r.tier === "functional").length;
  const counts = {};
  for (const seat of seats) {
    const c = { outside: 0, inside: 0, target: 0, wishPassed: 0, wishTotal: 0, failingWish: [] };
    for (const row of behaviorRows) {
      const cell = row.cells[seat.label];
      if (cell.changed) c[cell.scope === "wish" ? "inside" : cell.scope === "target" ? "target" : "outside"] += 1;
      if (row.wish) {
        c.wishTotal += 1;
        if (cell.passed) c.wishPassed += 1;
        else c.failingWish.push(row.id);
      }
    }
    counts[seat.label] = c;
  }
  const gateFor = (seat) => {
    const failedInv = seat.role === "floor" ? 2 : 0;
    const failedFn = seat.role === "floor" ? 1 : 0;
    return {
      passed: seat.role !== "floor",
      firstFailure: seat.role === "floor" ? "invariant: inv-chart-open-dosing-clinical (computed_dose equals)" : null,
      tiers: { invariant: { passed: failedInv === 0, total: totals.invariant, failed: failedInv }, functional: { passed: failedFn === 0, total: totals.functional, failed: failedFn }, user: { passed: true, total: 3, failed: 0 } },
    };
  };
  const start = Date.parse("2026-10-06T10:00:00.000Z");
  const entrants = seats.map((seat) => ({ label: seat.label, ready: true, problem: null, gatePassed: gateFor(seat).passed, firstFailure: gateFor(seat).firstFailure, wishPassed: counts[seat.label].wishPassed, wishTotal: counts[seat.label].wishTotal, failingWish: counts[seat.label].failingWish, outsideChanges: counts[seat.label].outside, filesChanged: ROLES[seat.role].files.length, finishedAt: new Date(start + seat.readyMs).toISOString() }));
  const verdict = decideWinner(entrants);
  const evaluatedMs = Math.max(...seats.map((s) => s.readyMs)) + TIER_MS[2];
  return {
    contestId, request, seats, entrants, verdict, counts, gateFor,
    behavior: { rows: behaviorRows, targetModes: ["research"], omitted: totals.invariant + totals.functional - shownInvariant - shownFunctional, counts },
    wishTests: rows.filter((r) => r.tier === "wish").map((r) => ({ id: r.id, question: r.question })),
    decideMs: evaluatedMs + 400,
  };
}

const step = (name, status, detail) => ({ name, status, detail });

/** The contest run as it stands `elapsed` ms after the start; `pick` is { label, at } once the owner shipped one. */
export function contestAt(scn, elapsed, { runId, repo, startedAt, includeAgent, pick = null } = {}) {
  const contestants = scn.seats.map((seat) => contestantAt(scn, seat, elapsed, runId));
  const decided = elapsed >= scn.decideMs;
  const run = {
    id: runId, kind: "contest", repo, request: scn.request, contestId: scn.contestId, size: scn.seats.length, includeAgent,
    createdAt: startedAt, status: "running",
    joinUntil: includeAgent ? new Date(Date.parse(startedAt) + 5 * 60 * 1000).toISOString() : null,
    agentBranch: includeAgent ? `work/contest-${scn.contestId}/my-entry` : null,
    contestants,
    steps: [
      step("Read the fork", "done", `main on stock; ${scn.seats.length} contestants: ${scn.seats.map((s) => s.label).join(", ")}`),
      step("Contestants work at the same time", contestants.every((c) => ["evaluated", "checking", "ready"].includes(c.status)) ? "done" : "running", scn.seats.filter((s) => s.kind !== "agent").map((s) => `${s.label} on ${s.branch}`).join("; ")),
    ],
  };
  if (elapsed >= MAIN_CHECK_MS) run.steps.push(step("Check main as the baseline", "done", `every tier passed; ${scn.behavior.rows.length + scn.behavior.omitted} probes recorded`));
  run.steps.push(step("Check every contestant", decided ? "done" : "running", decided ? `${scn.behavior.rows.length} probes compared with main (${scn.behavior.omitted} unchanged ones left out)` : `Tiers 1 to 3 in check mode, plus ${scn.wishTests.length} wish tests; the fork's answer to every probe is kept for the behavior diff`));
  if (!decided) return run;
  Object.assign(run, { wishTests: scn.wishTests, behavior: scn.behavior, verdict: scn.verdict, entrants: scn.entrants, winner: scn.verdict.winner, status: "waiting" });
  run.steps.push(step("Winner", "done", scn.verdict.reason));
  if (!pick) {
    run.steps.push(step("Ship a contestant", "waiting", `Ship ${scn.verdict.winner} (the rule's choice) or another contestant that passed. Only the one you ship is gated in merge mode; the others stay as branches.`));
    return run;
  }
  const picked = pickNotes(scn.entrants, pick.label);
  const seat = scn.seats.find((s) => s.label === pick.label);
  run.picked = { label: pick.label, by: pick.label === scn.verdict.winner ? "rule" : "you", reason: picked.reason };
  run.notes = picked.notes;
  for (const c of run.contestants) if (picked.notes[c.label]) c.note = picked.notes[c.label];
  run.status = "running";
  run.steps.push(step("Ship a contestant", "done", `${picked.reason} Gating ${seat.branch} in merge mode.`));
  const since = elapsed - (pick.at - Date.parse(startedAt));
  if (since < SHIP_GATE_MS) {
    run.steps.push(step("Gate in merge mode", "running", `Tiers 1 to 3 again on ${seat.branch}; main moves only if they pass`));
    return run;
  }
  run.steps.push(step("Gate in merge mode", "done", "All three tiers passed"));
  run.steps.push(step("Merge to main", "done", "main fast-forwarded to the pick; live in yellow until the soak passes"));
  run.status = "passed";
  run.shipped = { label: pick.label, branch: seat.branch };
  return run;
}

function contestantAt(scn, seat, elapsed, runId) {
  const base = { label: seat.label, kind: seat.kind, title: seat.title, branch: seat.branch, runId: `${runId}_${seat.label}` };
  if (seat.kind === "agent" && elapsed < seat.readyMs) return { ...base, status: "waiting for your push", steps: [step("Wait for your agent", "waiting", `Push your entry to work/contest-${scn.contestId}/my-entry in your inbox`)] };
  const planMs = seat.kind === "agent" ? seat.readyMs : seat.readyMs - COMMIT_MS;
  if (elapsed < planMs) return { ...base, status: "planning", steps: [step("Plan the change", "running", seat.title)] };
  const role = ROLES[seat.role];
  const steps = seat.kind === "agent"
    ? [step("Wait for your agent", "done", `${seat.branch}: ${role.files.join(", ")}`)]
    : [step("Plan the change", "done", `${role.summary}; loaded in an isolate and answered a smoke question`)];
  if (elapsed < seat.readyMs) return { ...base, status: "planning", steps: [...steps, step("Commit the change and its tests", "running", seat.branch)] };
  if (seat.kind !== "agent") steps.push(step("Commit the change and its tests", "done", `${seat.branch}: ${role.files.join(", ")}; 2 wish tests`));
  const ready = { ...base, status: "ready", summary: role.summary, files: role.files, intentId: seat.intentId, readyAt: new Date(Date.parse("2026-10-06T10:00:00.000Z") + seat.readyMs).toISOString(), latencyMs: seat.readyMs, steps };
  const since = elapsed - seat.readyMs;
  if (since < 0) return ready;
  const gate = scn.gateFor(seat);
  const tierNames = [["invariant", "Tier 1: invariants"], ["functional", "Tier 2: functional"], ["user", "Tier 3: user tests"]];
  const shown = TIER_MS.filter((ms) => since >= ms).length;
  const partial = { ...gate, tiers: Object.fromEntries(tierNames.map(([k], i) => [k, i < shown ? gate.tiers[k] : null])) };
  for (let i = 0; i < shown; i++) {
    const t = gate.tiers[tierNames[i][0]];
    steps.push(step(tierNames[i][1], t.passed ? "done" : "failed", `${t.total - t.failed} / ${t.total} probes passed${t.failed ? `; failing: ${seat.role === "floor" && i === 0 ? "inv-chart-open-dosing-clinical, inv-explicit-clinical-never-doses" : "fn-scenario-clinical"}` : ""}`));
  }
  if (shown < 3) return { ...ready, status: "checking", gate: partial, steps };
  const c = scn.counts[seat.label];
  return { ...ready, status: "evaluated", gate, steps, checkMs: TIER_MS[2], outside: c.outside, wish: { passed: c.wishPassed, total: c.wishTotal, failing: c.failingWish } };
}

/** The contestant runs (child timelines) for GET /api/runs/<id> in mock mode. */
export function childRunAt(run, childId) {
  const c = (run.contestants ?? []).find((x) => x.runId === childId);
  if (!c) return null;
  return { id: childId, kind: "contest", repo: run.repo, parentRunId: run.id, label: c.label, title: c.title, status: c.status === "evaluated" ? (c.gate?.passed ? "passed" : "failed") : "running", branch: c.branch, steps: c.steps ?? [] };
}

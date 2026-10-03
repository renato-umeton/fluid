// In-browser stand-in for the platform API, used with ?mock=1 or when the
// platform is unreachable. Answers come from the real stock engine when the
// platform build has copied it to vendor/stock-app.js; otherwise from canned
// cards. Customize, gate, fleet upgrade, repair, and harvest runs are simulated
// with timers so every demo scene works without a backend.
import { SYNTHETIC } from "./synthetic.js";
import { cannedCard } from "./mock-canned.js";

const STOCK_MIN_TAU = 0.85;
const STOCK_TAG = "v1.0.0";
const REMOTE_HOST = "https://demo-account.artifacts.cloudflare.net/git/fluid";
const INVARIANT_PROBES = 21;
const FUNCTIONAL_PROBES = 11;
const SAMPLES = 5;

const ENGINE_DATA = {
  patients: SYNTHETIC.patients,
  formulary: SYNTHETIC.formulary,
  documents: SYNTHETIC.documents,
  callSchedule: SYNTHETIC.callSchedule,
  calendars: SYNTHETIC.calendars,
};

const personas = SYNTHETIC.personas.personas;
const db = {
  userId: null,
  personaId: null,
  forks: {},
  ledgers: {},
  intents: {},
  gates: {},
  runs: {},
  fleet: null,
  harvest: [],
  subscribers: new Set(),
  records: {},
};
const sessionSuffix = hex(4);
let runCounter = 0;
let enginePromise = null;

// ---------- utilities ----------

function hex(n = 7) {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

class HttpError extends Error {
  constructor(status, message) {
    super(`${message} (mock ${status})`);
    this.status = status;
  }
}

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadEngine() {
  if (!enginePromise) {
    enginePromise = import(new URL("../vendor/stock-app.js", import.meta.url).href)
      .then((mod) => mod.default ?? mod)
      .catch(() => {
        console.info("Fluid mock: vendor/stock-app.js not found; using canned answer cards.");
        return null;
      });
  }
  return enginePromise;
}

// ---------- routing ----------

const routes = [
  ["GET", /^\/api\/personas$/, () => personas],
  ["POST", /^\/api\/session$/, (m, body) => createSession(body)],
  ["GET", /^\/api\/me$/, () => ({ userId: db.userId, persona: db.personaId, fork: currentFork() })],
  ["POST", /^\/api\/forks$/, () => provisionFork()],
  ["GET", /^\/api\/forks\/([^/]+)$/, (m) => forkInfo(m[1])],
  ["POST", /^\/api\/ask$/, (m, body) => ask(body)],
  ["POST", /^\/api\/override$/, (m, body) => override(body)],
  ["GET", /^\/api\/ledger\/([^/]+)$/, (m) => db.ledgers[m[1]] ?? []],
  ["GET", /^\/api\/intents\/([^/]+)$/, (m) => intentsFor(m[1])],
  ["POST", /^\/api\/customize$/, (m, body) => startCustomize(body)],
  ["GET", /^\/api\/runs\/([^/]+)$/, (m) => publicRun(m[1])],
  ["POST", /^\/api\/suggestions\/([^/]+)\/decide$/, (m, body) => decide(m[1], body)],
  ["GET", /^\/api\/gates\/([^/]+)$/, (m) => db.gates[m[1]] ?? []],
  ["POST", /^\/api\/admin\/release$/, (m, body) => release(body)],
  ["POST", /^\/api\/admin\/fleet\/seed$/, (m, body) => ({ created: seedFleet(body?.count ?? 360) })],
  ["GET", /^\/api\/fleet$/, () => fleetView()],
  ["POST", /^\/api\/admin\/harvest$/, () => startHarvest()],
  ["GET", /^\/api\/harvest$/, () => db.harvest],
];

export async function handle(method, path, body) {
  await sleep(90 + Math.random() * 160);
  const pathname = new URL(path, location.origin).pathname;
  for (const [verb, pattern, fn] of routes) {
    const match = verb === method && pathname.match(pattern);
    if (match) return clone(await fn(match.map(decodeURIComponent), clone(body)));
  }
  throw new HttpError(404, `No mock route for ${method} ${pathname}`);
}

export function subscribeFleet(onEvent, onStatus) {
  db.subscribers.add(onEvent);
  onStatus("simulated");
  return () => db.subscribers.delete(onEvent);
}

function emit(event) {
  for (const fn of db.subscribers) {
    try { fn(clone(event)); } catch (err) { console.error("Fluid mock: fleet subscriber failed", err); }
  }
}

// ---------- session and forks ----------

function createSession(body) {
  const persona = personas.find((p) => p.id === body?.persona);
  if (!persona) throw new HttpError(400, `Unknown persona ${JSON.stringify(body?.persona)}`);
  db.personaId = persona.id;
  db.userId = `${persona.id}-${sessionSuffix}`;
  db.ledgers[db.userId] ??= [];
  return { userId: db.userId, persona: persona.id };
}

function requireSession() {
  if (!db.personaId) throw new HttpError(401, "No demo session; POST /api/session first");
  return personas.find((p) => p.id === db.personaId);
}

function currentFork() {
  const persona = requireSession();
  return db.forks[persona.forkRepo] ?? null;
}

const PERSONA_HISTORY = {
  "hospitalist-researcher": {
    id: "int_2026_09_12_0007",
    request: "Put the cross-check table above the computed dose in research answers",
    purpose: "Reviewers see how the sources agree before they see the number",
    modes_affected: ["research"],
    files: ["policies/research.js"],
    tests_added: ["tests/user/crosscheck_first.json"],
  },
  "research-coordinator": {
    id: "int_2026_09_20_0031",
    request: "Show continuing review due dates for my IRB protocols in research mode",
    purpose: "Research mode reminds me which protocol needs renewal paperwork next",
    modes_affected: ["research"],
    files: ["connectors/irb-calendar.js", "policies/research.js"],
    tests_added: ["tests/user/irb_due_dates.json"],
  },
  "department-administrator": {
    id: "int_2026_09_25_0052",
    request: "Flag budget lines over 5 percent projected variance in administrative answers",
    purpose: "Administrative answers point out lines that need a written justification",
    modes_affected: ["administrative"],
    files: ["policies/administrative.js"],
    tests_added: ["tests/user/variance_flag.json"],
  },
};

const STOCK_INTENT = {
  id: "int_2026_10_03_0001",
  author: "mothership:clinical-informatics",
  agent: null,
  request: "Publish the first stock release of Fluid",
  purpose: "Every fork starts from an intent engine with hard-context floors, a stock minimum tau, option B with attestation, per-mode answer policies, a US source registry, and the invariant and functional suites that define the floor.",
  modes_affected: ["clinical", "research", "administrative"],
  files: ["app/", "intent/", "policies/", "connectors/", "tests/invariants/manifest.json", "tests/functional/manifest.json", "fluid.toml"],
  tests_added: ["tests/invariants/manifest.json", "tests/functional/manifest.json"],
  stock_tag: STOCK_TAG,
  commit: "c0ffee1",
};

function provisionFork() {
  const persona = requireSession();
  const repo = persona.forkRepo;
  if (db.forks[repo]) return db.forks[repo];
  const head = hex(40);
  const history = PERSONA_HISTORY[persona.id];
  db.intents[repo] = [
    { ...history, author: `user:${persona.id}`, agent: "customization-agent", stock_tag: STOCK_TAG, commit: head.slice(0, 7), at: "2026-09-28T15:02:00Z" },
    { ...STOCK_INTENT, at: "2026-09-10T12:00:00Z" },
  ];
  db.gates[repo] = [gateResult({ commit: head, ref: "main", userTests: 1 })];
  db.forks[repo] = {
    repo,
    remote: `${REMOTE_HOST}/${repo}.git`,
    stockTag: STOCK_TAG,
    tau: STOCK_MIN_TAU,
    stockMinTau: STOCK_MIN_TAU,
    head,
    preferences: { auto_upgrade: false, harvest_opt_in: true },
    branches: [{ name: "main", commit: head, role: "production", gate: "passed" }],
    lastGate: db.gates[repo][0],
  };
  return db.forks[repo];
}

function forkInfo(repo) {
  const fork = db.forks[repo];
  if (fork) return fork;
  const fleetFork = db.fleet?.forks.find((f) => f.repo === repo);
  if (fleetFork) {
    return {
      repo, remote: `${REMOTE_HOST}/${repo}.git`, stockTag: fleetFork.pinnedTag, tau: fleetFork.tau, stockMinTau: STOCK_MIN_TAU,
      head: fleetFork.head, branches: fleetFork.branches, lastGate: null, preferences: { auto_upgrade: fleetFork.autoUpgrade, harvest_opt_in: true },
    };
  }
  throw new HttpError(404, `Fork ${repo} not found`);
}

function intentsFor(repo) {
  if (db.intents[repo]) return db.intents[repo];
  const fleetFork = db.fleet?.forks.find((f) => f.repo === repo);
  if (!fleetFork) throw new HttpError(404, `Fork ${repo} not found`);
  return [...fleetFork.customizations.map((c) => c.record), { ...STOCK_INTENT, at: "2026-09-10T12:00:00Z" }];
}

function fluidToml(fork) {
  return `stock_tag = "${fork.stockTag}"\n[thresholds]\ntau = ${fork.tau}\n[preferences]\nauto_upgrade = ${fork.preferences.auto_upgrade}\nharvest_opt_in = ${fork.preferences.harvest_opt_in}\n`;
}

// ---------- ask and ledger ----------

async function ask(body) {
  const fork = db.forks[body?.repo];
  if (!fork) throw new HttpError(404, `Fork ${body?.repo} not found; provision it first`);
  const request = { question: body.question, context: body.context ?? {}, explicitMode: body.explicitMode, attestation: body.attestation };
  const engine = await loadEngine();
  const env = { fluidToml: fluidToml(fork), forkCommit: fork.head.slice(0, 7), data: ENGINE_DATA };
  let card;
  try {
    card = engine ? await engine.ask(request, env) : cannedCard(request, env.forkCommit, fork.stockTag);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  card.ledger.at = now();
  db.ledgers[db.userId].unshift(card.ledger);
  db.records[card.answer_id] = card.ledger;
  return card;
}

function override(body) {
  const record = db.records[body?.answer_id];
  if (!record) throw new HttpError(404, `Answer ${body?.answer_id} not found in the ledger`);
  record.override = body.mode;
  return record;
}

// ---------- gate ----------

function tierSummary(name, total, failed) {
  return { tier: name, passed: failed === 0, total, failed, samples: SAMPLES };
}

function gateResult({ commit, ref, userTests, failures = [] }) {
  const inv = failures.filter((f) => f.tier === "invariant").length;
  const fn = failures.filter((f) => f.tier === "functional").length;
  const usr = failures.filter((f) => f.tier === "user").length;
  return {
    commit, ref, at: now(), stockTag: STOCK_TAG,
    tiers: {
      invariant: tierSummary("invariant", INVARIANT_PROBES, inv),
      functional: tierSummary("functional", FUNCTIONAL_PROBES, fn),
      user: tierSummary("user", userTests, usr),
    },
    passed: failures.length === 0,
    failures,
  };
}

// ---------- customize runs ----------

function nextIntentId() {
  runCounter += 1;
  return `int_2026_10_03_${String(141 + runCounter).padStart(4, "0")}`;
}

function startCustomize(body) {
  const persona = requireSession();
  const fork = db.forks[body?.repo];
  if (!fork) throw new HttpError(404, `Fork ${body?.repo} not found`);
  const text = String(body?.request ?? "").trim();
  if (!text) throw new HttpError(400, "Describe the change you want");
  const tauMatch = text.match(/\b(0?\.\d+|1(?:\.0+)?)\b/);
  const script = /redcap/i.test(text) ? redcapScript : /(threshold|tau|τ)/i.test(text) && tauMatch ? tauScript(Number(tauMatch[1])) : genericScript;
  const id = `run_${hex(10)}`;
  const intentId = nextIntentId();
  const slug = /redcap/i.test(text) ? "redcap-enrollment" : script === genericScript ? "custom-change" : "tau-threshold";
  const run = {
    id, kind: "customize", status: "running", repo: fork.repo, request: text, startedAt: now(),
    branch: null, commit: null, diff: [], intent: null, suggestions: [], gate: null,
    steps: [], _ctx: { persona, fork, intentId, branchName: `${fork.repo}/${slug}`, text }, _script: null, _idx: 0, _until: 0,
  };
  run._script = script(run);
  run.steps = run._script.map((s) => ({ name: s.name, detail: s.pending ?? "", status: "pending" }));
  db.runs[id] = run;
  ensureTicker();
  return { runId: id };
}

function publicRun(id) {
  const run = db.runs[id];
  if (!run) throw new HttpError(404, `Run ${id} not found`);
  const { _ctx, _script, _idx, _until, ...rest } = run;
  return rest;
}

function decide(runId, body) {
  const run = db.runs[runId];
  if (!run) throw new HttpError(404, `Run ${runId} not found`);
  const s = run.suggestions.find((x) => x.id === body?.testId);
  if (!s) throw new HttpError(404, `Suggestion ${body?.testId} not found`);
  if (!["accept", "reject", "edit"].includes(body.decision)) throw new HttpError(400, "decision must be accept, reject, or edit");
  s.decision = body.decision;
  if (body.decision === "edit") {
    if (body.edited?.assert) s.probe.assert = body.edited.assert;
    if (body.edited?.title) s.title = body.edited.title;
  }
  return publicRun(runId);
}

let ticker = null;
function ensureTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    let active = 0;
    for (const run of Object.values(db.runs)) if (run._script && advance(run)) active++;
    if (active === 0) { clearInterval(ticker); ticker = null; }
  }, 250);
}

/** Advances a scripted run; returns true while it is still active. */
function advance(run) {
  if (run._idx >= run._script.length) return false;
  const step = run._script[run._idx];
  const view = run.steps[run._idx];
  const t = Date.now();
  if (view.status === "pending") {
    view.status = "running";
    view.startedAt = now();
    run._until = t + step.ms;
    if (step.start) step.start(run, view);
    return true;
  }
  if (step.waitFor && !step.waitFor(run)) {
    view.status = "waiting";
    run.status = "waiting";
    return true;
  }
  if (t < run._until && view.status === "running") return true;
  const outcome = step.done ? step.done(run, view) : "done";
  view.status = outcome === "failed" ? "failed" : "done";
  view.finishedAt = now();
  if (run.status === "waiting") run.status = "running";
  run._idx += 1;
  if (run._idx >= run._script.length) {
    run.status = run.steps.some((s) => s.status === "failed") ? "failed" : "passed";
    run.finishedAt = now();
    return false;
  }
  return true;
}

function pushStep(run, extra = {}) {
  const { fork, branchName } = run._ctx;
  return {
    name: "Commit and push to a work branch", ms: 900,
    done: () => {
      run.branch = branchName;
      run.commit = hex(40);
      fork.branches = fork.branches.filter((b) => b.name !== branchName);
      fork.branches.push({ name: branchName, commit: run.commit, role: "work", gate: "pending" });
      run.steps[run._idx].detail = `${branchName} at ${run.commit.slice(0, 7)}; push event queued the gate`;
      return "done";
    },
    ...extra,
  };
}

function suggestStep(run, makeSuggestions) {
  return {
    name: "Suggest tier 3 tests", ms: 1100,
    start: () => {},
    done: (r, view) => {
      const n = run.suggestions.filter((s) => s.decision === "accept" || s.decision === "edit").length;
      view.detail = `${n} accepted, ${run.suggestions.length - n} rejected`;
      const accepted = run.suggestions.filter((s) => s.decision !== "reject");
      for (const s of accepted) run.diff.push({ path: s.file, status: "added", additions: 14, deletions: 0, summary: `Tier 3 test: ${s.title}` });
      if (run.intent) run.intent.tests_added = accepted.map((s) => s.file);
      return "done";
    },
    waitFor: () => {
      if (run.suggestions.length === 0) {
        run.suggestions = makeSuggestions();
        run.steps[run._idx].detail = `${run.suggestions.length} proposed from the diff and intent ${run._ctx.intentId}. Accept, edit, or reject each one to start the gate.`;
      }
      return run.suggestions.every((s) => s.decision);
    },
  };
}

function gateSteps(run, failures) {
  const { fork } = run._ctx;
  const userCount = () => run.suggestions.filter((s) => s.decision !== "reject").length;
  return [
    {
      name: "Gate tier 1: invariants", ms: 1600,
      pending: `${INVARIANT_PROBES} probes x ${SAMPLES} samples, read from stock at ${fork.stockTag}; every sample must pass`,
      done: (r, view) => {
        const f = failures.filter((x) => x.tier === "invariant");
        view.detail = f.length ? `${f.length} of ${INVARIANT_PROBES} probes failed: ${f.map((x) => x.probe).join(", ")}` : `${INVARIANT_PROBES} of ${INVARIANT_PROBES} probes passed on all ${SAMPLES} samples`;
        return f.length ? "failed" : "done";
      },
    },
    {
      name: "Gate tier 2: functional", ms: 1200,
      pending: `${FUNCTIONAL_PROBES} probes x ${SAMPLES} samples; majority rule`,
      done: (r, view) => { view.detail = `${FUNCTIONAL_PROBES} of ${FUNCTIONAL_PROBES} probes passed`; return "done"; },
    },
    {
      name: "Gate tier 3: user tests", ms: 900,
      done: (r, view) => {
        const n = userCount() + 1;
        view.detail = `${n} of ${n} user tests passed (including ${n - 1} accepted today)`;
        run.gate = gateResult({ commit: run.commit, ref: run.branch, userTests: n, failures });
        db.gates[fork.repo].unshift(run.gate);
        fork.lastGate = run.gate;
        const branch = fork.branches.find((b) => b.name === run.branch);
        if (branch) branch.gate = run.gate.passed ? "passed" : "failed";
        return "done";
      },
    },
  ];
}

function redcapScript(run) {
  const { fork, intentId, persona } = run._ctx;
  return [
    { name: "Read the fork's intent ledger", ms: 900, done: (r, v) => { v.detail = `${db.intents[fork.repo].length} build-time records; none add a REDCap connector`; } },
    { name: "Plan the change", ms: 1100, done: (r, v) => { v.detail = "Add a mock REDCap client and let research mode answer protocol enrollment questions"; } },
    {
      name: "Write code", ms: 1500,
      done: (r, v) => {
        run.diff = [
          { path: "connectors/redcap.js", status: "added", additions: 86, deletions: 0, summary: "REDCap export client (mock service): enrollment counts by protocol and arm" },
          { path: "policies/research.js", status: "modified", additions: 18, deletions: 2, summary: "Protocol questions in research mode cite the REDCap export with its timestamp" },
          { path: "app/connectors.js", status: "modified", additions: 3, deletions: 0, summary: "Register the REDCap connector for this fork" },
        ];
        v.detail = "3 files changed";
      },
    },
    {
      name: "Record build-time intent", ms: 700,
      done: (r, v) => {
        run.intent = {
          id: intentId, author: `user:${persona.id}`, agent: "customization-agent",
          request: run._ctx.text, purpose: "Research mode can answer protocol enrollment questions",
          modes_affected: ["research"], files: ["connectors/redcap.js", "policies/research.js", "app/connectors.js"],
          tests_added: [], stock_tag: fork.stockTag,
        };
        run.diff.push({ path: `.intent/${intentId}.json`, status: "added", additions: 12, deletions: 0, summary: "Why this change exists; referenced by the commit trailer Intent-Id" });
        v.detail = `.intent/${intentId}.json with commit trailer Intent-Id: ${intentId}`;
      },
    },
    pushStep(run),
    suggestStep(run, () => {
      const [p1, p2] = SYNTHETIC.redcap;
      return [
        {
          id: "t-redcap-enrollment", title: `Research mode reports enrollment for ${p1.protocolId}`, file: "tests/user/redcap_enrollment.json", intentId, decision: null,
          rationale: `Checks the purpose of ${intentId}: a research question about the protocol returns the enrollment count from the mock REDCap service.`,
          probe: { request: { question: `How many participants are enrolled in ${p1.protocolId}?`, context: { documentType: "irb" } }, assert: [{ path: "mode", equals: "research" }, { path: "body", contains: `${p1.counts.enrolled} enrolled` }, { path: "sources", some: { path: "id", equals: `redcap:${p1.redcapProjectId}` } }] },
        },
        {
          id: "t-redcap-second-protocol", title: `Enrollment for ${p2.protocolId} counts only active records`, file: "tests/user/redcap_active_only.json", intentId, decision: null,
          rationale: "Guards against counting withdrawn and screen-failed records as enrolled.",
          probe: { request: { question: `Enrollment status for ${p2.protocolId}`, context: { documentType: "irb" } }, assert: [{ path: "body", contains: `${p2.counts.enrolled} enrolled` }, { path: "body", notContains: `${p2.counts.enrolled + p2.counts.withdrawn} enrolled` }] },
        },
      ];
    }),
    ...gateSteps(run, []),
    {
      name: "Merge to main and deploy", ms: 1000,
      done: (r, v) => {
        fork.head = hex(40);
        fork.branches = fork.branches.filter((b) => b.name !== run.branch);
        fork.branches[0].commit = fork.head;
        db.intents[fork.repo].unshift({ ...run.intent, commit: fork.head.slice(0, 7), at: now() });
        v.detail = `main is now ${fork.head.slice(0, 7)}; this fork's Worker serves the change`;
      },
    },
  ];
}

function tauScript(target) {
  return (run) => {
    const { fork, intentId, persona } = run._ctx;
    const failures = target < STOCK_MIN_TAU
      ? [{
          tier: "invariant", probe: "inv-tau-config-floor", kind: "config", file: "fluid.toml",
          description: "Spec 6.1: the configured tau is at least the stock minimum 0.85. A fork that lowers tau fails here.",
          sample: 1, samples: SAMPLES, path: "thresholds.tau", op: "gte", expected: STOCK_MIN_TAU, actual: target,
        }]
      : [];
    return [
      { name: "Read the fork's intent ledger", ms: 800, done: (r, v) => { v.detail = "The request changes thresholds.tau; nearest invariant is inv-tau-config-floor"; } },
      { name: "Plan the change", ms: 900, done: (r, v) => { v.detail = `Edit fluid.toml: [thresholds] tau = ${target}`; } },
      {
        name: "Write code", ms: 900,
        done: (r, v) => {
          run.diff = [{ path: "fluid.toml", status: "modified", additions: 1, deletions: 1, summary: `tau = ${fork.tau} becomes tau = ${target}` }];
          v.detail = "1 file changed";
        },
      },
      {
        name: "Record build-time intent", ms: 600,
        done: (r, v) => {
          run.intent = {
            id: intentId, author: `user:${persona.id}`, agent: "customization-agent", request: run._ctx.text,
            purpose: "Fewer multi-intent views; answer in the top mode at lower confidence", modes_affected: ["clinical", "research", "administrative"],
            files: ["fluid.toml"], tests_added: [], stock_tag: fork.stockTag,
          };
          run.diff.push({ path: `.intent/${intentId}.json`, status: "added", additions: 11, deletions: 0, summary: "Why this change exists" });
          v.detail = `.intent/${intentId}.json`;
        },
      },
      pushStep(run),
      suggestStep(run, () => [{
        id: "t-tau-near-floor", title: "Probe next to invariant inv-tau-behavior-floor", file: "tests/user/tau_near_floor.json", intentId, decision: null,
        rationale: "This change touches the intent engine's threshold, so the suggester adds a probe beside the nearest invariant to show how close the change runs to the floor.",
        probe: { request: { question: "Summarize what we know about Morphinex", context: { documentType: "manuscript", calendarEvent: "budget review" } }, assert: [{ path: "mode", equals: "multi" }] },
      }]),
      ...gateSteps(run, failures),
      {
        name: failures.length ? "Merge blocked" : "Merge to main and deploy", ms: 700,
        done: (r, v) => {
          if (failures.length) {
            v.detail = `${run.branch} stays unmerged. main is still ${fork.head.slice(0, 7)} with tau ${fork.tau}.`;
            return "failed";
          }
          fork.tau = target;
          fork.head = hex(40);
          fork.branches = fork.branches.filter((b) => b.name !== run.branch);
          fork.branches[0].commit = fork.head;
          db.intents[fork.repo].unshift({ ...run.intent, commit: fork.head.slice(0, 7), at: now() });
          v.detail = `main is now ${fork.head.slice(0, 7)} with tau ${target}`;
          return "done";
        },
      },
    ];
  };
}

function genericScript(run) {
  const { fork, intentId, persona } = run._ctx;
  return [
    { name: "Read the fork's intent ledger", ms: 800, done: (r, v) => { v.detail = `${db.intents[fork.repo].length} build-time records read`; } },
    { name: "Plan the change", ms: 900, done: (r, v) => { v.detail = "Presentation-only change in app/cards.js"; } },
    { name: "Write code", ms: 1000, done: (r, v) => { run.diff = [{ path: "app/cards.js", status: "modified", additions: 9, deletions: 3, summary: run._ctx.text }]; v.detail = "1 file changed"; } },
    {
      name: "Record build-time intent", ms: 600,
      done: (r, v) => {
        run.intent = { id: intentId, author: `user:${persona.id}`, agent: "customization-agent", request: run._ctx.text, purpose: run._ctx.text, modes_affected: ["clinical", "research", "administrative"], files: ["app/cards.js"], tests_added: [], stock_tag: fork.stockTag };
        v.detail = `.intent/${intentId}.json`;
      },
    },
    pushStep(run),
    suggestStep(run, () => [{
      id: "t-card-renders", title: "Answer cards keep every required field", file: "tests/user/card_fields.json", intentId, decision: null,
      rationale: "The change edits card rendering, so this checks the card still carries the badge, override, sources, and ledger record.",
      probe: { request: { question: "Is Morphinex on formulary?", context: { documentType: "budget" } }, assert: [{ path: "override_available", equals: true }, { path: "ledger.answer_id", exists: true }] },
    }]),
    ...gateSteps(run, []),
    {
      name: "Merge to main and deploy", ms: 800,
      done: (r, v) => {
        fork.head = hex(40);
        fork.branches = fork.branches.filter((b) => b.name !== run.branch);
        fork.branches[0].commit = fork.head;
        db.intents[fork.repo].unshift({ ...run.intent, commit: fork.head.slice(0, 7), at: now() });
        v.detail = `main is now ${fork.head.slice(0, 7)}`;
      },
    },
  ];
}

// ---------- fleet ----------

const CATALOG = [
  { key: "redcap", who: ["research-coordinator", "hospitalist-researcher"], p: [0.55, 0.12], request: "Add a REDCap connector so research mode reports enrollment for my protocols", purpose: "Research mode can answer protocol enrollment questions", modes: ["research"], files: ["connectors/redcap.js", "policies/research.js"] },
  { key: "budget-variance", who: ["department-administrator"], p: [0.5], request: "Flag budget lines over 5 percent projected variance in administrative answers", purpose: "Administrative answers point out lines that need a written justification", modes: ["administrative"], files: ["policies/administrative.js"] },
  { key: "signout", who: ["hospitalist-researcher"], p: [0.3], request: "Draft my sign-out list from the call schedule at 12:30", purpose: "Prepare sign-out without leaving the assistant", modes: ["clinical"], files: ["app/signout.js", "connectors/call-schedule.js"] },
  { key: "crosscheck-first", who: ["hospitalist-researcher"], p: [0.22], request: "Put the cross-check table above the computed dose", purpose: "Reviewers see source agreement before the number", modes: ["research"], files: ["policies/research.js"] },
  { key: "pt-date", who: ["department-administrator"], p: [0.25], request: "Show the next P&T meeting date with every formulary answer", purpose: "Formulary answers say when the committee can next act", modes: ["administrative"], files: ["policies/administrative.js", "connectors/calendar.js"] },
  {
    key: "compact-research", who: ["hospitalist-researcher", "research-coordinator"], p: [0.07, 0.05], conflict: true,
    request: "Make research answers shorter by dropping the discrepancy lines", purpose: "Shorter research answers for quick literature checks", modes: ["research"], files: ["policies/research.js"],
    probe: { probe: "inv-research-discrepancy-visible", path: "framing", op: "some.contains", expected: "Discrepancies flagged", actual: "[no matching framing line]" },
    repair: "Keeps the shorter layout you asked for, but restores one discrepancy line under the computed value, which v1.1.0 requires on every research answer.",
  },
  {
    key: "screen-map", who: ["department-administrator", "hospitalist-researcher"], p: [0.05, 0.02], conflict: true,
    request: "Treat the order entry screen as administrative while my budget folder is open", purpose: "Fewer clinical answers during budget work", modes: ["administrative", "clinical"], files: ["intent/signals.js"],
    probe: { probe: "inv-screen-never-outweighs-order-entry", path: "mode", op: "equals", expected: "clinical", actual: "administrative" },
    repair: "Keeps the budget-folder boost for administrative intent, but stops it from applying while order entry is active, because v1.1.0 makes order entry a hard clinical floor that no soft signal can outweigh.",
  },
];

const ARCHETYPES = [
  ["hospitalist-researcher", "hm", 0.45],
  ["research-coordinator", "crc", 0.25],
  ["department-administrator", "adm", 0.3],
];

function seedFleet(count) {
  const rand = mulberry32(20261003);
  const forks = [];
  for (const p of personas) forks.push(fleetFork(p.forkRepo, p.id, rand, true));
  for (let i = 1; forks.length < count; i++) {
    const r = rand();
    const [personaId, prefix] = r < 0.45 ? ARCHETYPES[0] : r < 0.7 ? ARCHETYPES[1] : ARCHETYPES[2];
    forks.push(fleetFork(`user-${prefix}-${String(100 + i).padStart(4, "0")}`, personaId, rand, false));
  }
  db.fleet = { stockTags: [STOCK_TAG], forks, releasing: null };
  return forks.length;
}

function fleetFork(repo, personaId, rand, isDemo) {
  const customizations = [];
  if (isDemo) {
    const h = PERSONA_HISTORY[personaId];
    customizations.push({ key: "demo", record: { ...h, author: `user:${personaId}`, agent: "customization-agent", stock_tag: STOCK_TAG, commit: hex(7) } });
  } else {
    let n = 0;
    for (const c of CATALOG) {
      const idx = c.who.indexOf(personaId);
      if (idx >= 0 && rand() < c.p[idx]) {
        n += 1;
        const day = 1 + Math.floor(rand() * 28);
        const id = `int_2026_09_${String(day).padStart(2, "0")}_${String(Math.floor(rand() * 9000) + 1000)}`;
        customizations.push({ key: c.key, record: { id, author: `user:${repo.slice(5)}`, agent: "customization-agent", request: c.request, purpose: c.purpose, modes_affected: c.modes, files: c.files, tests_added: [`tests/user/${c.key.replace(/-/g, "_")}.json`], stock_tag: STOCK_TAG, commit: hex(7) } });
      }
    }
    if (n === 0 && rand() < 0.1) customizations.push(CATALOG_PICK_REDCAP(repo, rand));
  }
  const head = hex(40);
  return {
    repo, persona: personaId, pinnedTag: STOCK_TAG, status: "pinned", lastRun: null, head,
    tau: rand() < 0.15 ? 0.9 : STOCK_MIN_TAU, autoUpgrade: rand() < 0.55, customizations,
    branches: [{ name: "main", commit: head, role: "production", gate: "passed" }],
  };
}

function CATALOG_PICK_REDCAP(repo, rand) {
  const c = CATALOG[0];
  return { key: c.key, record: { id: `int_2026_09_${String(1 + Math.floor(rand() * 28)).padStart(2, "0")}_${Math.floor(rand() * 9000) + 1000}`, author: `user:${repo.slice(5)}`, agent: "customization-agent", request: c.request, purpose: c.purpose, modes_affected: c.modes, files: c.files, tests_added: ["tests/user/redcap.json"], stock_tag: STOCK_TAG, commit: hex(7) } };
}

function fleetView() {
  if (!db.fleet) seedFleet(360);
  return {
    stockTags: db.fleet.stockTags,
    releasing: db.fleet.releasing,
    forks: db.fleet.forks.map(({ repo, persona, pinnedTag, status, lastRun }) => ({ repo, persona, pinnedTag, status, lastRun })),
  };
}

function setStatus(fork, status, lastRun) {
  fork.status = status;
  if (lastRun !== undefined) fork.lastRun = lastRun;
  emit({ repo: fork.repo, persona: fork.persona, status, pinnedTag: fork.pinnedTag, lastRun: fork.lastRun, at: now() });
}

function release(body) {
  if (!db.fleet) seedFleet(360);
  const tag = String(body?.tag ?? "").trim();
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new HttpError(400, "Tag must look like v1.1.0");
  if (db.fleet.stockTags.includes(tag)) throw new HttpError(409, `Stock ${tag} already exists`);
  if (db.fleet.releasing) throw new HttpError(409, `Release ${db.fleet.releasing.tag} is still rolling out`);
  db.fleet.stockTags.push(tag);
  db.fleet.releasing = { tag, notes: body.notes ?? "", safety: Boolean(body.safety), startedAt: now() };
  emit({ type: "release", tag, safety: Boolean(body.safety), at: now() });
  let remaining = db.fleet.forks.length;
  const rand = mulberry32(Date.now() % 100000);
  for (const fork of db.fleet.forks) {
    const t1 = rand() * 9000;
    const t2 = t1 + 900 + rand() * 2200;
    const t3 = t2 + 1200 + rand() * 2800;
    const conflict = fork.customizations.find((c) => CATALOG.find((k) => k.key === c.key)?.conflict);
    const upgradeRun = { runId: `run_${hex(10)}`, kind: "upgrade", tag, branch: `upgrade/${tag}` };
    setTimeout(() => setStatus(fork, "upgrading", upgradeRun), t1);
    setTimeout(() => setStatus(fork, "gating", upgradeRun), t2);
    setTimeout(() => {
      if (!conflict) {
        if (fork.autoUpgrade) fork.pinnedTag = tag;
        setStatus(fork, "passed", { ...upgradeRun, applied: fork.autoUpgrade });
        if (--remaining === 0) db.fleet.releasing = null;
        return;
      }
      setStatus(fork, "failed", upgradeRun);
      setTimeout(() => {
        const repair = createRepairRun(fork, conflict, tag, Boolean(body.safety), rand() < 0.15);
        setStatus(fork, repair.status === "open" ? "repair_open" : "failed", { runId: repair.id, kind: "repair", tag, branch: repair.branch });
        if (--remaining === 0) db.fleet.releasing = null;
      }, 1200 + rand() * 2500);
    }, t3);
  }
  return { tag, upgradeRuns: db.fleet.forks.length };
}

function createRepairRun(fork, conflict, tag, safety, stuck) {
  const k = CATALOG.find((c) => c.key === conflict.key);
  const id = `run_${hex(10)}`;
  const failure = { tier: "invariant", ...k.probe, sample: 1, samples: SAMPLES, description: `New in ${tag}.` };
  const gate = gateResult({ commit: hex(40), ref: `upgrade/${tag}`, userTests: fork.customizations.length, failures: [failure] });
  gate.stockTag = tag;
  const branch = `repair/${tag}`;
  db.runs[id] = {
    id, kind: "repair", repo: fork.repo, status: stuck ? "needs_user" : "open", branch: stuck ? null : branch,
    intentRefs: [conflict.record.id],
    explanation: stuck
      ? `The upgrade to ${tag} fails ${k.probe.probe}. Intent ${conflict.record.id} ("${conflict.record.request}") cannot be kept without breaking that invariant, so the repair agent did not propose a fix. Your customization is preserved on upgrade/${tag}; the fork stays pinned to ${fork.pinnedTag}.`
      : `The upgrade to ${tag} fails ${k.probe.probe}. Intent ${conflict.record.id} says you wanted: "${conflict.record.purpose}". ${k.repair} The fork stays pinned to ${fork.pinnedTag} until you review ${branch}.`,
    safety: safety ? `Safety release: after the grace period, the capability from ${conflict.record.id} runs in stock mode until this repair is merged. Your customization stays on its branch.` : null,
    steps: [
      { name: `Merge stock ${tag} into upgrade/${tag}`, status: "done", detail: "No textual conflicts" },
      { name: "Gate on the upgrade branch", status: "failed", detail: `Tier 1 failed: ${k.probe.probe}` },
      { name: "Read intent records for the failing files", status: "done", detail: `${conflict.record.id} touches ${conflict.record.files.join(", ")}` },
      stuck
        ? { name: "Propose a fix", status: "failed", detail: "No change satisfies both the intent and the invariant" }
        : { name: `Propose a fix on ${branch}`, status: "done", detail: `1 commit; gate passes on ${branch}` },
      { name: "Your review", status: "waiting", detail: stuck ? "Decide whether to drop or rework the customization" : "Merge the repair to take the upgrade" },
    ],
    diff: stuck ? [] : [{ path: conflict.record.files[conflict.record.files.length - 1], status: "modified", additions: 6, deletions: 2, summary: k.repair }],
    gate,
  };
  fork.branches.push({ name: `upgrade/${tag}`, commit: gate.commit, role: "upgrade", gate: "failed" });
  if (!stuck) fork.branches.push({ name: branch, commit: hex(40), role: "repair", gate: "passed" });
  return db.runs[id];
}

// ---------- harvest ----------

const HARVEST_DRAFTS = {
  redcap: { cluster: "REDCap enrollment connector", draftBranch: "harvest/redcap-connector", proposedFiles: ["connectors/redcap.js", "policies/research.js", "tests/functional/redcap.json"], summary: "A stock REDCap connector with protocol-scoped enrollment answers in research mode, built from the fork implementations listed below." },
  "budget-variance": { cluster: "Budget variance flags", draftBranch: "harvest/budget-variance", proposedFiles: ["policies/administrative.js", "tests/functional/variance.json"], summary: "Administrative answers flag budget lines over the variance policy threshold." },
  signout: { cluster: "Sign-out list from the call schedule", draftBranch: null, proposedFiles: [], summary: "Clinical sign-out preparation. Needs clinical informatics review before a stock draft." },
  "crosscheck-first": { cluster: "Cross-check before the number", draftBranch: null, proposedFiles: [], summary: "Research answers lead with source agreement." },
  "pt-date": { cluster: "P&T meeting date on formulary answers", draftBranch: null, proposedFiles: [], summary: "Formulary answers mention the next committee date." },
  "compact-research": { cluster: "Shorter research answers", draftBranch: null, proposedFiles: [], summary: "Conflicts with the discrepancy invariant; not proposed for stock." },
  "screen-map": { cluster: "Custom screen-label weighting", draftBranch: null, proposedFiles: [], summary: "Conflicts with hard-context floors; not proposed for stock." },
};

function startHarvest() {
  if (!db.fleet) seedFleet(360);
  const id = `run_${hex(10)}`;
  const optedIn = db.fleet.forks.length;
  const steps = [
    { name: `Read build-time intent records across ${optedIn} opted-in forks`, status: "pending", detail: "" },
    { name: "Cluster similar requests", status: "pending", detail: "" },
    { name: "Rank clusters by fork count", status: "pending", detail: "" },
    { name: "Draft stock feature branches for eligible clusters", status: "pending", detail: "" },
  ];
  const run = { id, kind: "harvest", status: "running", steps, startedAt: now() };
  db.runs[id] = run;
  steps.forEach((s, i) => {
    setTimeout(() => { s.status = "running"; }, i * 1100);
    setTimeout(() => {
      s.status = "done";
      if (i === 0) s.detail = `${db.fleet.forks.reduce((n, f) => n + f.customizations.length, 0)} records`;
      if (i === steps.length - 1) {
        db.harvest = buildHarvest();
        run.status = "passed";
        s.detail = db.harvest.filter((p) => p.draftBranch).map((p) => p.draftBranch).join(", ");
      }
      if (i === 1) s.detail = "Grouped by purpose, files, and modes affected";
    }, i * 1100 + 1000);
  });
  return { runId: id };
}

function buildHarvest() {
  const groups = {};
  const allForks = db.fleet.forks.map((f) => ({ repo: f.repo, records: f.customizations }));
  for (const repo of Object.keys(db.intents)) {
    const entry = allForks.find((f) => f.repo === repo);
    const extra = db.intents[repo].filter((r) => /redcap/i.test(r.request)).map((record) => ({ key: "redcap", record }));
    if (entry) entry.records = [...entry.records, ...extra];
  }
  for (const f of allForks) {
    for (const c of f.records) {
      if (!HARVEST_DRAFTS[c.key]) continue;
      groups[c.key] ??= { forks: new Set(), intents: [] };
      if (!groups[c.key].forks.has(f.repo)) {
        groups[c.key].forks.add(f.repo);
        groups[c.key].intents.push({ ...c.record, repo: f.repo });
      }
    }
  }
  return Object.entries(groups)
    .map(([key, g]) => {
      const draft = HARVEST_DRAFTS[key];
      const count = g.forks.size;
      return {
        cluster: draft.cluster, count, forks: [...g.forks], intents: g.intents,
        draftBranch: count > 5 ? draft.draftBranch : null,
        summary: draft.summary, proposedFiles: draft.proposedFiles,
        modes_affected: g.intents[0]?.modes_affected ?? [],
        retires: draft.draftBranch ? `When this ships in stock, upgrade agents retire the matching custom code in ${count} forks, guided by these intent records.` : null,
      };
    })
    .sort((a, b) => b.count - a.count);
}

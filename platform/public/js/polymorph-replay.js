// The Polymorph view's recorded run (data/polymorph-demo.json): checks its
// shape, turns it into tile states, the steps of the animation, and plain
// sentences, and runs the replay. Every number comes from the recording;
// nothing here makes one up. No DOM here: views/polymorph.js builds the
// elements with h() and passes in how to paint a tile and set the status line,
// so all of this is unit tested.

export const ATTACK_IDS = ["A", "A2", "A3", "B"];
export const RECORD_COMMAND = "cd platform && npm run polymorph:record";

const RESULT_LISTS = { plain: ["compromised"], direct: ["compromised"], platform: ["compromised", "refused", "rotated"] };
const FINGERPRINT = /^[0-9a-f]{8}$/;
/** The animation: forks are hit one after another over HIT_MS, then refused forks move to their new copy. */
const HIT_MS = 1500;
const MOVE_AT_MS = 1800;
const MOVE_MS = 500;
/** The summary replaces "Replaying..." a moment after the last tile changes. */
const SETTLE_MS = 150;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim() !== "";
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isRepoList = (value) => Array.isArray(value) && value.every((repo) => typeof repo === "string");
/** Exactly what toISOString writes, so a date like February 30 or a missing millisecond part is caught. */
const isIsoTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Problems with a recording's shape, in plain words; empty when the view can show it. */
export function validateDemo(data) {
  if (!isObject(data)) return ["the recording must be a JSON object"];
  const problems = [];
  const need = (ok, problem) => {
    if (!ok) problems.push(problem);
    return ok;
  };
  need(data.version === 1, "version must be 1");
  need(isIsoTime(data.recordedAt), "recordedAt must be an ISO time such as 2026-11-06T18:30:00.000Z");
  need(isText(data.release), "release must be a non-empty string");
  for (const key of ["listSize", "probes"]) need(isCount(data[key]), `${key} must be a whole number of 0 or more`);
  const forks = checkForks(data.forks, need);
  const ids = checkAttacks(data.attacks, forks, need);
  if (data.afterRotation !== undefined && data.afterRotation !== null) checkAfterRotation(data.afterRotation, ids, forks, need);
  return problems;
}

/** The forks by repo name, or null when there is no list to check other lists against. Epochs are not shown, so not checked. */
function checkForks(forks, need) {
  if (!need(Array.isArray(forks) && forks.length > 0, "forks must be a non-empty list")) return null;
  const byRepo = new Map();
  forks.forEach((fork, i) => {
    const at = `forks[${i}]`;
    if (!need(isObject(fork), `${at} must be an object`)) return;
    if (need(isText(fork.repo), `${at}.repo must be a non-empty string`)) {
      need(!byRepo.has(fork.repo), `${at}.repo ${JSON.stringify(fork.repo)} appears twice`);
      byRepo.set(fork.repo, fork);
    }
    for (const key of ["before", "after"]) need(typeof fork[key] === "string" && FINGERPRINT.test(fork[key]), `${at}.${key} must be 8 lowercase hex characters`);
    need(isCount(fork.mismatches), `${at}.mismatches must be a whole number of 0 or more`);
  });
  return byRepo;
}

/** The attack ids, or null when there is no list of attacks. */
function checkAttacks(attacks, forks, need) {
  if (!need(Array.isArray(attacks) && attacks.length > 0, "attacks must be a non-empty list")) return null;
  const ids = new Set();
  attacks.forEach((attack, i) => {
    const at = `attacks[${i}]`;
    if (!need(isObject(attack), `${at} must be an object`)) return;
    if (need(ATTACK_IDS.includes(attack.id), `${at}.id must be one of ${ATTACK_IDS.join(", ")}, not ${JSON.stringify(attack.id) ?? "missing"}`)) {
      need(!ids.has(attack.id), `${at}.id ${JSON.stringify(attack.id)} appears twice`);
      ids.add(attack.id);
    }
    need(isText(attack.label), `${at}.label must be a non-empty string`);
    need(isText(attack.detail), `${at}.detail must be a non-empty string`);
    need(isCount(attack.tries), `${at}.tries must be a whole number of 0 or more`);
    const targets = checkRepos(attack.targets, `${at}.targets`, need, { forks });
    for (const [part, lists] of Object.entries(RESULT_LISTS)) {
      if (!need(isObject(attack[part]), `${at}.${part} must be an object`)) continue;
      for (const list of lists) checkRepos(attack[part][list], `${at}.${part}.${list}`, need, { forks, targets, targetsAt: `${at}.targets` });
    }
    if (forks && isObject(attack.platform) && isRepoList(attack.platform.rotated)) {
      for (const repo of new Set(attack.platform.rotated)) {
        const fork = forks.get(repo);
        if (fork) need(fork.after !== fork.before, `${at}.platform.rotated names ${JSON.stringify(repo)}, whose after fingerprint is the same as before`);
      }
    }
  });
  return ids;
}

function checkAfterRotation(after, ids, forks, need) {
  if (!need(isObject(after), "afterRotation must be an object")) return;
  if (need(after.attack === "A2", 'afterRotation.attack must be "A2"') && ids) need(ids.has("A2"), "afterRotation.attack names A2, which is not in attacks");
  for (const list of ["compromised", "refused"]) checkRepos(after[list], `afterRotation.${list}`, need, { forks });
}

/**
 * A list of repo names: none twice (it would be counted twice), each one a fork, and in an outcome list each one a
 * fork the attack targeted. Returns the names, or null when the value is not a list of names.
 */
function checkRepos(list, at, need, { forks, targets = null, targetsAt = "" }) {
  if (!need(isRepoList(list), `${at} must be a list of repo names`)) return null;
  const names = new Set();
  const repeated = new Set();
  for (const repo of list) {
    if (names.has(repo)) repeated.add(repo);
    names.add(repo);
  }
  for (const repo of repeated) need(false, `${at} names ${JSON.stringify(repo)} more than once`);
  for (const repo of names) {
    if (forks && !need(forks.has(repo), `${at} names ${JSON.stringify(repo)}, which is not in forks`)) continue;
    if (targets) need(targets.has(repo), `${at} names ${JSON.stringify(repo)}, which is not in ${targetsAt}`);
  }
  return names;
}

/** The recording from the file's text: `demo` is null when the text is not JSON or not in the shape above. */
export function parseDemo(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { demo: null, problems: [`the file is not JSON (${err.message})`] };
  }
  const problems = validateDemo(data);
  return { demo: problems.length ? null : data, problems };
}

/**
 * Fetches the recording at `url` with `fetchFn`: `{ demo, missing, problems }`. `missing` is true when there is no
 * file to read: an error status, a failed request, or an HTML page a server sent in its place. When `demo` is null,
 * `problems` says why.
 */
export async function readRecording(fetchFn, url) {
  try {
    const res = await fetchFn(url, { headers: { accept: "application/json" }, cache: "no-cache" });
    if (!res.ok) return { demo: null, missing: true, problems: [`HTTP ${res.status}`] };
    if (/text\/html/i.test(res.headers?.get("content-type") ?? "")) return { demo: null, missing: true, problems: ["an HTML page was sent in its place"] };
    return { missing: false, ...parseDemo(await res.text()) };
  } catch (err) {
    return { demo: null, missing: true, problems: [`the request failed: ${err.message}`] };
  }
}

/** What the page says without a recording to show, in three parts; the middle one is the command, shown as code. */
export function noRecordingMessage(missing) {
  return missing
    ? ["No recorded run yet. Record one with ", RECORD_COMMAND, ", then reload this page."]
    : ["The recorded run in data/polymorph-demo.json cannot be shown (the console says why). Record it again with ", RECORD_COMMAND, ", then reload this page."];
}

function findAttack(data, attackId) {
  const attack = data.attacks.find((a) => a.id === attackId);
  if (!attack) throw new Error(`the recording has no attack ${JSON.stringify(attackId)}`);
  return attack;
}

/**
 * What one fork's tile shows. With the switch off, forks run plain code (no
 * copy, so no fingerprint) and only `plain` counts; with it on, the platform's
 * results count. `moved` shows a rotated fork on its new copy.
 */
function tileFor(fork, attack, polymorphOn, moved) {
  if (!attack) return { state: "neutral", fingerprint: polymorphOn ? fork.before : null, note: "" };
  const has = (list) => list.includes(fork.repo);
  const result = polymorphOn ? attack.platform : attack.plain;
  // Compromised wins over refused: a fork in both lists was harmed, whatever else the platform did.
  const state = has(result.compromised) ? "compromised" : polymorphOn && has(attack.platform.refused) ? "refused" : "neutral";
  const word = state !== "neutral" ? state : has(attack.targets) ? "not compromised" : "not attacked";
  const newCopy = moved && polymorphOn && has(attack.platform.rotated);
  return {
    state,
    fingerprint: polymorphOn ? (newCopy ? fork.after : fork.before) : null,
    note: newCopy ? `${word}, new copy` : word,
  };
}

/** Each fork's tile at the end of an attack's animation, by repo; with no attack, the starting tiles. */
export function tileStates(data, attackId, polymorphOn) {
  const attack = attackId === null || attackId === undefined ? null : findAttack(data, attackId);
  return Object.fromEntries(data.forks.map((fork) => [fork.repo, tileFor(fork, attack, polymorphOn, true)]));
}

const spread = (i, count, ms) => (count > 1 ? Math.round((i * ms) / (count - 1)) : 0);

/**
 * The animation as steps in time order, `{ at, repo, tile }` with `at` in ms:
 * every fork is hit in fleet order, then each fork the platform moved shows
 * its new copy. Played from the starting tiles, it ends on tileStates.
 */
export function replaySteps(data, attackId, polymorphOn) {
  const attack = findAttack(data, attackId);
  const hits = data.forks.map((fork, i) => ({ at: spread(i, data.forks.length, HIT_MS), repo: fork.repo, tile: tileFor(fork, attack, polymorphOn, false) }));
  const movers = polymorphOn ? data.forks.filter((fork) => attack.platform.rotated.includes(fork.repo)) : [];
  const moves = movers.map((fork, i) => ({ at: MOVE_AT_MS + spread(i, movers.length, MOVE_MS), repo: fork.repo, tile: tileFor(fork, attack, true, true) }));
  return [...hits, ...moves];
}

/** The scoreboard's columns after the attack: the key in a scoreRows row, and the column's name. */
export const SCORE_COLUMNS = [
  ["sent", "Sent"],
  ["plain", "Plain fleet compromised"],
  ["direct", "Renamed copies compromised, platform scan bypassed"],
  ["compromised", "Compromised through the platform"],
  ["refused", "Refused by the platform"],
  ["rotated", "Moved to a new copy"],
];

/** One scoreboard row per attack: what was sent, then forks out of the fleet for each outcome. */
export function scoreRows(data) {
  const of = (list) => `${list.length} of ${data.forks.length}`;
  return data.attacks.map((a) => ({
    id: a.id,
    label: a.label,
    detail: a.detail,
    sent: `${plural(a.tries, "request")} to ${plural(a.targets.length, "fork")}`,
    plain: of(a.plain.compromised),
    direct: of(a.direct.compromised),
    compromised: of(a.platform.compromised),
    refused: of(a.platform.refused),
    rotated: of(a.platform.rotated),
  }));
}

/** "2026-11-06 at 18:30 UTC", the same in every time zone. */
function recordedText(iso) {
  const at = new Date(iso).toISOString();
  return `${at.slice(0, 10)} at ${at.slice(11, 16)} UTC`;
}

/** The three lines above the fleet: what it does, that this is a recorded run, and the limit. */
export function introLines(data) {
  const hasB = data.attacks.some((a) => a.id === "B");
  return [
    `Polymorphic installation renames the ${data.listSize} internal names on upstream's list with a secret seed for each fork.`,
    `This page replays a recorded run of the end-to-end test: ${plural(data.forks.length, "fork")} on release ${data.release}, recorded ${recordedText(data.recordedAt)}.`,
    `Renaming cannot stop a bug that public fields alone can reach${hasB ? ", as attack B shows" : ""}.`,
  ];
}

/** The status line once an attack has played. */
export function outcomeLine(data, attackId, polymorphOn) {
  const a = findAttack(data, attackId);
  const head = `Attack ${a.id} (${a.label}) with polymorphic installation ${polymorphOn ? "on" : "off"}`;
  const total = plural(data.forks.length, "fork");
  if (!polymorphOn) return `${head}: ${a.plain.compromised.length} of ${total} compromised.`;
  const p = a.platform;
  return `${head}: ${p.compromised.length} of ${total} compromised, ${p.refused.length} refused, ${p.rotated.length} moved to a new copy.`;
}

/** The line under the scoreboard about the leaked copy once its own fork moved; null without that part of the run. */
export function afterRotationLine(data) {
  const after = data.afterRotation;
  if (!after) return null;
  return `After the leaked copy's fork moved to a new copy, the leaked names compromised ${plural(after.compromised.length, "fork")} and were refused on ${plural(after.refused.length, "fork")}.`;
}

/** On how many forks the copy answered every probe like the plain fork, from each fork's mismatch count. */
export function equivalenceLine(data) {
  const total = data.forks.length;
  const differ = data.forks.filter((f) => f.mismatches > 0);
  const head = `Equivalence check: on ${total - differ.length} of ${plural(total, "fork")} the copy answered all ${data.probes} probes like the plain fork`;
  if (differ.length === 0) return `${head}, with 0 differences.`;
  return `${head}. Forks with differences: ${differ.map((f) => `${f.repo} (${f.mismatches})`).join(", ")}.`;
}

function startLine(polymorphOn) {
  return polymorphOn
    ? "Polymorphic installation is on: every fork runs its own copy. Pick an attack to replay it."
    : "Polymorphic installation is off: every fork runs upstream's plain code. Pick an attack to replay it.";
}

/**
 * The replay, apart from the page: paint(repo, tile) draws one tile, say(text) sets the status line, and clock
 * schedules the animation (tests use fake timers). reset() and play() first cancel whatever is still scheduled, and
 * stop() cancels it when the reader leaves the page. The clock calls the timer functions inside arrow functions,
 * since browsers refuse setTimeout called as a method of another object.
 */
export function replayer(data, { paint, say, clock = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) } }) {
  let timers = [];
  const stop = () => {
    for (const id of timers) clock.clear(id);
    timers = [];
  };
  const paintAll = (tiles) => {
    for (const [repo, tile] of Object.entries(tiles)) paint(repo, tile);
  };
  return {
    stop,
    /** Back to the starting tiles for the switch's position. */
    reset(polymorphOn) {
      stop();
      paintAll(tileStates(data, null, polymorphOn));
      say(startLine(polymorphOn));
    },
    /** One attack over about two seconds; with reduced motion, only its end state, at once. */
    play(attackId, polymorphOn, { reducedMotion = false } = {}) {
      stop();
      const done = outcomeLine(data, attackId, polymorphOn);
      if (reducedMotion) {
        paintAll(tileStates(data, attackId, polymorphOn));
        say(done);
        return;
      }
      paintAll(tileStates(data, null, polymorphOn));
      say(`Replaying attack ${attackId} with polymorphic installation ${polymorphOn ? "on" : "off"}...`);
      const steps = replaySteps(data, attackId, polymorphOn);
      for (const step of steps) timers.push(clock.set(() => paint(step.repo, step.tile), step.at));
      timers.push(clock.set(() => say(done), Math.max(...steps.map((s) => s.at)) + SETTLE_MS));
    },
  };
}

/**
 * Keeps only the latest load: start(show) runs load() and passes its result to show() unless start() or stop() came
 * again before it finished (the page rendered again, or the reader left it). start() returns the load's promise.
 */
export function latestOnly(load) {
  let latest = 0;
  return {
    async start(show) {
      const mine = ++latest;
      const result = await load();
      if (mine === latest) show(result);
    },
    stop() {
      latest += 1;
    },
  };
}

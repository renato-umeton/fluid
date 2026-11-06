// The Polymorph view's recorded run (data/polymorph-demo.json): checks its
// shape and turns it into tile states, the steps of the animation, and plain
// sentences. Every number comes from the recording; nothing here makes one
// up. No DOM here: views/polymorph.js builds the elements with h(). Pure, so
// it is unit tested.

export const ATTACK_IDS = ["A", "A2", "A3", "B"];
export const RECORD_COMMAND = "cd platform && npm run polymorph:record";

const RESULT_LISTS = { plain: ["compromised"], direct: ["compromised"], platform: ["compromised", "refused", "rotated"] };
const FINGERPRINT = /^[0-9a-f]{8}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
/** The animation: forks are hit one after another over HIT_MS, then refused forks move to their new copy. */
const HIT_MS = 1500;
const MOVE_AT_MS = 1800;
const MOVE_MS = 500;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim() !== "";
const isCount = (value) => Number.isInteger(value) && value >= 0;
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
  need(isText(data.recordedAt) && ISO_TIME.test(data.recordedAt) && Number.isFinite(Date.parse(data.recordedAt)), "recordedAt must be an ISO time");
  need(isText(data.release), "release must be a non-empty string");
  for (const key of ["listSize", "probes"]) need(isCount(data[key]), `${key} must be a whole number of 0 or more`);
  const repos = checkForks(data.forks, need);
  const ids = checkAttacks(data.attacks, repos, need);
  if (data.afterRotation !== undefined && data.afterRotation !== null) checkAfterRotation(data.afterRotation, ids, repos, need);
  return problems;
}

/** The repo names, or null when there is no list to check other lists against. */
function checkForks(forks, need) {
  if (!need(Array.isArray(forks) && forks.length > 0, "forks must be a non-empty list")) return null;
  const repos = new Set();
  forks.forEach((fork, i) => {
    const at = `forks[${i}]`;
    if (!need(isObject(fork), `${at} must be an object`)) return;
    if (need(isText(fork.repo), `${at}.repo must be a non-empty string`)) {
      need(!repos.has(fork.repo), `${at}.repo ${JSON.stringify(fork.repo)} appears twice`);
      repos.add(fork.repo);
    }
    for (const key of ["before", "after"]) need(typeof fork[key] === "string" && FINGERPRINT.test(fork[key]), `${at}.${key} must be 8 lowercase hex characters`);
    for (const key of ["epochBefore", "epochAfter", "mismatches"]) need(isCount(fork[key]), `${at}.${key} must be a whole number of 0 or more`);
  });
  return repos;
}

/** The attack ids, or null when there is no list of attacks. */
function checkAttacks(attacks, repos, need) {
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
    checkRepos(attack.targets, `${at}.targets`, repos, need);
    for (const [part, lists] of Object.entries(RESULT_LISTS)) {
      if (!need(isObject(attack[part]), `${at}.${part} must be an object`)) continue;
      for (const list of lists) checkRepos(attack[part][list], `${at}.${part}.${list}`, repos, need);
    }
  });
  return ids;
}

function checkAfterRotation(after, ids, repos, need) {
  if (!need(isObject(after), "afterRotation must be an object")) return;
  if (need(after.attack === "A2", 'afterRotation.attack must be "A2"') && ids) need(ids.has("A2"), "afterRotation.attack names A2, which is not in attacks");
  for (const list of ["compromised", "refused"]) checkRepos(after[list], `afterRotation.${list}`, repos, need);
}

function checkRepos(list, at, repos, need) {
  if (!need(Array.isArray(list) && list.every((repo) => typeof repo === "string"), `${at} must be a list of repo names`) || !repos) return;
  for (const repo of list) need(repos.has(repo), `${at} names ${JSON.stringify(repo)}, which is not in forks`);
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

/** How many copies answered every probe like the plain fork, from each fork's mismatch count. */
export function equivalenceLine(data) {
  const total = data.forks.length;
  const differ = data.forks.filter((f) => f.mismatches > 0);
  const same = total - differ.length;
  if (differ.length === 0) return `Equivalence check: every copy answered all ${data.probes} probes like the plain fork (${same} of ${total} copies had 0 differences).`;
  return `Equivalence check: ${same} of ${total} copies answered all ${data.probes} probes like the plain fork with 0 differences. Copies with differences: ${differ.map((f) => `${f.repo} (${f.mismatches})`).join(", ")}.`;
}

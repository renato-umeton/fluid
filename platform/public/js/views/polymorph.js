// Polymorph: replays a recorded end-to-end run of polymorphic installation.
// Every fork runs its own renamed copy of upstream's internal names; an attack
// button shows what the recording says happened to each fork, on the plain
// fleet (switch off) or through the platform (switch on). Everything shown
// comes from data/polymorph-demo.json through ../polymorph-replay.js; with no
// valid recording the page says so and shows no numbers. Built with h() only,
// and every tile state is written out, never shown by color alone.
import { h, mount } from "../dom.js";
import { RECORD_COMMAND, afterRotationLine, equivalenceLine, introLines, outcomeLine, parseDemo, replaySteps, scoreRows, tileStates } from "../polymorph-replay.js";

export const title = "Polymorphic installation";
export const sub = "Every fork runs its own renamed copy of upstream's code.";
/** The recording sits next to the page (platform/public/data), served the same way in mock and live mode. */
export const DATA_URL = new URL("../../data/polymorph-demo.json", import.meta.url);

/** Scoreboard columns after the attack: the key in a scoreRows row, and its name. */
export const SCORE_COLUMNS = [
  ["sent", "Sent"],
  ["plain", "Plain fleet compromised"],
  ["direct", "Renamed copies compromised, platform scan bypassed"],
  ["compromised", "Compromised through the platform"],
  ["refused", "Refused by the platform"],
  ["rotated", "Moved to a new copy"],
];
/** The summary replaces "Replaying..." a moment after the last tile changes. */
const SETTLE_MS = 150;

let polymorphOn = true;
let current = null;
let loads = 0;
let timers = [];

export async function render(root) {
  leave();
  const load = ++loads;
  mount(root, h("p", { class: "muted" }, "Loading the recorded run..."));
  const demo = await loadDemo();
  if (load !== loads) return;
  if (!demo) {
    mount(root, h("p", { class: "empty" }, "No recorded run yet. Record one with ", h("code", {}, RECORD_COMMAND), ", then reload this page."));
    return;
  }
  layout(root, demo);
}

export function leave() {
  loads += 1;
  stopReplay();
}

/** The recording, or null when the file is missing or cannot be shown; the console says which. */
async function loadDemo() {
  try {
    const res = await fetch(DATA_URL, { headers: { accept: "application/json" }, cache: "no-cache" });
    if (!res.ok) {
      console.info(`Fluid: no polymorph recording at ${DATA_URL.pathname} (HTTP ${res.status}).`);
      return null;
    }
    const { demo, problems } = parseDemo(await res.text());
    if (!demo) console.warn(`Fluid: the polymorph recording at ${DATA_URL.pathname} cannot be shown: ${problems.join("; ")}`);
    return demo;
  } catch (err) {
    console.warn(`Fluid: could not read the polymorph recording (${err.message}).`);
    return null;
  }
}

function layout(root, demo) {
  const tiles = new Map();
  const fleet = h("ul", { class: "polymorph-fleet", "aria-labelledby": "polymorph-fleet-heading" }, demo.forks.map((fork) => {
    const tile = { fork, fp: h("span", { class: "polymorph-fp" }), note: h("span", { class: "polymorph-note" }) };
    tile.li = h("li", { class: "polymorph-tile" }, h("code", {}, fork.repo), tile.fp, tile.note);
    tiles.set(fork.repo, tile);
    return tile.li;
  }));
  const status = h("p", { class: "small", role: "status" });
  const switchWord = h("span", { class: "muted", "aria-hidden": "true" });
  const toggle = h("input", { type: "checkbox", role: "switch", id: "polymorph-switch", checked: polymorphOn, onchange: (e) => { polymorphOn = e.target.checked; reset(); } });
  const afterLine = afterRotationLine(demo);
  const rows = scoreRows(demo);
  current = { demo, tiles, status, switchWord };
  reset();
  mount(root, h("div", { class: "polymorph" },
    h("div", { class: "polymorph-intro" }, introLines(demo).map((line) => h("p", {}, line))),
    h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("div", {}, h("h2", { id: "polymorph-fleet-heading" }, "Fleet"), h("p", {}, "One tile per fork: its repo, the copy it runs, and what the attack did to it."))),
      h("div", { class: "panel-body stack" },
        fleet,
        h("label", { class: "row small", for: "polymorph-switch" }, toggle, h("strong", {}, "Polymorphic installation"), switchWord),
        h("div", { class: "row", role: "group", "aria-label": "Replay the recorded attacks" },
          demo.attacks.map((a) => h("button", { type: "button", class: "btn", title: a.detail, onclick: () => play(a.id) }, attackName(a))),
          h("button", { type: "button", class: "btn", onclick: reset }, "Reset")),
        status)),
    h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("div", {}, h("h2", { id: "polymorph-score-heading" }, "Scoreboard"), h("p", {}, `Each count is forks out of the ${demo.forks.length} in the recorded run.`))),
      h("div", { class: "panel-body stack polymorph-scoreboard" },
        scoreTable(rows),
        scoreList(rows),
        afterLine ? h("p", { class: "small" }, afterLine) : null,
        h("p", { class: "small" }, equivalenceLine(demo))))));
}

/** "Attack A: label", the same on the buttons and in the scoreboard. */
function attackName(attack) {
  return [h("strong", {}, `Attack ${attack.id}:`), " ", attack.label];
}

function scoreTable(rows) {
  return h("div", { class: "table-wrap polymorph-score-wide" },
    h("table", { class: "data polymorph-score" },
      h("caption", { class: "visually-hidden" }, "Scoreboard: one row per attack, with the forks it compromised on the plain fleet, on renamed copies with the platform scan bypassed, and through the platform"),
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Attack"), SCORE_COLUMNS.map(([, name]) => h("th", { scope: "col" }, name)))),
      h("tbody", {}, rows.map((r) => h("tr", {},
        h("th", { scope: "row" }, attackName(r), h("div", { class: "xsmall muted" }, r.detail)),
        SCORE_COLUMNS.map(([key]) => h("td", {}, r[key])))))));
}

/** The same rows where seven columns do not fit (styles.css shows one or the other by the scoreboard's width): one short list per attack. */
function scoreList(rows) {
  return h("ul", { class: "polymorph-score-narrow", "aria-labelledby": "polymorph-score-heading" }, rows.map((r) => h("li", {},
    h("p", {}, attackName(r)),
    h("p", { class: "xsmall muted" }, r.detail),
    h("dl", {}, SCORE_COLUMNS.map(([key, name]) => h("div", {}, h("dt", {}, name), h("dd", {}, r[key])))))));
}

/** Back to the starting tiles for the switch's position. */
function reset() {
  stopReplay();
  current.switchWord.textContent = polymorphOn ? "on" : "off";
  paintAll(tileStates(current.demo, null, polymorphOn));
  current.status.textContent = polymorphOn
    ? "Polymorphic installation is on: every fork runs its own copy. Pick an attack to replay it."
    : "Polymorphic installation is off: every fork runs upstream's plain code. Pick an attack to replay it.";
}

/** Replays one attack over about two seconds, or at once when the reader prefers reduced motion. */
function play(attackId) {
  stopReplay();
  const { demo, tiles, status } = current;
  const done = outcomeLine(demo, attackId, polymorphOn);
  paintAll(tileStates(demo, null, polymorphOn));
  if (prefersReducedMotion()) {
    paintAll(tileStates(demo, attackId, polymorphOn));
    status.textContent = done;
    return;
  }
  status.textContent = `Replaying attack ${attackId} with polymorphic installation ${polymorphOn ? "on" : "off"}...`;
  const steps = replaySteps(demo, attackId, polymorphOn);
  for (const step of steps) timers.push(setTimeout(() => paintTile(tiles.get(step.repo), step.tile), step.at));
  timers.push(setTimeout(() => { status.textContent = done; }, Math.max(...steps.map((s) => s.at)) + SETTLE_MS));
}

function prefersReducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function stopReplay() {
  for (const timer of timers) clearTimeout(timer);
  timers = [];
}

function paintAll(states) {
  for (const [repo, state] of Object.entries(states)) paintTile(current.tiles.get(repo), state);
}

function paintTile(tile, { state, fingerprint, note }) {
  tile.li.dataset.state = state;
  tile.li.dataset.moved = fingerprint !== null && fingerprint !== tile.fork.before ? "yes" : "no";
  tile.fp.textContent = fingerprint === null ? "plain code" : `copy ${fingerprint}`;
  tile.note.textContent = note;
}

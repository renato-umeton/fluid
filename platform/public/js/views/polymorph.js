// Polymorph: replays a recorded end-to-end run of polymorphic installation.
// Every fork runs its own renamed copy of upstream's internal names; an attack
// button shows what the recording says happened to each fork, on the plain
// fleet (switch off) or through the platform (switch on). Everything shown
// comes from data/polymorph-demo.json through ../polymorph-replay.js, which
// also runs the replay; this file only builds the page and wires it up. With
// no valid recording the page says so and shows no numbers. Built with h()
// only, and every tile state is written out, never shown by color alone.
import { h, mount } from "../dom.js";
import { SCORE_COLUMNS, afterRotationLine, equivalenceLine, introLines, latestOnly, noRecordingMessage, readRecording, replayer, scoreRows } from "../polymorph-replay.js";

export const title = "Polymorph";
export const sub = "Every fork runs its own renamed copy of upstream's code.";
/** The recording sits next to the page (platform/public/data), served the same way in mock and live mode. */
export const DATA_URL = new URL("../../data/polymorph-demo.json", import.meta.url);

let polymorphOn = true;
/** The replay on the page, or null before a recording is shown. */
let replay = null;
/** Only the latest render shows its recording, so a slow load never replaces a newer page. */
const loads = latestOnly(load);

export function render(root) {
  leave();
  mount(root, h("p", { class: "muted" }, "Loading the recorded run..."));
  return loads.start(({ demo, missing }) => {
    if (demo) {
      layout(root, demo);
      return;
    }
    const [lead, command, end] = noRecordingMessage(missing);
    mount(root, h("p", { class: "empty" }, lead, h("code", {}, command), end));
  });
}

export function leave() {
  loads.stop();
  replay?.stop();
}

/** Reads the recording; when there is none to show, the console says why. */
async function load() {
  const result = await readRecording(fetch, DATA_URL);
  const why = result.problems.join("; ");
  if (result.missing) console.info(`Fluid: no polymorph recording at ${DATA_URL.pathname} (${why}).`);
  else if (!result.demo) console.warn(`Fluid: the polymorph recording at ${DATA_URL.pathname} cannot be shown: ${why}`);
  return result;
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
  const controller = replayer(demo, {
    paint: (repo, state) => paintTile(tiles.get(repo), state),
    say: (text) => { status.textContent = text; },
  });
  const switchWord = h("span", { class: "muted", "aria-hidden": "true" }, polymorphOn ? "on" : "off");
  const toggle = h("input", { type: "checkbox", role: "switch", id: "polymorph-switch", checked: polymorphOn, onchange: (e) => {
    polymorphOn = e.target.checked;
    switchWord.textContent = polymorphOn ? "on" : "off";
    controller.reset(polymorphOn);
  } });
  const afterLine = afterRotationLine(demo);
  const rows = scoreRows(demo);
  replay = controller;
  controller.reset(polymorphOn);
  mount(root, h("div", { class: "polymorph" },
    h("div", { class: "polymorph-intro" }, introLines(demo).map((line) => h("p", {}, line))),
    h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("div", {}, h("h2", { id: "polymorph-fleet-heading" }, "Fleet"), h("p", {}, "One tile per fork: its repo, the copy it runs, and what the attack did to it."))),
      h("div", { class: "panel-body stack" },
        fleet,
        h("label", { class: "row small", for: "polymorph-switch" }, toggle, h("strong", {}, "Polymorphic installation"), switchWord),
        h("div", { class: "row", role: "group", "aria-label": "Replay the recorded attacks" },
          demo.attacks.map((a) => h("button", { type: "button", class: "btn", title: a.detail, onclick: () => controller.play(a.id, polymorphOn, { reducedMotion: prefersReducedMotion() }) }, attackName(a))),
          h("button", { type: "button", class: "btn", onclick: () => controller.reset(polymorphOn) }, "Reset")),
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

function prefersReducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function paintTile(tile, { state, fingerprint, note }) {
  tile.li.dataset.state = state;
  tile.li.dataset.moved = fingerprint !== null && fingerprint !== tile.fork.before ? "yes" : "no";
  tile.fp.textContent = fingerprint === null ? "plain code" : `copy ${fingerprint}`;
  tile.note.textContent = note;
}

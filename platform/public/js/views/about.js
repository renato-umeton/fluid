// About: the tagline, the four ideas, the proving ground, and how they map onto Cloudflare primitives.
import { h, mount } from "../dom.js";

export const title = "About Fluid";
export const sub = "What the next Git platform looks like when every person gets their own fork.";

const TAGLINE = "Everyone gets their own fork. Behavior decides what ships.";

const IDEAS = [
  {
    name: "Behavior is the merge rule",
    text: "A change reaches main only when upstream's tests pass, your own tests pass, and a live soak stays clean. When several agents try the same wish, a behavior diff against main and a fixed rule pick the winner.",
    where: "See it in Customize, Contest, and the yellow badge.",
  },
  {
    name: "Living forks",
    text: "Every person's fork keeps changing. They reshape it in plain words or with their own agent over plain git. On each release, intent replay grants each recipe wish again on the new upstream code; other changes upgrade by merge, and the gate still decides.",
    where: "See it in My fork, Customize, and Fleet.",
  },
  {
    name: "Git is the audit log for what software says",
    text: "Every wish records why it exists in an intent record next to the code. Every answer records the fork commit and the upstream tag that produced it, and the soak checks that link.",
    where: "See it on every answer card and in both ledgers.",
  },
  {
    name: "Every commit runs",
    text: "Any fork at any commit loads into its own isolate, with no build queue and no network. The tests run in a second isolate built only from upstream files, so a fork cannot grade itself.",
    where: "See it in Fleet when a release fans out.",
  },
];

const MAPPING = [
  ["Upstream repo, forks, ledgers", "Artifacts repositories in one namespace with US jurisdiction"],
  ["Fork provisioning, reading upstream tests at a tag", "Artifacts binding in Workers: get, fork, readFile, repo-scoped tokens"],
  ["Reacting to pushes and releases", "Artifacts event subscriptions delivered to Queues"],
  ["Gate, customize, contest, upgrade, repair, harvest", "Workflows"],
  ["Per-fork runtime and test targets", "Worker Loader runs each fork's code at any ref; Workers Builds with previews is the production path"],
  ["Run-time ledger buffer, fleet state", "Durable Objects"],
  ["Model calls with logging and routing", "Workers AI behind AI Gateway"],
  ["Fleet health", "Artifacts metrics and the fleet event stream"],
];

export function render(root) {
  mount(root, h("div", { class: "about" },
    h("p", { class: "about-lead" }, TAGLINE),
    h("div", { class: "proposals" }, IDEAS.map((p) => h("section", { class: "proposal" },
      h("h2", {}, p.name), h("p", {}, p.text), h("span", { class: "where" }, p.where)))),
    h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", {}, "Proving ground: academic medicine")),
      h("div", { class: "panel-body stack" },
        h("p", {}, "We picked the domain where a wrong merge can hurt someone. A physician rounds in the morning, writes a paper in the afternoon, and reviews a budget in between. The same question has a different right answer in each role."),
        h("p", {}, "Fluid makes the answer depend on intent, shows why, lets the user override it, and keeps upstream's safety floor out of reach of any customization. Nothing in the platform idea is medical."))),
    h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", {}, "Built on Cloudflare")),
      h("div", { class: "panel-body table-wrap" }, h("table", { class: "data" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Need"), h("th", { scope: "col" }, "Primitive"))),
        h("tbody", {}, MAPPING.map(([need, prim]) => h("tr", {}, h("td", {}, need), h("td", {}, prim))))))),
    h("p", { class: "small muted" }, "Prototype. All data is synthetic: fictional patients, people, drugs, prices, and guidelines. Clinical mode never computes a patient-specific dose. Not for clinical use."),
  ));
}

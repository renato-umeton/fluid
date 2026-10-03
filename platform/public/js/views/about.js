// About: the three proposals and how they map onto Cloudflare primitives.
import { h, mount } from "../dom.js";

export const title = "About Fluid";
export const sub = "What the next Git platform looks like when every person gets their own fork.";

const PROPOSALS = [
  {
    name: "A fork for every person",
    text: "The central informatics team ships a stock release. Every user gets an Artifacts repository forked from it and customizes it with their own agent. Each fork deploys as that user's own Worker.",
    where: "See it in My fork and the persona switcher.",
  },
  {
    name: "Intent as version-controlled data",
    text: "Every change carries a build-time record of why it exists, linked from the commit. Every answer carries a run-time record of the role the user was in, the signals, and any override.",
    where: "See it on every answer card and in both ledgers.",
  },
  {
    name: "Behavioral regression as the merge rule",
    text: "A fork merges or upgrades only when it passes the stock invariants and functional tests at its pinned tag, plus its own tests. Above that floor, customization is the user's call.",
    where: "See it in Customize and Fleet.",
  },
];

const MAPPING = [
  ["Stock repo, forks, ledgers", "Artifacts repositories in one namespace with US jurisdiction"],
  ["Fork provisioning, reading stock tests at a tag", "Artifacts binding in Workers: get, fork, readFile, repo-scoped tokens"],
  ["Reacting to pushes and releases", "Artifacts event subscriptions delivered to Queues"],
  ["Gate, customize, upgrade, repair, harvest", "Workflows"],
  ["Per-fork runtime and test targets", "Worker Loader runs each fork's code at any ref; Workers Builds with previews is the production path"],
  ["Run-time ledger buffer, fleet state", "Durable Objects"],
  ["Model calls with logging and routing", "Workers AI behind AI Gateway"],
  ["Fleet health", "Artifacts metrics and the fleet event stream"],
];

export function render(root) {
  mount(root, h("div", { class: "about" },
    h("p", { class: "about-lead" }, "A physician rounds in the morning, writes a paper at lunch, and reviews a budget in the afternoon. The same question has three right answers. Fluid makes the answer depend on intent, makes intent visible and overridable, and makes the safety floor impossible to customize away."),
    h("div", { class: "proposals" }, PROPOSALS.map((p) => h("section", { class: "proposal" },
      h("h2", {}, p.name), h("p", {}, p.text), h("span", { class: "where" }, p.where)))),
    h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", {}, "Built on Cloudflare")),
      h("div", { class: "panel-body table-wrap" }, h("table", { class: "data" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Need"), h("th", { scope: "col" }, "Primitive"))),
        h("tbody", {}, MAPPING.map(([need, prim]) => h("tr", {}, h("td", {}, need), h("td", {}, prim))))))),
    h("p", { class: "small muted" }, "Prototype. All data is synthetic: fictional patients, people, drugs, prices, and guidelines. Clinical mode never computes a patient-specific dose. Not for clinical use."),
  ));
}

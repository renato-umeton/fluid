// Text for the Contest screen. Every state is spelled out in words, so the
// screen never relies on color alone. No DOM here: views/contest.js builds
// the elements with h().

const RESULT = { true: "pass", false: "fail", null: "not run" };

export function resultText(passed) {
  return RESULT[String(passed ?? null)] ?? "not run";
}

/** What a behavior diff cell says: the probe's result and whether the answer changed from main's. */
export function cellView(cell) {
  if (!cell) return { state: "missing", text: "not run", label: "not run" };
  const result = resultText(cell.passed);
  if (cell.missing) return { state: "missing", text: "not run (probe removed)", label: "not run: this contestant no longer runs the probe" };
  if (!cell.changed) return { state: "same", text: `${result}, same as main`, label: `${result}, same answer as main` };
  const fields = cell.total ? `${cell.total} field${cell.total === 1 ? "" : "s"}` : "result only";
  const where = scopeText(cell.scope);
  return { state: cell.scope ?? "outside", text: `${result}, changed (${fields})`, label: `${result}, answer changed from main (${fields}), ${where}` };
}

export function scopeText(scope) {
  if (scope === "wish") return "a wish test";
  if (scope === "target") return "wording in a mode the wish targets";
  return "outside the wish";
}

const show = (value) => {
  const text = typeof value === "string" ? `"${value}"` : JSON.stringify(value);
  return text === undefined ? "nothing" : text.length > 160 ? `${text.slice(0, 157)}...` : text;
};

/** One field change in plain words. */
export function changeLine(change) {
  if (change.kind === "added") return `${change.path} added: ${show(change.after)}`;
  if (change.kind === "removed") return `${change.path} removed (was ${show(change.before)})`;
  return `${change.path} changed from ${show(change.before)} to ${show(change.after)}`;
}

/** Tier results of a contestant's check gate, as short lines. */
export function tierLines(gate) {
  const names = [["invariant", "Tier 1 invariants"], ["functional", "Tier 2 functional"], ["user", "Tier 3 your tests"]];
  return names.map(([key, name]) => {
    const t = gate?.tiers?.[key];
    if (!t) return { name, state: "pending", text: "not run yet" };
    const passed = t.total - t.failed;
    return { name, state: t.passed ? "pass" : "fail", text: t.total === 0 ? "nothing to run" : `${t.passed ? "pass" : "fail"}: ${passed} of ${t.total}` };
  });
}

const STATUS = {
  queued: "Queued",
  planning: "Planning",
  ready: "Branch ready",
  checking: "Checking",
  evaluated: "Checked",
  joined: "Joined",
  "no change": "No change",
  "waiting for your push": "Waiting for your push",
};

export function statusText(status) {
  return STATUS[status] ?? String(status ?? "Queued");
}

/** "Join window: 4:05 left" until it closes. */
export function joinCountdown(joinUntil, now = Date.now()) {
  const left = Math.max(0, Math.floor((Date.parse(joinUntil) - now) / 1000));
  if (!Number.isFinite(left) || left <= 0) return "Join window closed";
  return `Join window: ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`;
}

export function isFinalContest(run) {
  return Boolean(run) && ["passed", "failed", "cancelled"].includes(run.status) && run.yellow?.health !== "yellow";
}

/** Contestants the owner may ship now: those that passed rule (a), while the contest waits for a pick. */
export function shipChoices(run) {
  if (!run || run.status !== "waiting" || run.picked || run.pickRequested) return [];
  return (run.verdict?.ranking ?? []).filter((r) => r.eligible).map((r) => r.label);
}

/** Counts shown under a contestant's column. */
export function countsLine(c) {
  const parts = [];
  if (c.wish) parts.push(`wish tests ${c.wish.passed} of ${c.wish.total}`);
  if (typeof c.outside === "number") parts.push(`${c.outside} change${c.outside === 1 ? "" : "s"} outside the wish`);
  if (Array.isArray(c.files)) parts.push(`${c.files.length} file${c.files.length === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/** Seconds with one decimal for latency. */
export function seconds(ms) {
  return typeof ms === "number" ? `${(ms / 1000).toFixed(1)} s` : "";
}

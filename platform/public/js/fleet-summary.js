// One-line status summary for a fork in the Fleet view's Fork detail. Pure, so it is unit tested.

/** True when the fork's last failure came from a work branch (a customization), not an upgrade. */
function failedOnWorkBranch(f) {
  const branch = f.lastRun?.failedBranch;
  return typeof branch === "string" && branch.startsWith("work/");
}

export function forkSummaryText(f, latestTag, hasRun) {
  const tag = f.lastRun?.tag || latestTag;
  if ((f.status === "repair_open" || f.status === "failed") && failedOnWorkBranch(f)) {
    const opened = f.status === "repair_open" ? "A repair branch is open for review" : "The repair agent is reading the fork's intent records";
    return `A change on ${f.lastRun.failedBranch} failed the gate. ${opened}; main is unchanged and stays pinned to ${f.pinnedTag}.`;
  }
  const text = {
    pinned: `On ${f.pinnedTag}. No upgrade running.`,
    upgrading: `Upgrade agent is merging stock ${tag} into upgrade/${tag}.`,
    gating: `The gate is running all three tiers on upgrade/${tag}, with tiers 1 and 2 read at ${tag}.`,
    passed: f.lastRun?.applied === false ? `Upgrade to ${tag} passed all three tiers. Waiting for the user's one-tap approval (auto_upgrade is off).` : `Upgrade to ${tag} passed all three tiers and was applied.`,
    failed: hasRun ? `Upgrade to ${tag} failed the gate. The fork stays pinned to ${f.pinnedTag}.` : `Upgrade to ${tag} failed the gate. The repair agent is reading the fork's intent records.`,
    repair_open: `Upgrade to ${tag} failed the gate. A repair branch is open for review; the fork stays pinned to ${f.pinnedTag}.`,
  }[f.status];
  return text || f.status;
}

/** One line about the fork's fleet baseline (a dry run of the end-to-end suite on main), or null when it has none. */
export function baselineText(f) {
  const b = f.baseline;
  if (!b) return null;
  const at = `main at ${String(b.commit ?? "").slice(0, 7)}`;
  if (b.passed) return `Baseline: the end-to-end suite passed on ${at}${b.stockTag ? ` (stock ${b.stockTag})` : ""}.`;
  const what = b.failure ? `${b.failure.tier} scenario ${b.failure.scenario} failed${b.failure.step ? ` at step ${b.failure.step}` : ""} (${b.failure.detail})` : "the end-to-end suite failed";
  return `Baseline flagged: ${what} on ${at}. Nothing was rolled back; review the fork.`;
}

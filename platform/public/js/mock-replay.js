// Mock mode's intent replay: which forks a mock release rebuilds by replaying
// their wishes, and the per-wish results it shows. It mirrors the platform's
// rule (platform/src/agents/replay.ts): replay only when every wish is
// replayable; any model change sends the fork down the merge path. Pure, so
// it is unit tested.

const MODEL_REASON = "written by the agent model, so it cannot be run again exactly; this fork upgrades by merge";

/** The replay summary a mock upgrade records for a fork's customizations, or null for a fork with no wishes. */
export function mockReplayPlan(customizations, catalog, tag) {
  if (!customizations.length) return null;
  const wishes = customizations.map((c) => {
    const k = catalog.find((x) => x.key === c.key);
    const base = { intentId: c.record.id, request: c.record.request };
    return k?.replay
      ? { ...base, status: "replayed", kind: k.replay, reason: k.replayReason, stockAlsoChanged: k.sameLine ? ["app/cards.ts"] : [] }
      : { ...base, status: "fallback", kind: "model", reason: MODEL_REASON, stockAlsoChanged: [] };
  });
  const fallback = wishes.filter((w) => w.status === "fallback");
  if (fallback.length === 0) return { tag, path: "replay", carried: wishes.length, total: wishes.length, wishes };
  return {
    tag, path: "merge", carried: 0, total: wishes.length,
    reason: `${wishes.length - fallback.length} of ${wishes.length} wishes can be replayed; ${fallback.map((w) => w.intentId).join(", ")} cannot, so this fork upgrades by merge`,
    wishes,
  };
}

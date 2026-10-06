// The contest winner rule for mock mode: a copy of platform/src/contest/winner.ts
// (test/ui-contest.test.ts checks that both pick the same winner with the
// same words). (a) every tier and every wish test passed; (b) fewest
// behavior changes outside the wish; (c) fewest files changed; (d) earliest
// finished, then lineup order. Tests only one contestant ran ("own" cells in the
// behavior diff) are not counted in outsideChanges, so they never cost a point.

export function eligibility(e) {
  if (!e.ready) return { eligible: false, why: `it could not produce a change${e.problem ? ` (${e.problem})` : ""}` };
  if (!e.gatePassed) return { eligible: false, why: `it failed the gate${e.firstFailure ? `: ${e.firstFailure}` : ""}` };
  if (e.wishTotal === 0) return { eligible: false, why: "no wish test ran, so nothing shows the wish was granted" };
  if (e.wishPassed < e.wishTotal) return { eligible: false, why: `wish test ${e.failingWish[0] ?? "(unknown)"} failed` };
  return { eligible: true, why: "it passed every tier and every wish test" };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function compare(a, b, order) {
  if (a.outsideChanges !== b.outsideChanges) return a.outsideChanges - b.outsideChanges;
  if (a.filesChanged !== b.filesChanged) return a.filesChanged - b.filesChanged;
  const ta = a.finishedAt ?? "￿";
  const tb = b.finishedAt ?? "￿";
  if (ta !== tb) return ta < tb ? -1 : 1;
  return order.get(a.label) - order.get(b.label);
}

function lossBecause(winner, loser) {
  if (winner.outsideChanges !== loser.outsideChanges) return `it changed behavior on ${plural(loser.outsideChanges, "probe")} outside the wish (${winner.label}: ${winner.outsideChanges})`;
  if (winner.filesChanged !== loser.filesChanged) return `it changed ${plural(loser.filesChanged, "file")} (${winner.label}: ${winner.filesChanged})`;
  if ((winner.finishedAt ?? "") !== (loser.finishedAt ?? "")) return `it finished later (${winner.label} finished first)`;
  return "it tied on every rule and comes later in the lineup";
}

function winReason(winner, runnerUp) {
  if (!runnerUp) return `${winner.label} wins: it is the only contestant that passed every tier and every wish test.`;
  const lead = `${winner.label} wins: like ${runnerUp.label}, it passed every tier and every wish test, and it`;
  if (winner.outsideChanges !== runnerUp.outsideChanges) return `${lead} changed behavior on ${plural(winner.outsideChanges, "probe")} outside the wish (${runnerUp.label}: ${runnerUp.outsideChanges}).`;
  const same = `${lead} tied on behavior outside the wish (${plural(winner.outsideChanges, "probe")})`;
  if (winner.filesChanged !== runnerUp.filesChanged) return `${same} and changed ${plural(winner.filesChanged, "file")} (${runnerUp.label}: ${runnerUp.filesChanged}).`;
  if ((winner.finishedAt ?? "") !== (runnerUp.finishedAt ?? "")) return `${same}, changed the same number of files (${winner.filesChanged}), and finished first.`;
  return `${same}, changed the same number of files (${winner.filesChanged}), finished at the same time, and comes first in the lineup.`;
}

function notesFor(judged, winner, eligibleLoss) {
  const notes = {};
  for (const j of judged) {
    if (j.e.label === winner.label) continue;
    notes[j.e.label] = `lost to ${winner.label} because ${j.eligible ? eligibleLoss(j.e) : j.why}`;
  }
  return notes;
}

export function decideWinner(entrants) {
  const order = new Map(entrants.map((e, i) => [e.label, i]));
  const judged = entrants.map((e) => ({ e, ...eligibility(e) }));
  const eligible = judged.filter((j) => j.eligible).map((j) => j.e).sort((a, b) => compare(a, b, order));
  const ranking = [...eligible.map((e) => ({ label: e.label, eligible: true, why: "it passed every tier and every wish test" })), ...judged.filter((j) => !j.eligible).map((j) => ({ label: j.e.label, eligible: false, why: j.why }))];
  const winner = eligible[0] ?? null;
  if (!winner) {
    return { winner: null, reason: "No winner: no contestant passed every tier and every wish test. Nothing ships; every branch stays for you to look at.", ranking, notes: Object.fromEntries(judged.map((j) => [j.e.label, `did not win because ${j.why}`])) };
  }
  return { winner: winner.label, reason: winReason(winner, eligible[1] ?? null), ranking, notes: notesFor(judged, winner, (loser) => lossBecause(winner, loser)) };
}

export function pickNotes(entrants, label) {
  const picked = entrants.find((e) => e.label === label);
  if (!picked) return { ok: false, error: `no contestant ${label} in this contest` };
  const check = eligibility(picked);
  if (!check.eligible) return { ok: false, error: `${label} cannot ship: ${check.why}` };
  const verdict = decideWinner(entrants);
  if (verdict.winner === label) return { ok: true, reason: verdict.reason, notes: verdict.notes };
  const judged = entrants.map((e) => ({ e, ...eligibility(e) }));
  const order = new Map(entrants.map((e, i) => [e.label, i]));
  const notes = notesFor(judged, picked, (loser) => (loser.label === verdict.winner ? `you picked ${label} (the rule chose ${verdict.winner})` : compare(picked, loser, order) < 0 ? lossBecause(picked, loser) : `you picked ${label}`));
  return { ok: true, reason: `You picked ${label} over the rule's choice, ${verdict.winner}.`, notes };
}

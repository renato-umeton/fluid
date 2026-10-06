// Text helpers for the "Connect your own agent" panel in My fork. Pure, so they are unit tested.

/** Whole seconds until the token expires (0 once expired or when the date is invalid). */
export function secondsLeft(expiresAt, now = Date.now()) {
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.floor((at - now) / 1000));
}

export function expiryText(expiresAt, now = Date.now()) {
  const left = secondsLeft(expiresAt, now);
  if (left === 0) return "Expired. Get a new token to push again.";
  return `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

/** A command as shown on screen: the token's secret is hidden; Copy still copies the real command. */
export function maskCommand(command) {
  return String(command).replace(/(art_v\d+_)[A-Za-z0-9_-]+/g, "$1****");
}

const NOTE_TAGS = {
  imported: { tag: "Imported", state: "pass" },
  refused: { tag: "Refused", state: "fail" },
  "not joined": { tag: "Not in the contest", state: "warn" },
};

/** One import outcome from GET /api/forks/:repo/imports, as a tag and a plain sentence. */
export function importNoteView(note) {
  const kind = NOTE_TAGS[note.status] ?? { tag: String(note.status), state: "warn" };
  const where = `${note.branch} at ${note.commit}`;
  const reason = typeof note.reason === "string" ? note.reason.trim().replace(/\.$/, "") : "";
  if (note.status === "refused") {
    return { ...kind, text: reason ? `${where}: not imported. ${reason[0].toUpperCase()}${reason.slice(1)}.` : `${where}: not imported.` };
  }
  return { ...kind, text: `${where}: ${reason || note.status}.` };
}

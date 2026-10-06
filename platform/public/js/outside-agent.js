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

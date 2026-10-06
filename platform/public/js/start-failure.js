// Why the live platform could not give this browser a session or a fork, in
// plain words, and the link to the same demo in mock mode. Pure helpers: the
// error comes from api.js (status and JSON body attached), nothing is fetched.

const MOCK_NOTE = "Everything in Fluid also runs in mock mode, in your browser with the same synthetic data, so you can explore the full demo now.";

/** "about 25 minutes" from a retry-after in seconds; at least one minute. */
function waitText(seconds) {
  const minutes = Math.max(1, Math.ceil((Number(seconds) || 0) / 60));
  return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function rateLimit(body) {
  const wait = waitText(body.retryAfterSeconds);
  const limit = Number(body.limit) || 0;
  if (body.bucket === "fork" && body.scope === "client") {
    return { title: "You have used this hour's forks", message: `The live platform gives each network up to ${limit} forks an hour, and this one has used them. You can try again in ${wait}.`, retry: false };
  }
  if (body.bucket === "fork") {
    return { title: "The live platform is busy", message: `The live platform makes at most ${limit} forks an hour for everyone together, and it has made them all. You can try again in ${wait}.`, retry: false };
  }
  if (body.bucket === "session") {
    return { title: "You have used this hour's sessions", message: `The live platform allows up to ${limit} demo sessions an hour from one network, and this one has used them. You can try again in ${wait}.`, retry: false };
  }
  return { title: "The live platform is busy", message: `Too many requests for ${body.bucket || "this"} right now. You can try again in ${wait}.`, retry: false };
}

/**
 * Turns a failed session or fork request into { title, message, retry, mockNote }.
 * retry is true when trying again soon may work (a fork still being set up, a server error).
 */
export function explainStartFailure(error) {
  const body = error && typeof error.body === "object" && error.body ? error.body : {};
  let out;
  if (body.reason === "fleet-full") {
    out = { title: "The demo fleet is full", message: "The live platform holds up to 500 forks, and all of them are taken right now, so it cannot give you one.", retry: false };
  } else if (body.reason === "rate-limit") {
    out = rateLimit(body);
  } else if (body.reason === "busy") {
    out = { title: "Your fork is still being set up", message: "Another request is setting up this fork. Wait a few seconds and try again.", retry: true };
  } else {
    const detail = typeof body.error === "string" && body.error ? body.error : error?.message || "unknown error";
    const reference = body.requestId ? ` (request ${body.requestId})` : "";
    out = { title: "The live platform could not set up your fork", message: `Something went wrong on the platform's side: ${detail}${reference}.`, retry: true };
  }
  return { ...out, mockNote: MOCK_NOTE };
}

/** The same page in mock mode, keeping the current view (the hash). */
export function mockDemoHref(loc) {
  return `${loc.pathname || "/"}?mock=1${loc.hash || ""}`;
}

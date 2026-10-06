// Client for the platform HTTP API (route table in docs/API.md).
// Mock mode: ?mock=1, or automatically when GET /api/personas does not return JSON.

const ADMIN_KEY = "fluid.adminKey";
let mock = null;
let personasPrefetch = null;

export const state = { mock: false };

export async function initApi() {
  const params = new URLSearchParams(location.search);
  let useMock = params.get("mock") === "1";
  if (!useMock) {
    try {
      const res = await fetch("/api/personas", { headers: { accept: "application/json" }, credentials: "same-origin" });
      const type = res.headers.get("content-type") || "";
      if (!res.ok || !type.includes("json")) throw new Error(`GET /api/personas returned ${res.status}`);
      personasPrefetch = await res.json();
    } catch (err) {
      console.info(`Fluid: platform API unavailable (${err.message}); using mock mode.`);
      useMock = true;
    }
  }
  if (useMock) mock = await import("./mock-api.js");
  state.mock = useMock;
}

export function adminKey() {
  try { return sessionStorage.getItem(ADMIN_KEY) || ""; } catch { return ""; }
}
export function setAdminKey(value) {
  try { sessionStorage.setItem(ADMIN_KEY, value); } catch { /* storage unavailable */ }
}

async function call(method, path, body, { admin = false } = {}) {
  if (mock) return mock.handle(method, path, body);
  const headers = { accept: "application/json" };
  // The platform accepts POST only as JSON (its cross-site request guard), so every write sends a JSON body.
  const sendsBody = method !== "GET" && method !== "HEAD";
  if (sendsBody) headers["content-type"] = "application/json";
  if (admin && adminKey()) headers["x-fluid-admin"] = adminKey();
  const res = await fetch(path, {
    method, headers, credentials: "same-origin",
    body: sendsBody ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    const message = data?.error || data?.message || res.statusText;
    // status and body let the UI explain a refusal (public/js/start-failure.js).
    throw Object.assign(new Error(`${method} ${path} failed (${res.status}): ${message}`), { status: res.status, body: data });
  }
  return data;
}

const enc = encodeURIComponent;

export const api = {
  async personas() {
    const data = personasPrefetch ?? (await call("GET", "/api/personas"));
    personasPrefetch = null;
    return Array.isArray(data) ? data : data?.personas ?? [];
  },
  session: (persona) => call("POST", "/api/session", { persona }),
  me: () => call("GET", "/api/me"),
  createFork: () => call("POST", "/api/forks", {}),
  fork: (repo) => call("GET", `/api/forks/${enc(repo)}`),
  /** The fork's validated ui/preferences.json (font, density, accent, extra tabs). */
  forkUi: (repo) => call("GET", `/api/forks/${enc(repo)}/ui`),
  /** Yellow to green health of the fork's main and its history. */
  health: (repo) => call("GET", `/api/forks/${enc(repo)}/health`),
  /** Chart data over the session's own fork: ledger, intents, gates. */
  charts: () => call("GET", "/api/me/charts"),
  ask: (body) => call("POST", "/api/ask", body),
  override: (answer_id, mode) => call("POST", "/api/override", { answer_id, mode }),
  ledger: (userId) => call("GET", `/api/ledger/${enc(userId)}`),
  intents: (repo) => call("GET", `/api/intents/${enc(repo)}`),
  customize: (repo, request) => call("POST", "/api/customize", { repo, request }),
  /** Best-of-N contest for one wish: 2 or 3 contestants, optionally with the owner's own agent. */
  startContest: (repo, request, size, includeAgent) => call("POST", "/api/contests", { repo, request, size, includeAgent }),
  /** Ship one contestant (the winner or another that passed); only it is gated in merge mode. */
  pickContest: (runId, label) => call("POST", `/api/contests/${enc(runId)}/pick`, { label }),
  /** Wishes in flight: work branches, their intent records, and runs not pushed yet. */
  wishes: (repo) => call("GET", `/api/forks/${enc(repo)}/wishes`),
  run: (runId) => call("GET", `/api/runs/${enc(runId)}`),
  decide: (runId, testId, decision, edited) => call("POST", `/api/suggestions/${enc(runId)}/decide`, { testId, decision, edited }),
  gates: (repo) => call("GET", `/api/gates/${enc(repo)}`),
  /** A one hour git write token for the session's own fork, with clone and push commands. */
  outsideToken: (repo) => call("POST", `/api/forks/${enc(repo)}/token`, {}),
  /** The fork's last few imports from its inbox and why any was refused (owner only). */
  imports: (repo) => call("GET", `/api/forks/${enc(repo)}/imports`),
  /** Mock mode only: a push from an outside agent to its inbox, on work/my-change (imported) or on main (ignored). */
  simulateOutsidePush: (repo, target) => call("POST", "/api/mock/outside-push", { repo, target }),
  /** Gate repair/<sha> in merge mode; main fast-forwards to it only if it passes. */
  applyRepair: (repo, sha) => call("POST", `/api/forks/${enc(repo)}/repairs/${enc(sha)}/apply`, {}, { admin: true }),
  release: (tag, notes, safety) => call("POST", "/api/admin/release", { tag, notes, safety }, { admin: true }),
  seedFleet: (count) => call("POST", "/api/admin/fleet/seed", { count }, { admin: true }),
  fleet: () => call("GET", "/api/fleet"),
  startHarvest: () => call("POST", "/api/admin/harvest", {}, { admin: true }),
  harvest: () => call("GET", "/api/harvest"),

  /** Subscribe to fleet status changes. Returns an unsubscribe function. */
  fleetStream(onEvent, onStatus = () => {}) {
    if (mock) return mock.subscribeFleet(onEvent, onStatus);
    const source = new EventSource("/api/fleet/stream", { withCredentials: true });
    source.onopen = () => onStatus("live");
    source.onerror = () => onStatus(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    const handle = (event) => {
      try { onEvent(JSON.parse(event.data)); } catch (err) { console.warn("Fluid: ignored malformed fleet event", err); }
    };
    source.onmessage = handle;
    // The Fleet Durable Object sends named events: snapshot, fork, removed, stockTags.
    for (const name of ["snapshot", "fork", "removed", "stockTags", "release"]) source.addEventListener(name, handle);
    return () => source.close();
  },
};

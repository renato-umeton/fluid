// Client for the platform HTTP API (docs/IMPLEMENTATION_PLAN.md, "Platform HTTP API").
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
  if (body !== undefined) headers["content-type"] = "application/json";
  if (admin && adminKey()) headers["x-fluid-admin"] = adminKey();
  const res = await fetch(path, {
    method, headers, credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    const message = data?.error || data?.message || res.statusText;
    throw new Error(`${method} ${path} failed (${res.status}): ${message}`);
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
  ask: (body) => call("POST", "/api/ask", body),
  override: (answer_id, mode) => call("POST", "/api/override", { answer_id, mode }),
  ledger: (userId) => call("GET", `/api/ledger/${enc(userId)}`),
  intents: (repo) => call("GET", `/api/intents/${enc(repo)}`),
  customize: (repo, request) => call("POST", "/api/customize", { repo, request }),
  run: (runId) => call("GET", `/api/runs/${enc(runId)}`),
  decide: (runId, testId, decision, edited) => call("POST", `/api/suggestions/${enc(runId)}/decide`, { testId, decision, edited }),
  gates: (repo) => call("GET", `/api/gates/${enc(repo)}`),
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

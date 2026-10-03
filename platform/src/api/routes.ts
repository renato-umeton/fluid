// Platform HTTP API (docs/IMPLEMENTATION_PLAN.md, "Platform HTTP API").
// Write routes need the demo session cookie; admin routes need x-fluid-admin.
import { getForkInfo, findPersona, fleetStub, ForkNotFoundError, personas, provisionFork, readIntents, type ForkInfo } from "../forks/provision.ts";
import { clientKey } from "../lib/client.ts";
import { scrubText } from "../git/tokens.ts";
import { forkRepoName, isValidRepoName, newIntentId, newSandboxUserId, STOCK_REPO, userIdFromForkRepo } from "../lib/names.ts";
import { readCookie, safeEqual, SESSION_COOKIE, sessionCookieHeader, signSession, verifySession, type Session } from "../lib/session.ts";
import { askFork, type PlatformExports } from "../runtime/loader.ts";
import { bundledStockRelease, compareSemverDesc, listStockTags, publishStockRelease, readReleaseMetadata, readStockFiles } from "../stock/publish.ts";
import type { ReleaseMetadata } from "../stock/releases.ts";
import { runGate } from "../gate/run.ts";
import type { RunTimeRecord } from "../durable/user-ledger.ts";
import { ledgerStub, quotaStub, runsStub } from "../stubs.ts";
import { cleanText } from "../agents/intent.ts";
import { validateProbe, type Suggestion } from "../agents/suggester.ts";
import { newRunId } from "../durable/runs.ts";
import { gateInstanceId, gateModeFor } from "../events/filter.ts";
import { isSeededRepo, SEED_DEFAULT, SEED_MAX } from "../fleet/seed-catalog.ts";
import { cloneRepo, fetchBranch, mergeInto, pushBranch } from "../git/ops.ts";
import type { Json } from "../lib/json.ts";
import { shortRef } from "../runtime/refs.ts";
import { headOf, openRepo } from "../runtime/repo-files.ts";
import { DEMO_OVERLAY, demoReleaseFiles } from "../stock/releases.ts";
import { appExports, repoRemote, startGateInstance } from "../workflows/common.ts";
import { decodeParam, HttpError, json, readJson, requireJsonPost, requireString } from "./http.ts";
import { askRef, parsePreferences } from "./validate.ts";

export const LIMITS = {
	sessionsPerClientPerHour: 20,
	asksPerUserPerMinute: 10,
	asksPerClientPerMinute: 30,
	asksGlobalPerMinute: 300,
	overridesPerUserPerMinute: 30,
	forksPerClientPerHour: 3,
	forksGlobalPerHour: 60,
	forksTotal: 500,
	readsPerClientPerMinute: 60,
	ledgerCommitsPerUserPerHour: 6,
	customizationsPerUserPerHour: 10,
};

/** Fork info is read from Artifacts; repeated reads within this window share one result. */
const FORK_INFO_TTL_MS = 5_000;
const FORK_INFO_CACHE_LIMIT = 500;

const MODES = ["clinical", "research", "administrative"];

export interface RouteContext {
	request: Request;
	env: Env;
	ctx: ExecutionContext;
	url: URL;
}

type Handler = (rc: RouteContext, params: Record<string, string>) => Promise<Response>;

interface Route {
	method: string;
	pattern: RegExp;
	keys: string[];
	handler: Handler;
}

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler): void {
	const keys: string[] = [];
	const pattern = new RegExp(`^${path.replace(/:([A-Za-z]+)/g, (_, key: string) => (keys.push(key), "([^/]+)"))}$`);
	routes.push({ method, pattern, keys, handler });
}

export async function handleApi(rc: RouteContext): Promise<Response> {
	requireJsonPost(rc.request, rc.url);
	let methodMismatch = false;
	for (const r of routes) {
		const match = r.pattern.exec(rc.url.pathname);
		if (!match) continue;
		if (r.method !== rc.request.method) {
			methodMismatch = true;
			continue;
		}
		const params = Object.fromEntries(r.keys.map((key, i) => [key, decodeParam(match[i + 1]!)]));
		return r.handler(rc, params);
	}
	if (methodMismatch) throw new HttpError(405, `method ${rc.request.method} not allowed on ${rc.url.pathname}`);
	throw new HttpError(404, `no route for ${rc.request.method} ${rc.url.pathname}`);
}

// ---------- auth, quotas ----------

async function sessionOf(rc: RouteContext): Promise<Session | null> {
	return verifySession(readCookie(rc.request.headers.get("cookie"), SESSION_COOKIE), rc.env.SESSION_SECRET);
}

async function requireSession(rc: RouteContext): Promise<Session> {
	const session = await sessionOf(rc);
	if (!session) throw new HttpError(401, "no demo session: POST /api/session first");
	return session;
}

function isAdmin(rc: RouteContext): boolean {
	const header = rc.request.headers.get("x-fluid-admin");
	return Boolean(rc.env.ADMIN_TOKEN && header && safeEqual(header, rc.env.ADMIN_TOKEN));
}

function requireAdmin(rc: RouteContext): void {
	if (!rc.env.ADMIN_TOKEN) throw new HttpError(503, "admin routes are disabled: ADMIN_TOKEN is not configured");
	if (!isAdmin(rc)) throw new HttpError(403, "admin token required");
}

async function takeQuota(env: Env, subject: string, bucket: string, limit: number, windowSeconds: number): Promise<void> {
	const decision = await quotaStub(env, subject).take(bucket, limit, windowSeconds);
	if (!decision.allowed) {
		throw new HttpError(429, `rate limit for ${bucket} reached; retry in ${decision.retryAfterSeconds}s`, { retryAfterSeconds: decision.retryAfterSeconds }, { "retry-after": String(decision.retryAfterSeconds) });
	}
}

function clientId(rc: RouteContext): string {
	return clientKey(rc.request.headers.get("cf-connecting-ip"));
}

/** Per-client quota (IPv4 address or IPv6 /64). The admin is exempt; global quotas still apply. */
async function takeClientQuota(rc: RouteContext, bucket: string, limit: number, windowSeconds: number): Promise<void> {
	if (isAdmin(rc)) return;
	await takeQuota(rc.env, `client:${clientId(rc)}`, bucket, limit, windowSeconds);
}

/** Quota for reads that go to Artifacts (fork info, intent records). */
async function takeReadQuota(rc: RouteContext): Promise<void> {
	await takeClientQuota(rc, "read", LIMITS.readsPerClientPerMinute, 60);
}

/** Only fleet forks and stock are readable through the API (ledger repos and others stay hidden). */
async function requirePublicRepo(env: Env, repo: string): Promise<void> {
	if (repo === STOCK_REPO) return;
	if (!(await fleetStub(env).get(repo))) throw new HttpError(404, "fork not found");
}

function exportsOf(ctx: ExecutionContext): PlatformExports {
	return (ctx as unknown as { exports: PlatformExports }).exports;
}

function repoParam(value: string): string {
	if (!isValidRepoName(value)) throw new HttpError(400, `invalid repository name ${JSON.stringify(value)}`);
	return value;
}

const forkInfoCache = new Map<string, { at: number; info: ForkInfo }>();

async function forkInfoOrNull(env: Env, repo: string): Promise<ForkInfo | null> {
	const cached = forkInfoCache.get(repo);
	if (cached && Date.now() - cached.at < FORK_INFO_TTL_MS) return cached.info;
	try {
		const info = await getForkInfo(env, repo);
		if (forkInfoCache.size >= FORK_INFO_CACHE_LIMIT) forkInfoCache.delete(forkInfoCache.keys().next().value!);
		forkInfoCache.set(repo, { at: Date.now(), info });
		return info;
	} catch (error) {
		if (error instanceof ForkNotFoundError) return null;
		throw error;
	}
}

async function recordRelease(env: Env, tag: string, release: ReleaseMetadata | null, commit: string): Promise<void> {
	const fleet = fleetStub(env);
	if (!release) {
		await fleet.addStockTag(tag);
		return;
	}
	await fleet.addRelease({ tag, notes: release.notes, safety: release.safety, date: release.date, graceDays: release.graceDays, graceUntil: release.graceUntil, commit });
}

// ---------- routes ----------

route("GET", "/api/health", async () => json({ ok: true }));

route("POST", "/api/session", async (rc) => {
	const body = await readJson(rc.request);
	const personaId = requireString(body, "persona", 100);
	const persona = findPersona(personaId);
	if (!persona) throw new HttpError(400, `unknown persona ${JSON.stringify(personaId)}`);
	const existing = await sessionOf(rc);
	if (existing && existing.persona === persona.id) return json({ userId: existing.userId, persona: existing.persona });
	await takeClientQuota(rc, "session", LIMITS.sessionsPerClientPerHour, 3600);
	const session: Session = { userId: newSandboxUserId(), persona: persona.id, issuedAt: Date.now() };
	const cookie = sessionCookieHeader(await signSession(session, rc.env.SESSION_SECRET), rc.url.protocol === "https:");
	return json({ userId: session.userId, persona: session.persona }, 200, { "set-cookie": cookie });
});

route("GET", "/api/personas", async () => json(personas()));

route("GET", "/api/me", async (rc) => {
	const session = await requireSession(rc);
	const known = await fleetStub(rc.env).forksOfUser(session.userId);
	if (known.length > 0) await takeReadQuota(rc);
	const fork = known.length > 0 ? await forkInfoOrNull(rc.env, known[0]!.repo) : null;
	return json({ userId: session.userId, persona: session.persona, fork });
});

route("POST", "/api/forks", async (rc) => {
	const session = await requireSession(rc);
	const body = await readJson(rc.request);
	const preferences = parsePreferences(body.preferences);
	const persona = findPersona(session.persona);
	if (!persona) throw new HttpError(400, `unknown persona ${session.persona}`);
	// A session has one fork (user-<id>); asking again for an existing fork costs no quota.
	const existing = await fleetStub(rc.env).get(forkRepoName(session.userId));
	if (!existing || existing.status === "failed") {
		await takeClientQuota(rc, "fork", LIMITS.forksPerClientPerHour, 3600);
		await takeQuota(rc.env, "global", "fork", LIMITS.forksGlobalPerHour, 3600);
	}
	const info = await provisionFork(rc.env, { userId: session.userId, persona, preferences, maxTotal: LIMITS.forksTotal });
	forkInfoCache.delete(info.repo);
	return json(info, 201);
});

route("GET", "/api/forks/:repo", async (rc, { repo }) => {
	const name = repoParam(repo!);
	await takeReadQuota(rc);
	await requirePublicRepo(rc.env, name);
	const info = await forkInfoOrNull(rc.env, name);
	if (!info) throw new HttpError(404, "fork not found");
	return json(info);
});

route("POST", "/api/ask", async (rc) => {
	const session = await requireSession(rc);
	const body = await readJson(rc.request);
	const repo = repoParam(typeof body.repo === "string" ? body.repo : forkRepoName(session.userId));
	if (!isAdmin(rc) && repo !== forkRepoName(session.userId) && repo !== STOCK_REPO) throw new HttpError(403, "you can ask your own fork or stock");
	const question = requireString(body, "question", 2000);
	const context = body.context ?? {};
	if (typeof context !== "object" || context === null || Array.isArray(context)) throw new HttpError(400, "context must be an object");
	if (body.explicitMode !== undefined && body.explicitMode !== null && !MODES.includes(body.explicitMode as string)) throw new HttpError(400, `explicitMode must be one of ${MODES.join(", ")}`);
	if (body.attestation !== undefined && typeof body.attestation !== "boolean") throw new HttpError(400, "attestation must be a boolean");
	const ref = askRef(body.ref, isAdmin(rc));
	await takeQuota(rc.env, `user:${session.userId}`, "ask", LIMITS.asksPerUserPerMinute, 60);
	await takeClientQuota(rc, "ask", LIMITS.asksPerClientPerMinute, 60);
	await takeQuota(rc.env, "global", "ask", LIMITS.asksGlobalPerMinute, 60);
	const request: Record<string, unknown> = { question, context };
	if (body.explicitMode) request.explicitMode = body.explicitMode;
	if (body.attestation !== undefined) request.attestation = body.attestation;
	if (Array.isArray(body.history)) request.history = (body.history as unknown[]).slice(-10);
	const result = await askFork({ env: rc.env, exports: exportsOf(rc.ctx) }, { repo, ref, request, useModel: body.useModel === true });
	await ledgerStub(rc.env, session.userId).append(session.userId, repo, result.card.ledger as unknown as RunTimeRecord);
	return json({ ...result.card, fork: { repo, ref: result.ref, commit: result.sha } });
});

route("POST", "/api/override", async (rc) => {
	const session = await requireSession(rc);
	const body = await readJson(rc.request);
	const answerId = requireString(body, "answer_id", 100);
	const mode = requireString(body, "mode", 40);
	if (!MODES.includes(mode)) throw new HttpError(400, `mode must be one of ${MODES.join(", ")}`);
	await takeQuota(rc.env, `user:${session.userId}`, "override", LIMITS.overridesPerUserPerMinute, 60);
	const record = await ledgerStub(rc.env, session.userId).override(answerId, mode);
	if (!record) throw new HttpError(404, `answer ${answerId} is not in your ledger`);
	return json(record);
});

route("GET", "/api/ledger/:userId", async (rc, { userId }) => {
	const session = await sessionOf(rc);
	if (!isAdmin(rc) && session?.userId !== userId) throw new HttpError(403, "you can read your own ledger");
	const limit = Number(rc.url.searchParams.get("limit") ?? 100);
	const entries = await ledgerStub(rc.env, userId!).list(Number.isFinite(limit) ? limit : 100);
	if (rc.url.searchParams.get("detail") === "1") return json(entries);
	return json(entries.map((e) => e.record));
});

route("POST", "/api/ledger/commit", async (rc) => {
	const session = await requireSession(rc);
	await takeQuota(rc.env, `user:${session.userId}`, "ledger-commit", LIMITS.ledgerCommitsPerUserPerHour, 3600);
	return json(await ledgerStub(rc.env, session.userId).commitPending());
});

route("GET", "/api/intents/:repo", async (rc, { repo }) => {
	const name = repoParam(repo!);
	const ref = askRef(rc.url.searchParams.get("ref") ?? undefined, isAdmin(rc));
	await takeReadQuota(rc);
	await requirePublicRepo(rc.env, name);
	try {
		return json(await readIntents(rc.env, name, ref));
	} catch (error) {
		if (error instanceof ForkNotFoundError) throw new HttpError(404, "ref not found");
		throw error;
	}
});

route("GET", "/api/fleet", async (rc) => json(await fleetStub(rc.env).snapshot()));

route("GET", "/api/fleet/stream", async (rc) =>
	fleetStub(rc.env).fetch(new Request("https://fleet/stream", { signal: rc.request.signal, headers: { "x-fluid-client": clientId(rc) } })),
);

// Publishes the stock source bundled into the platform (committed stock/), optionally under a new tag.
route("POST", "/api/admin/stock/publish", async (rc) => {
	requireAdmin(rc);
	const body = await readJson(rc.request);
	const bundled = bundledStockRelease();
	const tag = typeof body.tag === "string" ? body.tag : bundled.tag;
	const result = await publishStockRelease(rc.env, { ...bundled, tag, notes: typeof body.notes === "string" ? body.notes : undefined, safety: body.safety === true });
	await recordRelease(rc.env, result.tag, result.release, result.commit);
	return json(result, result.alreadyPublished ? 200 : 201);
});

route("POST", "/api/admin/forks/:repo/delete", async (rc, { repo }) => {
	requireAdmin(rc);
	const name = repoParam(repo!);
	if (name === STOCK_REPO) throw new HttpError(400, "refusing to delete stock");
	const deleted = await rc.env.ARTIFACTS.delete(name).catch(() => false);
	const removed = await fleetStub(rc.env).remove(name);
	return json({ repo: name, deleted, removedFromFleet: removed });
});

route("POST", "/api/admin/suite", async (rc) => {
	requireAdmin(rc);
	const body = await readJson(rc.request);
	const repo = repoParam(requireString(body, "repo", 100));
	const samples = typeof body.samples === "number" ? Math.min(Math.max(Math.floor(body.samples), 1), 5) : 1;
	return json(await runGate({ env: rc.env, exports: exportsOf(rc.ctx) }, { repo, ref: typeof body.ref === "string" ? body.ref : "main", samples }));
});

// ---------- Stage 3: gate, agents, releases, fleet, harvest ----------

const RUN_ID = /^run_[A-Za-z0-9_-]{1,100}$/;
const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

async function requireForkAccess(rc: RouteContext, repo: string): Promise<Session | null> {
	if (isAdmin(rc)) return sessionOf(rc);
	const session = await requireSession(rc);
	if (repo !== forkRepoName(session.userId)) throw new HttpError(403, "you can change only your own fork");
	return session;
}

route("POST", "/api/customize", async (rc) => {
	const body = await readJson(rc.request);
	const repo = repoParam(requireString(body, "repo", 100));
	const session = await requireForkAccess(rc, repo);
	const request = requireString(body, "request", 1000);
	const entry = await fleetStub(rc.env).get(repo);
	if (!entry) throw new HttpError(404, `fork ${repo} is not in the fleet`);
	await takeQuota(rc.env, `user:${session?.userId ?? "admin"}`, "customize", LIMITS.customizationsPerUserPerHour, 3600);
	const runId = newRunId("customize");
	await runsStub(rc.env, runId).create({ id: runId, kind: "customize", repo, status: "running", fields: { request: cleanText(request, 1000) } });
	await appExports(rc.ctx).CustomizeWorkflow.create({ id: runId, params: { runId, repo, request, userId: session?.userId ?? userIdFromForkRepo(repo) ?? "admin", persona: entry.persona } });
	return json({ runId }, 202);
});

route("GET", "/api/runs/:runId", async (rc, { runId }) => {
	if (!RUN_ID.test(runId!)) throw new HttpError(400, "invalid run id");
	const run = await runsStub(rc.env, runId!).get();
	if (!run) throw new HttpError(404, `run ${runId} not found`);
	return json(run);
});

route("POST", "/api/suggestions/:runId/decide", async (rc, { runId }) => {
	if (!RUN_ID.test(runId!)) throw new HttpError(400, "invalid run id");
	const stub = runsStub(rc.env, runId!);
	const run = await stub.get();
	if (!run || run.kind !== "customize") throw new HttpError(404, `customization run ${runId} not found`);
	await requireForkAccess(rc, run.repo ?? "");
	const body = await readJson(rc.request);
	const testId = requireString(body, "testId", 100);
	const decision = requireString(body, "decision", 10);
	if (!["accept", "reject", "edit"].includes(decision)) throw new HttpError(400, "decision must be accept, reject, or edit");
	let edited: Json | undefined;
	if (decision === "edit") {
		const assert = (body.edited as { assert?: unknown } | undefined)?.assert;
		const original = ((run.suggestions ?? []) as unknown as Suggestion[]).find((x) => x.id === testId);
		if (!original) throw new HttpError(404, `no suggestion ${testId}`);
		if (!Array.isArray(assert) || assert.length > 10) throw new HttpError(400, "edited.assert must be an array of at most 10 assertions");
		const problem = validateProbe({ ...original.probe, assert: assert as Record<string, unknown>[] });
		if (problem) throw new HttpError(400, `edited test is invalid: ${problem}`);
		edited = { assert } as Json;
	}
	let result;
	try {
		result = await stub.decide(testId, decision as "accept" | "reject" | "edit", edited);
	} catch (error) {
		throw new HttpError(409, error instanceof Error ? error.message : String(error));
	}
	if (result.allDecided) {
		const instance = await appExports(rc.ctx).CustomizeWorkflow.get(runId!);
		await instance.sendEvent({ type: "suggestions-decided", payload: { at: new Date().toISOString() } });
	}
	return json(result.run);
});

route("GET", "/api/gates/:repo", async (rc, { repo }) => json(await fleetStub(rc.env).gates(repoParam(repo!))));

// Direct gate trigger (queues do not deliver to local dev; also used by scripts).
route("POST", "/api/gates/:repo", async (rc, { repo }) => {
	const name = repoParam(repo!);
	await requireForkAccess(rc, name);
	const body = await readJson(rc.request);
	const branch = requireString(body, "branch", 200);
	if (branch === "main" || branch.startsWith("upgrade/")) throw new HttpError(400, "main and upgrade branches are gated by their own workflows");
	let commit: string | null;
	{
		using handle = await openRepo(rc.env.ARTIFACTS, name);
		commit = await headOf(handle, shortRef(branch));
	}
	if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new HttpError(404, "branch not found");
	// Only the branch head is gated: a caller-chosen commit could name an object outside this fork.
	if (body.commit !== undefined && body.commit !== commit) throw new HttpError(409, "commit is not the head of the branch");
	const started = await startGateInstance(appExports(rc.ctx).GateWorkflow, gateInstanceId(name, branch, commit), { repo: name, branch, commit, mode: gateModeFor(branch), source: "direct" });
	return json({ runId: started.runId, instanceId: started.id, created: started.created, commit }, started.created ? 202 : 200);
});

// One-tap upgrade: merge a gated upgrade/<tag> branch into main.
route("POST", "/api/forks/:repo/upgrade", async (rc, { repo }) => {
	const name = repoParam(repo!);
	await requireForkAccess(rc, name);
	const fleet = fleetStub(rc.env);
	const entry = await fleet.get(name);
	const last = entry?.lastRun;
	if (!entry || !last || last.kind !== "upgrade" || last.status !== "passed" || last.applied !== false || typeof last.tag !== "string" || typeof last.commit !== "string") {
		throw new HttpError(409, "no gated upgrade is waiting for approval on this fork");
	}
	const tag = last.tag;
	const remote = await repoRemote(rc.env, name, "write");
	const ws = await cloneRepo({ ...remote, ref: "main", singleBranch: true });
	await fetchBranch(ws, remote, `upgrade/${tag}`);
	const outcome = await mergeInto(ws, { ours: "main", theirs: last.commit, message: `Upgrade to stock ${tag}\n\nApproved by the user after the gate passed on upgrade/${tag} at ${last.commit.slice(0, 7)}.` });
	if (!outcome.ok) throw new HttpError(409, `main moved since the upgrade was gated (${outcome.conflicts.filepaths.join(", ")}); a new upgrade run is needed`);
	if (!outcome.alreadyMerged) await pushBranch(ws, remote, "main");
	const updated = await fleet.update(name, { status: "passed", pinnedTag: tag, lastRun: { ...last, applied: true, at: new Date().toISOString() } });
	forkInfoCache.delete(name);
	return json({ repo: name, tag, commit: outcome.oid, fork: updated });
});

route("POST", "/api/admin/release", async (rc) => {
	requireAdmin(rc);
	const body = await readJson(rc.request);
	const tag = requireString(body, "tag", 40);
	if (!TAG_PATTERN.test(tag)) throw new HttpError(400, "tag must look like v1.2.0");
	const notes = typeof body.notes === "string" ? body.notes : "";
	const safety = body.safety === true;
	const tags = await listStockTags(rc.env);
	const latest = tags[0];
	if (!latest) throw new HttpError(409, "publish stock first");
	let result;
	if (tags.includes(tag)) {
		if (tag !== latest) throw new HttpError(409, `stock ${tag} already exists and is not the latest tag (${latest})`);
		// Re-running the fan-out for the latest tag (for example after seeding more forks) does not republish it.
		using stock = await openRepo(rc.env.ARTIFACTS, STOCK_REPO);
		result = { commit: (await headOf(stock, tag)) ?? "", alreadyPublished: true, release: await readReleaseMetadata(rc.env, tag) };
	} else {
		if (compareSemverDesc(tag, latest) >= 0) throw new HttpError(409, `${tag} must be newer than the latest tag ${latest}`);
		const current = await readStockFiles(rc.env, latest);
		const { files, changed } = demoReleaseFiles(current);
		const intentId = newIntentId();
		const tightened = changed.includes("tests/invariants/manifest.json") ? DEMO_OVERLAY.probes.map((p) => p.id) : [];
		const intent = { id: intentId, author: "mothership:clinical-informatics", agent: null, request: `Release ${tag}${safety ? " (safety release)" : ""}`, purpose: cleanText(notes, 400) || `Stock release ${tag}`, modes_affected: ["research", "administrative"], files: changed, tests_added: tightened.map((id) => `tests/invariants/manifest.json#${id}`), stock_tag: tag };
		result = await publishStockRelease(rc.env, { tag, files: { ...files, [`.intent/${intentId}.json`]: `${JSON.stringify(intent, null, 2)}\n` }, intentId, notes, safety });
	}
	await recordRelease(rc.env, tag, result.release, result.commit);
	const repos = (await fleetStub(rc.env).list()).filter((f) => f.status !== "provisioning").map((f) => f.repo);
	const runId = newRunId("release");
	await runsStub(rc.env, runId).create({ id: runId, kind: "release", status: "running", fields: { tag, safety, forks: repos.length } });
	await appExports(rc.ctx).ReleaseWorkflow.create({ id: runId, params: { runId, tag, safety: result.release?.safety ?? safety, graceUntil: result.release?.graceUntil ?? null, repos } });
	return json({ tag, upgradeRuns: repos.length, runId, commit: result.commit, alreadyPublished: result.alreadyPublished, release: result.release }, 202);
});

route("POST", "/api/admin/fleet/seed", async (rc) => {
	requireAdmin(rc);
	const body = await readJson(rc.request);
	const count = Math.max(1, Math.min(SEED_MAX, Math.floor(typeof body.count === "number" ? body.count : SEED_DEFAULT)));
	const existing = await fleetStub(rc.env).count();
	if (existing + count > SEED_MAX + 50) throw new HttpError(409, `the fleet has ${existing} forks; seeding ${count} more would pass the ${SEED_MAX + 50} cap. Clean up first.`);
	const batch = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join("");
	const runId = newRunId("seed");
	await runsStub(rc.env, runId).create({ id: runId, kind: "seed", status: "running", fields: { batch, count } });
	await appExports(rc.ctx).SeedFleetWorkflow.create({ id: runId, params: { runId, batch, count } });
	return json({ created: count, batch, runId }, 202);
});

// Deletes forks created by seeding (fleet entries flagged seeded with a user-seed- name). Never touches stock or user forks.
route("POST", "/api/admin/fleet/cleanup", async (rc) => {
	requireAdmin(rc);
	const body = await readJson(rc.request);
	const batch = typeof body.batch === "string" ? body.batch : null;
	const fleet = fleetStub(rc.env);
	const targets = (await fleet.list()).filter((f) => f.seeded && isSeededRepo(f.repo) && (!batch || f.repo.startsWith(`user-seed-${batch}-`))).map((f) => f.repo);
	const deleted: string[] = [];
	const failed: { repo: string; error: string }[] = [];
	let next = 0;
	const worker = async () => {
		while (next < targets.length) {
			const repo = targets[next++]!;
			if (repo === STOCK_REPO || !isSeededRepo(repo)) continue;
			try {
				await rc.env.ARTIFACTS.delete(repo).catch((error: unknown) => {
					if (!/not found/i.test(String((error as Error)?.message))) throw error;
				});
				await fleet.remove(repo);
				deleted.push(repo);
			} catch (error) {
				failed.push({ repo, error: scrubText(error instanceof Error ? error.message : String(error)) });
			}
		}
	};
	await Promise.all(Array.from({ length: 8 }, worker));
	return json({ deleted: deleted.length, failed });
});

route("POST", "/api/admin/harvest", async (rc) => {
	requireAdmin(rc);
	const runId = newRunId("harvest");
	await runsStub(rc.env, runId).create({ id: runId, kind: "harvest", status: "running" });
	await appExports(rc.ctx).HarvestWorkflow.create({ id: runId, params: { runId } });
	return json({ runId }, 202);
});

route("GET", "/api/harvest", async (rc) => {
	const stored = (await fleetStub(rc.env).getValue("harvest")) as { proposals?: unknown[] } | null;
	return json(stored?.proposals ?? []);
});

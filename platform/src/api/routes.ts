// Platform HTTP API (route table in docs/API.md).
// Write routes need the demo session cookie; admin routes need x-fluid-admin.
import { currentStockTag, getForkInfo, findPersona, fleetStub, ForkNotFoundError, personas, provisionFork, readIntents, type ForkInfo } from "../forks/provision.ts";
import { serveAsk } from "./ask.ts";
import { clientKey } from "../lib/client.ts";
import { scrubText } from "../git/tokens.ts";
import { inboxRepoName, mintOutsideToken, outsideGrantKey, type OutsideGrant } from "../forks/outside.ts";
import { forkRepoName, isValidRepoName, newIntentId, newSandboxUserId, STOCK_REPO, userIdFromForkRepo } from "../lib/names.ts";
import { readCookie, safeEqual, SESSION_COOKIE, sessionCookieHeader, signSession, switchPersona, verifySession, type Session } from "../lib/session.ts";
import type { PlatformExports } from "../runtime/loader.ts";
import { bundledStockRelease, compareSemverDesc, listStockTags, publishStockRelease, readReleaseMetadata, readStockFiles, stockTagCommit, unrecordedStockTags } from "../stock/publish.ts";
import type { ReleaseMetadata } from "../stock/releases.ts";
import { runGate } from "../gate/run.ts";
import { runE2E } from "../yellow/run.ts";
import { BASELINE_LIMITS, baselinePage, baselineRecord } from "../yellow/baseline.ts";
import { isAdminTestRequest } from "../agents/test-recipe.ts";
import type { GateResult } from "../gate/tiers.ts";
import type { RunTimeRecord } from "../durable/user-ledger.ts";
import type { RunSummary } from "../durable/fleet.ts";
import { ledgerStub, quotaStub, runsStub } from "../stubs.ts";
import { cleanText } from "../agents/intent.ts";
import { validateProbe, type Suggestion } from "../agents/suggester.ts";
import { newRunId } from "../durable/runs.ts";
import { directGateRefusal, fnv1a, gateInstanceId, gateModeFor } from "../events/filter.ts";
import { fastForwardToPending } from "../forks/one-tap.ts";
import { isSeededRepo, SEED_DEFAULT, SEED_MAX } from "../fleet/seed-catalog.ts";
import { cloneRepo, fetchBranch, firstParent, pushBranch } from "../git/ops.ts";
import { landedEarlier } from "../yellow/landing.ts";
import type { Json } from "../lib/json.ts";
import { shortRef } from "../runtime/refs.ts";
import { headOf, isNotFound, openRepo, readTextFile } from "../runtime/repo-files.ts";
import { parseUiPreferences, UI_PREFERENCES_PATH } from "../ui/preferences.ts";
import { aggregateCharts, CHART_LIMITS } from "../ui/charts.ts";
import { DEMO_OVERLAY, demoReleaseFiles, keepFloorTightening } from "../stock/releases.ts";
import { appExports, ensureRun, repoRemote, startGateInstance, startYellowRun } from "../workflows/common.ts";
import { rerunTargets, upgradeTargets } from "../workflows/upgrade.ts";
import { decodeParam, HttpError, json, readJson, requireJsonPost, requireString } from "./http.ts";
import { askRef, parsePreferences } from "./validate.ts";
import { readWishes } from "../contest/read-wishes.ts";
import { agentInboxBranch, CONTEST_LIMITS, contestLockKey, contestRunId, contestantRunId, lineup, newContestId, parseContestOptions, refundContestQuota, takeContestQuota, type QuotaAccess } from "../contest/plan.ts";
import { pickNotes } from "../contest/winner.ts";
import { matchRecipe } from "../agents/recipes.ts";

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
	wishReadsGlobalPerMinute: 300,
	outsideTokensPerUserPerHour: 3,
	outsideTokensPerClientPerHour: 6,
	outsideTokensGlobalPerHour: 60,
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

/** The fork a session owns: its own user-<id>, or the one fork a yellow run's test session is scoped to. */
function ownRepo(session: Session): string {
	return session.e2e?.repo ?? forkRepoName(session.userId);
}

function refuseTestSession(session: Session | null, what: string): void {
	if (session?.e2e) throw new HttpError(403, `a test session cannot ${what}`);
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

/** Records every release tag in stock that the fleet does not know yet (with its safety metadata). */
async function syncStockReleases(env: Env): Promise<string[]> {
	const missing = unrecordedStockTags(await listStockTags(env), await fleetStub(env).stockTags());
	for (const tag of missing) await recordRelease(env, tag, await readReleaseMetadata(env, tag), (await stockTagCommit(env, tag)) ?? "");
	return missing;
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
	refuseTestSession(existing, "switch persona");
	// Switching back to a persona this browser used before keeps its user id and fork (no new quota).
	const { session, reused } = switchPersona(existing, persona.id, Date.now(), newSandboxUserId);
	if (!reused) await takeClientQuota(rc, "session", LIMITS.sessionsPerClientPerHour, 3600);
	const cookie = sessionCookieHeader(await signSession(session, rc.env.SESSION_SECRET), rc.url.protocol === "https:");
	return json({ userId: session.userId, persona: session.persona }, 200, { "set-cookie": cookie });
});

route("GET", "/api/personas", async () => json(personas()));

route("GET", "/api/me", async (rc) => {
	const session = await requireSession(rc);
	const known = session.e2e ? [await fleetStub(rc.env).get(session.e2e.repo)].filter((f) => f !== null) : await fleetStub(rc.env).forksOfUser(session.userId);
	if (known.length > 0) await takeReadQuota(rc);
	const fork = known.length > 0 ? await forkInfoOrNull(rc.env, known[0]!.repo) : null;
	return json({ userId: session.userId, persona: session.persona, fork: fork ? { ...fork, health: known[0]!.health } : null, ...(session.e2e ? { test: { runId: session.e2e.runId } } : {}) });
});

route("POST", "/api/forks", async (rc) => {
	const session = await requireSession(rc);
	refuseTestSession(session, "create a fork");
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
	const health = name === STOCK_REPO ? null : ((await fleetStub(rc.env).get(name))?.health ?? null);
	return json({ ...info, ...(health ? { health } : {}) });
});

// Yellow to green state of a fork's main and its history (newest first).
route("GET", "/api/forks/:repo/health", async (rc, { repo }) => {
	const name = repoParam(repo!);
	const fleet = fleetStub(rc.env);
	const entry = await fleet.get(name);
	if (!entry) throw new HttpError(404, "fork not found");
	return json({ repo: name, health: entry.health, baseline: entry.baseline, history: await fleet.healthHistory(name, 30) });
});

// Wishes in flight: every work/* branch with the intent record it adds and its status. Branches and their
// records are public, like /api/intents; the notes of runs that have not pushed yet (their request text)
// go only to the fork's owner and the admin. The branch read is cached per fork for a few seconds.
route("GET", "/api/forks/:repo/wishes", async (rc, { repo }) => {
	const name = repoParam(repo!);
	if (name === STOCK_REPO) throw new HttpError(404, "stock has no wishes in flight");
	await takeReadQuota(rc);
	await takeQuota(rc.env, "global", "wishes", LIMITS.wishReadsGlobalPerMinute, 60);
	await requirePublicRepo(rc.env, name);
	const session = await sessionOf(rc);
	const owner = isAdmin(rc) || (session !== null && !session.e2e && forkRepoName(session.userId) === name);
	return json(await readWishes(rc.env, name, { includeNotes: owner }));
});

// Fork-owned UI preferences (ui/preferences.json on main), validated against the platform schema.
// An invalid file is reported and the defaults are served; the gate keeps invalid files off main.
route("GET", "/api/forks/:repo/ui", async (rc, { repo }) => {
	const name = repoParam(repo!);
	await takeReadQuota(rc);
	await requirePublicRepo(rc.env, name);
	let head: string | null;
	let text: string | null = null;
	{
		using handle = await openRepo(rc.env.ARTIFACTS, name);
		head = await headOf(handle, "main");
		if (head) text = await readTextFile(handle, head, UI_PREFERENCES_PATH);
	}
	if (!head) throw new HttpError(404, "fork has no main branch");
	const parsed = parseUiPreferences(text);
	return json({ repo: name, commit: head, path: UI_PREFERENCES_PATH, present: parsed.present, valid: parsed.ok, preferences: parsed.ok ? parsed.preferences : {}, ...(parsed.ok ? {} : { errors: parsed.errors }) });
});

// Chart data for the session's own fork: its run-time ledger, build-time intents, and gate history.
route("GET", "/api/me/charts", async (rc) => {
	const session = await requireSession(rc);
	const repo = ownRepo(session);
	if (!(await fleetStub(rc.env).get(repo))) throw new HttpError(404, "you have no fork yet");
	await takeReadQuota(rc);
	const [ledger, intents, gates] = await Promise.all([
		ledgerStub(rc.env, session.userId).list(CHART_LIMITS.ledger),
		readIntents(rc.env, repo, "main").catch((error: unknown) => {
			if (error instanceof ForkNotFoundError) return [];
			throw error;
		}),
		fleetStub(rc.env).gates(repo),
	]);
	return json(aggregateCharts({ repo, ledger, intents, gates: gates as unknown as GateResult[] }));
});

route("POST", "/api/ask", async (rc) => {
	const session = await requireSession(rc);
	const body = await readJson(rc.request);
	const repo = repoParam(typeof body.repo === "string" ? body.repo : ownRepo(session));
	if (!isAdmin(rc) && repo !== ownRepo(session) && repo !== STOCK_REPO) throw new HttpError(403, "you can ask your own fork or stock");
	const question = requireString(body, "question", 2000);
	const context = body.context ?? {};
	if (typeof context !== "object" || context === null || Array.isArray(context)) throw new HttpError(400, "context must be an object");
	if (body.explicitMode !== undefined && body.explicitMode !== null && !MODES.includes(body.explicitMode as string)) throw new HttpError(400, `explicitMode must be one of ${MODES.join(", ")}`);
	if (body.attestation !== undefined && typeof body.attestation !== "boolean") throw new HttpError(400, "attestation must be a boolean");
	if (body.reaskOf !== undefined && body.reaskOf !== null && (typeof body.reaskOf !== "string" || body.reaskOf.length > 100)) throw new HttpError(400, "reaskOf must be an answer_id");
	const ref = askRef(body.ref, isAdmin(rc));
	await takeQuota(rc.env, `user:${session.userId}`, "ask", LIMITS.asksPerUserPerMinute, 60);
	await takeClientQuota(rc, "ask", LIMITS.asksPerClientPerMinute, 60);
	await takeQuota(rc.env, "global", "ask", LIMITS.asksGlobalPerMinute, 60);
	const request: Record<string, unknown> = { question, context };
	if (body.explicitMode) request.explicitMode = body.explicitMode;
	if (body.attestation !== undefined) request.attestation = body.attestation;
	if (Array.isArray(body.history)) request.history = (body.history as unknown[]).slice(-10);
	// A re-ask after an override or an attestation belongs to the question it re-asks (charts count questions).
	const reaskOf = typeof body.reaskOf === "string" && body.reaskOf ? await ledgerStub(rc.env, session.userId).questionOf(body.reaskOf) : undefined;
	if (reaskOf === null) throw new HttpError(404, `answer ${body.reaskOf as string} is not in your ledger`);
	const card = await serveAsk({ env: rc.env, exports: exportsOf(rc.ctx) }, { repo, ref, request, useModel: body.useModel === true, userId: session.userId, fallback: ref === "main", ...(reaskOf ? { reaskOf } : {}) });
	return json(card);
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
	refuseTestSession(session, "commit a ledger");
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
	// A new tag keeps any floor the latest release tightened (the demo release invariants).
	const latest = (await listStockTags(rc.env))[0] ?? null;
	const floor = latest && latest !== tag ? keepFloorTightening(bundled.files, await readStockFiles(rc.env, latest).then((f) => f["tests/invariants/manifest.json"] ?? null)) : { files: bundled.files, kept: [] };
	const result = await publishStockRelease(rc.env, { ...bundled, files: floor.files, tag, notes: typeof body.notes === "string" ? body.notes : undefined, safety: body.safety === true, keptInvariants: floor.kept });
	await recordRelease(rc.env, result.tag, result.release, result.commit);
	const synced = await syncStockReleases(rc.env);
	return json({ ...result, synced, keptInvariants: result.alreadyPublished ? [] : floor.kept }, result.alreadyPublished ? 200 : 201);
});

route("POST", "/api/admin/forks/:repo/delete", async (rc, { repo }) => {
	requireAdmin(rc);
	const name = repoParam(repo!);
	if (name === STOCK_REPO) throw new HttpError(400, "refusing to delete stock");
	const deleted = await rc.env.ARTIFACTS.delete(name).catch(() => false);
	const inboxDeleted = await removeInbox(rc.env, name).catch(() => false);
	const removed = await fleetStub(rc.env).remove(name);
	return json({ repo: name, deleted, inboxDeleted, removedFromFleet: removed });
});

// One run of the end-to-end tiers against a fork commit, with no state change (a dry run of a yellow soak pass).
route("POST", "/api/admin/e2e", async (rc) => {
	requireAdmin(rc);
	const body = await readJson(rc.request);
	const repo = repoParam(requireString(body, "repo", 100));
	let commit: string | null;
	{
		using handle = await openRepo(rc.env.ARTIFACTS, repo);
		commit = await headOf(handle, shortRef(typeof body.ref === "string" ? body.ref : "main"));
	}
	if (!commit) throw new HttpError(404, "ref not found");
	return json(await runE2E({ env: rc.env, exports: exportsOf(rc.ctx) }, { repo, commit, runId: `run_e2e_dry_${commit.slice(0, 8)}_${Date.now().toString(36)}` }));
});

// Fleet baseline: one dry run of the end-to-end tiers against each fork's main, a page at a time.
// It records the result on the fork (a failing fork is flagged) and changes nothing else: no rollback, no health change.
route("POST", "/api/admin/fleet/baseline", async (rc) => {
	requireAdmin(rc);
	const body = await readJson(rc.request);
	const fleet = fleetStub(rc.env);
	const all = (await fleet.list()).filter((f) => f.status !== "provisioning").map((f) => f.repo);
	const offset = typeof body.offset === "number" ? body.offset : 0;
	const page = baselinePage(all, { offset, limit: typeof body.limit === "number" ? body.limit : BASELINE_LIMITS.defaultPage });
	const concurrency = Math.min(BASELINE_LIMITS.maxConcurrency, Math.max(1, Math.floor(typeof body.concurrency === "number" ? body.concurrency : BASELINE_LIMITS.defaultConcurrency)));
	const record = body.record !== false;
	const results: Record<string, unknown>[] = [];
	let next = 0;
	const worker = async () => {
		while (next < page.repos.length) {
			const repo = page.repos[next++]!;
			results.push(await baselineFork(rc, repo, record));
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, page.repos.length) }, worker));
	results.sort((a, b) => String(a.repo).localeCompare(String(b.repo)));
	return json({ total: all.length, offset: Math.max(0, Math.floor(offset)), count: page.repos.length, next: page.next, recorded: record, results });
});

async function baselineFork(rc: RouteContext, repo: string, record: boolean): Promise<Record<string, unknown>> {
	try {
		let commit: string | null;
		{
			using handle = await openRepo(rc.env.ARTIFACTS, repo);
			commit = await headOf(handle, "main");
		}
		if (!commit) return { repo, error: "no main branch" };
		const deps = { env: rc.env, exports: exportsOf(rc.ctx) };
		const runId = `run_baseline_${commit.slice(0, 8)}_${Date.now().toString(36)}`;
		let run = await runE2E(deps, { repo, commit, runId });
		let retried = false;
		if (!run.passed && run.retryable) {
			run = await runE2E(deps, { repo, commit, runId, fresh: `baseline-${Date.now().toString(36)}` });
			retried = true;
		}
		// Failures that may come from the platform do not flag a fork.
		if (!run.passed && run.retryable) return { repo, commit, inconclusive: true, retried, failure: baselineRecord(run).failure };
		const baseline = baselineRecord(run);
		if (record) await fleetStub(rc.env).recordBaseline(repo, baseline);
		return { repo, ...baseline, retried };
	} catch (error) {
		return { repo, error: scrubText(error instanceof Error ? error.message : String(error)).slice(0, 300) };
	}
}

// Starts a yellow soak on a fork's current main (re-verifies a fork; with no earlier green commit a failure cannot roll back).
route("POST", "/api/admin/yellow/:repo", async (rc, { repo }) => {
	requireAdmin(rc);
	const name = repoParam(repo!);
	const entry = await fleetStub(rc.env).get(name);
	if (!entry) throw new HttpError(404, "fork not found");
	let head: string | null;
	{
		using handle = await openRepo(rc.env.ARTIFACTS, name);
		head = await headOf(handle, "main");
	}
	if (!head) throw new HttpError(404, "fork has no main branch");
	// A nonce in the instance id: a re-check always starts a new run, even for a commit whose earlier run finished or errored.
	const started = await startYellowRun(rc.env, appExports(rc.ctx), { repo: name, commit: head, previous: entry.health.lastGreenCommit ?? head, source: "admin", nonce: Date.now().toString(36) });
	return json({ repo: name, commit: head, runId: started.runId, created: started.created }, started.created ? 202 : 200);
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
	refuseTestSession(session, "change a fork");
	if (repo !== forkRepoName(session.userId)) throw new HttpError(403, "you can change only your own fork");
	return session;
}

route("POST", "/api/customize", async (rc) => {
	const body = await readJson(rc.request);
	const repo = repoParam(requireString(body, "repo", 100));
	const session = await requireForkAccess(rc, repo);
	const request = requireString(body, "request", 1000);
	if (isAdminTestRequest(request) && !isAdmin(rc)) throw new HttpError(403, "test recipes are admin-only");
	const entry = await fleetStub(rc.env).get(repo);
	if (!entry) throw new HttpError(404, `fork ${repo} is not in the fleet`);
	await takeQuota(rc.env, `user:${session?.userId ?? "admin"}`, "customize", LIMITS.customizationsPerUserPerHour, 3600);
	const runId = newRunId("customize");
	await runsStub(rc.env, runId).create({ id: runId, kind: "customize", repo, status: "running", fields: { request: cleanText(request, 1000) } });
	await appExports(rc.ctx).CustomizeWorkflow.create({ id: runId, params: { runId, repo, request, userId: session?.userId ?? userIdFromForkRepo(repo) ?? "admin", persona: entry.persona, admin: isAdmin(rc) } });
	return json({ runId }, 202);
});

// Contest: N contestants compete to grant one wish (workflows/contest.ts). Costs N customizations.
route("POST", "/api/contests", async (rc) => {
	const body = await readJson(rc.request);
	const repo = repoParam(requireString(body, "repo", 100));
	const session = await requireForkAccess(rc, repo);
	const request = requireString(body, "request", 1000);
	if (isAdminTestRequest(request)) throw new HttpError(400, "test recipes cannot run as a contest");
	let options: { size: number; includeAgent: boolean };
	try {
		options = parseContestOptions(body);
	} catch (error) {
		throw new HttpError(400, error instanceof Error ? error.message : String(error));
	}
	const entry = await fleetStub(rc.env).get(repo);
	if (!entry) throw new HttpError(404, `fork ${repo} is not in the fleet`);
	const fleet = fleetStub(rc.env);
	// The contest run owns the fork's contest lease; only it releases it when it ends.
	const contestId = newContestId();
	const runId = contestRunId(contestId);
	if (!(await fleet.tryLock(contestLockKey(repo), CONTEST_LIMITS.lockTtlMs, runId))) throw new HttpError(409, "a contest is already running on this fork; ship one of its contestants or wait for it to end");
	const quota = contestQuota(rc.env);
	const subject = `user:${session?.userId ?? "admin"}`;
	let refused: string | null;
	try {
		refused = await takeContestQuota(quota, subject, options.size, LIMITS.customizationsPerUserPerHour);
	} catch (error) {
		await fleet.unlock(contestLockKey(repo), runId);
		throw error;
	}
	if (refused) {
		await fleet.unlock(contestLockKey(repo), runId);
		throw new HttpError(429, refused);
	}
	const joinUntil = options.includeAgent ? new Date(Date.now() + CONTEST_LIMITS.joinWindowMs).toISOString() : null;
	const agentBranch = options.includeAgent ? agentInboxBranch(contestId) : null;
	const seats = lineup({ recipe: matchRecipe(request) !== null, size: options.size, includeAgent: options.includeAgent });
	const contestants = seats.map((s) => ({ label: s.label, kind: s.kind, title: s.title, status: s.kind === "agent" ? "waiting for your push" : "queued", runId: contestantRunId(contestId, s.label) }));
	try {
		await runsStub(rc.env, runId).create({ id: runId, kind: "contest", repo, status: "running", fields: { request: cleanText(request, 1000), contestId, size: options.size, includeAgent: options.includeAgent, joinUntil, agentBranch, contestants } });
		await fleet.openContest(repo, { contestId, runId, status: "open", includeAgent: options.includeAgent, joinUntil, agentJoined: false });
		await appExports(rc.ctx).ContestWorkflow.create({ id: runId, params: { runId, contestId, repo, request, userId: session?.userId ?? userIdFromForkRepo(repo) ?? "admin", persona: entry.persona, size: options.size, includeAgent: options.includeAgent } });
	} catch (error) {
		// Nothing runs this contest: close it so no inbox push can join it, free the fork, and give the quota back.
		await abandonContest(rc.env, { repo, contestId, runId, subject, size: options.size }, error).catch((cleanup) => console.error(`contest ${runId} cleanup failed: ${scrubText(String(cleanup))}`));
		throw error;
	}
	return json({ runId, contestId, joinUntil, agentBranch }, 202);
});

function contestQuota(env: Env): QuotaAccess {
	return {
		take: (subject, bucket, limit, window) => quotaStub(env, subject).take(bucket, limit, window),
		give: async (subject, bucket, window) => {
			await quotaStub(env, subject).give(bucket, window);
		},
	};
}

/** A contest that could not start after its lease and quota were taken: closed, unlocked, and refunded. */
async function abandonContest(env: Env, c: { repo: string; contestId: string; runId: string; subject: string; size: number }, error: unknown): Promise<void> {
	const fleet = fleetStub(env);
	await fleet.setContestStatus(c.repo, c.contestId, "done");
	await fleet.unlock(contestLockKey(c.repo), c.runId);
	const run = runsStub(env, c.runId);
	if (await run.get()) await run.update({ status: "failed", error: `the contest could not start: ${scrubText(error instanceof Error ? error.message : String(error)).slice(0, 300)}` });
	await refundContestQuota(contestQuota(env), c.subject, c.size);
}

// Ship a contestant: the rule's winner or another contestant that passed every tier and every wish test.
route("POST", "/api/contests/:runId/pick", async (rc, { runId }) => {
	if (!RUN_ID.test(runId!)) throw new HttpError(400, "invalid run id");
	const stub = runsStub(rc.env, runId!);
	const run = await stub.get();
	if (!run || run.kind !== "contest" || typeof run.contestId !== "string") throw new HttpError(404, `contest ${runId} not found`);
	await requireForkAccess(rc, run.repo ?? "");
	const body = await readJson(rc.request);
	const label = requireString(body, "label", 20);
	if (run.picked || run.pickRequested) throw new HttpError(409, "a contestant was already picked in this contest");
	if (run.status !== "waiting" || !Array.isArray(run.entrants)) throw new HttpError(409, "this contest is not waiting for a pick");
	const check = pickNotes(run.entrants as never, label);
	if (!check.ok) throw new HttpError(400, check.error);
	await stub.update({ pickRequested: label });
	await (await appExports(rc.ctx).ContestWorkflow.get(runId!)).sendEvent({ type: "contest-pick", payload: { label } });
	return json(await stub.get());
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
		if (!original.probe) throw new HttpError(400, "end-to-end scenario suggestions are accepted or rejected; edit tests/user/e2e.json in your fork to change one");
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
	const refusal = directGateRefusal(branch);
	if (refusal) throw new HttpError(400, refusal);
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

// One-tap upgrade: fast-forward main to the gated upgrade/<tag> or replay/<tag> commit recorded as the fork's pending upgrade.
// It is refused when main moved since the upgrade was gated (main no longer an ancestor of the gated commit).
route("POST", "/api/forks/:repo/upgrade", async (rc, { repo }) => {
	const name = repoParam(repo!);
	await requireForkAccess(rc, name);
	const fleet = fleetStub(rc.env);
	const entry = await fleet.get(name);
	const pending = entry?.pendingUpgrade;
	if (!entry || !pending) throw new HttpError(409, "no gated upgrade is waiting for approval on this fork");
	const remote = await repoRemote(rc.env, name, "write");
	const ws = await cloneRepo({ ...remote, ref: "main", singleBranch: true });
	// The pending upgrade names the branch it gated: upgrade/<tag>, or replay/<tag> after intent replay.
	const ff = await fastForwardToPending(ws, pending, (branch) => fetchBranch(ws, remote, branch));
	const previous = ff.previous;
	if (ff.outcome === "diverged") throw new HttpError(409, `main moved since ${ff.branch} was gated at ${pending.commit.slice(0, 7)}; a new upgrade run is needed`);
	if (ff.outcome === "fast-forward") await pushBranch(ws, remote, "main");
	// A repeated tap after a push whose response was lost finds main at the commit with no yellow run for it yet.
	const landed = ff.outcome === "fast-forward" || landedEarlier({ mainHead: ff.oid, commit: pending.commit, healthCommit: entry.health.commit });
	const lastRun: RunSummary = entry.lastRun?.runId === pending.runId ? { ...entry.lastRun, applied: true, at: new Date().toISOString() } : { runId: pending.runId, kind: "upgrade", tag: pending.tag, status: "passed", applied: true, commit: pending.commit, at: new Date().toISOString() };
	// The pin goes first: a fast rollback restores the old pin, and nothing after the yellow start may overwrite it.
	// The pending upgrade stays until the yellow run has started, so a repeated tap can still start it.
	await fleet.update(name, { pinnedTag: pending.tag });
	// The approved upgrade is live: it soaks in yellow like every other change that lands on main.
	const yellow = landed ? await startYellowRun(rc.env, appExports(rc.ctx), { repo: name, commit: pending.commit, previous: ff.outcome === "fast-forward" ? previous : await firstParent(ws, pending.commit), source: "one-tap", parentRunId: pending.runId }) : null;
	const updated = await fleet.update(name, { status: "passed", pendingUpgrade: null, lastRun });
	forkInfoCache.delete(name);
	return json({ repo: name, tag: pending.tag, commit: pending.commit, fork: updated, yellowRunId: yellow?.runId ?? null });
});

// Bring your own agent: a one hour write token for the inbox of the session's own fork (never for
// the fork itself). Every request replaces the inbox with a fresh Artifacts fork of the fork's main, which
// also ends the previous token (it is revoked first as well); a cleanup workflow deletes it after expiry. work/* pushes to it are
// imported into the fork and gated (forks/inbox.ts, workflows/import.ts). One mint per fork at a time.
route("POST", "/api/forks/:repo/token", async (rc, { repo }) => {
	const name = repoParam(repo!);
	const session = await requireSession(rc);
	refuseTestSession(session, "get a git token");
	if (name !== forkRepoName(session.userId)) throw new HttpError(403, "you can get a token only for your own fork");
	const fleet = fleetStub(rc.env);
	const entry = await fleet.get(name);
	if (!entry) throw new HttpError(404, "you have no fork yet: POST /api/forks first");
	if (entry.status === "provisioning") throw new HttpError(409, "your fork is still being provisioned; try again in a few seconds");
	await takeQuota(rc.env, `user:${session.userId}`, "outside-token", LIMITS.outsideTokensPerUserPerHour, 3600);
	await takeClientQuota(rc, "outside-token", LIMITS.outsideTokensPerClientPerHour, 3600);
	await takeQuota(rc.env, "global", "outside-token", LIMITS.outsideTokensGlobalPerHour, 3600);
	const key = outsideGrantKey(name);
	const lock = `lock:${key}`;
	const owner = crypto.randomUUID();
	if (!(await fleet.tryLock(lock, 30_000, owner))) throw new HttpError(409, "a token for this fork is being minted right now; try again in a few seconds");
	try {
		const previous = (await fleet.getValue(key)) as OutsideGrant | null;
		const inbox = inboxRepoName(name);
		// Deleting the inbox should end its tokens too; revoking the last one first does not rely on that.
		if (previous?.tokenId) await revokePreviousToken(rc.env, previous.inbox, previous.tokenId);
		using handle = await freshInbox(rc.env, name, inbox);
		const minted = await mintOutsideToken(handle, { fork: name, inbox }, null);
		const at = new Date().toISOString();
		const grant: OutsideGrant = { repo: name, inbox, userId: session.userId, tokenId: minted.tokenId, firstAt: previous?.firstAt ?? at, mintedAt: at, expiresAt: minted.access.expiresAt };
		await fleet.setValue(key, grant as unknown as Json);
		try {
			await appExports(rc.ctx).InboxCleanupWorkflow.create({ id: `inboxgc-${fnv1a(name)}-${fnv1a(minted.tokenId)}`, params: { fork: name, inbox, tokenId: minted.tokenId, expiresAt: minted.access.expiresAt } });
		} catch (error) {
			// The inbox then lives until the next token or the fork's deletion; the token still expires on time.
			console.warn(`inbox cleanup for ${inbox} not scheduled: ${scrubText(error instanceof Error ? error.message : String(error))}`);
		}
		console.log(`outside token minted for ${inbox} (token id ${minted.tokenId}, expires ${minted.access.expiresAt})`);
		return json(minted.access, 201);
	} finally {
		await fleet.unlock(lock, owner);
	}
});

/** Revokes the previous outside token on the inbox it was made for. Best effort: a failure is logged, never thrown. */
async function revokePreviousToken(env: Env, inbox: string, tokenId: string): Promise<void> {
	try {
		using handle = await openRepo(env.ARTIFACTS, inbox);
		if (!(await handle.revokeToken(tokenId))) console.warn(`previous outside token ${tokenId} for ${inbox} was not revoked: not found (already expired or revoked)`);
	} catch (error) {
		console.warn(`previous outside token ${tokenId} for ${inbox} was not revoked: ${scrubText(error instanceof Error ? error.message : String(error))}`);
	}
}

/** Replaces the fork's inbox with a new Artifacts fork of the fork's main (no other branches), so nothing from earlier tokens remains. */
async function freshInbox(env: Env, fork: string, inbox: string): Promise<ArtifactsRepo> {
	await deleteRepoIfPresent(env, inbox);
	{
		using source = await openRepo(env.ARTIFACTS, fork);
		await source.fork(inbox, { description: `Outside agent inbox for ${fork}: work/* branches are imported into the fork and gated`, defaultBranchOnly: true });
	}
	return env.ARTIFACTS.get(inbox);
}

async function deleteRepoIfPresent(env: Env, name: string): Promise<boolean> {
	try {
		return await env.ARTIFACTS.delete(name);
	} catch (error) {
		if (isNotFound(error) || /not found/i.test(String((error as Error)?.message))) return false;
		throw error;
	}
}

/** A deleted fork takes its inbox and its outside grant with it (neither is a fleet entry). */
async function removeInbox(env: Env, fork: string): Promise<boolean | null> {
	const fleet = fleetStub(env);
	const grant = (await fleet.getValue(outsideGrantKey(fork))) as OutsideGrant | null;
	if (!grant) return null;
	const deleted = await deleteRepoIfPresent(env, grant.inbox);
	await fleet.deleteValue(outsideGrantKey(fork));
	return deleted;
}

// Apply a repair branch: gate repair/<sha> in merge mode; main fast-forwards to it only if it passes.
route("POST", "/api/forks/:repo/repairs/:sha/apply", async (rc, { repo, sha }) => {
	const name = repoParam(repo!);
	await requireForkAccess(rc, name);
	if (!/^[0-9a-f]{7}$/.test(sha!)) throw new HttpError(400, "repair id must be the 7 hex characters of repair/<sha>");
	const branch = `repair/${sha}`;
	let commit: string | null;
	{
		using handle = await openRepo(rc.env.ARTIFACTS, name);
		commit = await headOf(handle, branch);
	}
	if (!commit) throw new HttpError(404, `${branch} not found`);
	const started = await startGateInstance(appExports(rc.ctx).GateWorkflow, gateInstanceId(name, `apply:${branch}`, commit), { repo: name, branch, commit, mode: "merge", source: "repair-apply" });
	// The run record exists as soon as this returns, so the caller can poll it right away.
	await ensureRun(rc.env, { id: started.runId, kind: "gate", repo: name, fields: { branch, commit, mode: "merge", source: "repair-apply", parentRunId: null, regateOf: null } });
	return json({ runId: started.runId, branch, commit, created: started.created }, started.created ? 202 : 200);
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
		const { files, changed } = demoReleaseFiles(current, tag);
		const intentId = newIntentId();
		const tightened = changed.includes("tests/invariants/manifest.json") ? DEMO_OVERLAY.probes.map((p) => p.id) : [];
		const intent = { id: intentId, author: "mothership:clinical-informatics", agent: null, request: `Release ${tag}${safety ? " (safety release)" : ""}`, purpose: cleanText(notes, 400) || `Stock release ${tag}`, modes_affected: ["research", "administrative"], files: changed, tests_added: tightened.map((id) => `tests/invariants/manifest.json#${id}`), stock_tag: tag };
		result = await publishStockRelease(rc.env, { tag, files: { ...files, [`.intent/${intentId}.json`]: `${JSON.stringify(intent, null, 2)}\n` }, intentId, notes, safety });
	}
	await recordRelease(rc.env, tag, result.release, result.commit);
	const forks = await fleetStub(rc.env).list();
	const repos = upgradeTargets(tag, forks);
	const rerun = rerunTargets(tag, forks);
	const runId = newRunId("release");
	await runsStub(rc.env, runId).create({ id: runId, kind: "release", status: "running", fields: { tag, safety, forks: repos.length, rerun: rerun.length } });
	// Intent replay is on unless the request turns it off with replay: false.
	const replay = body.replay !== false;
	await appExports(rc.ctx).ReleaseWorkflow.create({ id: runId, params: { runId, tag, safety: result.release?.safety ?? safety, graceUntil: result.release?.graceUntil ?? null, repos, rerun, ...(replay ? {} : { replay: false }) } });
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
				await removeInbox(rc.env, repo);
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

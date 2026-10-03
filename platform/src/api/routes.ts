// Platform HTTP API (docs/IMPLEMENTATION_PLAN.md, "Platform HTTP API").
// Write routes need the demo session cookie; admin routes need x-fluid-admin.
import { getForkInfo, findPersona, fleetStub, ForkNotFoundError, personas, provisionFork, readIntents, type ForkInfo } from "../forks/provision.ts";
import { forkRepoName, isValidRepoName, newSandboxUserId, STOCK_REPO } from "../lib/names.ts";
import { readCookie, safeEqual, SESSION_COOKIE, sessionCookieHeader, signSession, verifySession, type Session } from "../lib/session.ts";
import { askFork, type PlatformExports } from "../runtime/loader.ts";
import { RefNotFoundError } from "../runtime/refs.ts";
import { RepoNotFoundError } from "../runtime/repo-files.ts";
import { bundledStockRelease, publishStockRelease } from "../stock/publish.ts";
import { runStockSuite } from "../stock/suite.ts";
import type { RunTimeRecord } from "../durable/user-ledger.ts";
import { ledgerStub, quotaStub } from "../stubs.ts";
import { HttpError, json, notImplemented, readJson, requireString } from "./http.ts";

export const LIMITS = {
	sessionsPerClientPerHour: 20,
	asksPerUserPerMinute: 10,
	asksGlobalPerMinute: 300,
	overridesPerUserPerMinute: 30,
	forksPerSession: 1,
	forksTotal: 500,
	ledgerCommitsPerUserPerHour: 6,
};

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
	let methodMismatch = false;
	for (const r of routes) {
		const match = r.pattern.exec(rc.url.pathname);
		if (!match) continue;
		if (r.method !== rc.request.method) {
			methodMismatch = true;
			continue;
		}
		const params = Object.fromEntries(r.keys.map((key, i) => [key, decodeURIComponent(match[i + 1]!)]));
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
	return rc.request.headers.get("cf-connecting-ip") ?? "local";
}

function exportsOf(ctx: ExecutionContext): PlatformExports {
	return (ctx as unknown as { exports: PlatformExports }).exports;
}

function repoParam(value: string): string {
	if (!isValidRepoName(value)) throw new HttpError(400, `invalid repository name ${JSON.stringify(value)}`);
	return value;
}

async function forkInfoOrNull(env: Env, repo: string): Promise<ForkInfo | null> {
	try {
		return await getForkInfo(env, repo);
	} catch (error) {
		if (error instanceof ForkNotFoundError) return null;
		throw error;
	}
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
	await takeQuota(rc.env, `client:${clientId(rc)}`, "session", LIMITS.sessionsPerClientPerHour, 3600);
	const session: Session = { userId: newSandboxUserId(), persona: persona.id, issuedAt: Date.now() };
	const cookie = sessionCookieHeader(await signSession(session, rc.env.SESSION_SECRET), rc.url.protocol === "https:");
	return json({ userId: session.userId, persona: session.persona }, 200, { "set-cookie": cookie });
});

route("GET", "/api/personas", async () => json(personas()));

route("GET", "/api/me", async (rc) => {
	const session = await requireSession(rc);
	const known = await fleetStub(rc.env).forksOfUser(session.userId);
	const fork = known.length > 0 ? await forkInfoOrNull(rc.env, known[0]!.repo) : null;
	return json({ userId: session.userId, persona: session.persona, fork });
});

route("POST", "/api/forks", async (rc) => {
	const session = await requireSession(rc);
	const body = await readJson(rc.request);
	const fleet = fleetStub(rc.env);
	const own = await fleet.forksOfUser(session.userId);
	if (own.length === 0 && (await fleet.count()) >= LIMITS.forksTotal) throw new HttpError(429, "the demo fleet is full; try again later");
	if (own.length >= LIMITS.forksPerSession && own[0]!.repo !== forkRepoName(session.userId)) throw new HttpError(429, "this session already has a fork");
	const persona = findPersona(session.persona);
	if (!persona) throw new HttpError(400, `unknown persona ${session.persona}`);
	const preferences = (body.preferences ?? {}) as Record<string, unknown>;
	const info = await provisionFork(rc.env, {
		userId: session.userId,
		persona,
		preferences: { auto_upgrade: preferences.auto_upgrade as boolean | undefined, harvest_opt_in: preferences.harvest_opt_in as boolean | undefined },
	});
	return json(info, 201);
});

route("GET", "/api/forks/:repo", async (rc, { repo }) => {
	const info = await forkInfoOrNull(rc.env, repoParam(repo!));
	if (!info) throw new HttpError(404, `fork ${repo} not found`);
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
	await takeQuota(rc.env, `user:${session.userId}`, "ask", LIMITS.asksPerUserPerMinute, 60);
	await takeQuota(rc.env, "global", "ask", LIMITS.asksGlobalPerMinute, 60);
	const request: Record<string, unknown> = { question, context };
	if (body.explicitMode) request.explicitMode = body.explicitMode;
	if (body.attestation !== undefined) request.attestation = body.attestation;
	if (Array.isArray(body.history)) request.history = (body.history as unknown[]).slice(-10);
	let result;
	try {
		result = await askFork(
			{ env: rc.env, exports: exportsOf(rc.ctx) },
			{ repo, ref: typeof body.ref === "string" ? body.ref : "main", request, useModel: body.useModel === true },
		);
	} catch (error) {
		if (error instanceof RefNotFoundError || error instanceof RepoNotFoundError) throw new HttpError(404, error.message);
		throw error;
	}
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
	try {
		return json(await readIntents(rc.env, name, rc.url.searchParams.get("ref") ?? "main"));
	} catch (error) {
		if (error instanceof ForkNotFoundError) throw new HttpError(404, error.message);
		throw error;
	}
});

route("GET", "/api/fleet", async (rc) => json(await fleetStub(rc.env).snapshot()));

route("GET", "/api/fleet/stream", async (rc) => fleetStub(rc.env).fetch(new Request("https://fleet/stream", { signal: rc.request.signal })));

route("POST", "/api/admin/stock/publish", async (rc) => {
	requireAdmin(rc);
	const result = await publishStockRelease(rc.env, bundledStockRelease());
	await fleetStub(rc.env).addStockTag(result.tag);
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
	return json(await runStockSuite({ env: rc.env, exports: exportsOf(rc.ctx) }, repo, typeof body.ref === "string" ? body.ref : "main", { samples }));
});

// Stage 3 implements these.
route("POST", "/api/customize", async () => notImplemented("customize"));
route("GET", "/api/runs/:runId", async () => notImplemented("runs"));
route("POST", "/api/suggestions/:runId/decide", async () => notImplemented("suggestions"));
route("GET", "/api/gates/:repo", async () => notImplemented("gates"));
route("POST", "/api/admin/release", async () => notImplemented("release"));
route("POST", "/api/admin/fleet/seed", async () => notImplemented("fleet seed"));
route("POST", "/api/admin/harvest", async () => notImplemented("harvest"));
route("GET", "/api/harvest", async () => notImplemented("harvest"));

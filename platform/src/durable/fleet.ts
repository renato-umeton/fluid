// Fleet registry: every fork with its persona, pinned stock tag, status, and
// last run, plus the published stock tags. One instance ("global"). Status
// changes are broadcast to Server-Sent Events subscribers (the fleet view).
import { DurableObject } from "cloudflare:workers";
import type { Json } from "../lib/json.ts";
import type { BaselineRecord } from "../yellow/baseline.ts";
import { cancelRun, initialHealth, recordBrowser, recordFailure, recordPass, startYellow, type BrowserSummary, type HealthEvent, type HealthFailure, type HealthState, type Transition } from "../yellow/state.ts";

/**
 * Fork statuses as the fleet view shows them. "pinned": on its pinned tag with
 * nothing running. "passed": an upgrade passed (lastRun.applied says whether it
 * was merged or waits for one-tap approval). "repair_open": a gate failed and a
 * repair branch is open. "failed": a gate failed and no repair branch exists
 * (yet). Older names are accepted on write and mapped (ready -> pinned,
 * repair -> repair_open).
 */
export type ForkStatus = "provisioning" | "pinned" | "upgrading" | "gating" | "passed" | "failed" | "repair_open";
export type ForkStatusInput = ForkStatus | "ready" | "repair";

export function normalizeStatus(status: string): ForkStatus {
	if (status === "ready") return "pinned";
	if (status === "repair") return "repair_open";
	return status as ForkStatus;
}

export interface ReleaseRecord {
	tag: string;
	notes: string;
	safety: boolean;
	date: string;
	graceDays: number | null;
	graceUntil: string | null;
	commit: string | null;
}

export interface RunSummary {
	runId: string;
	kind: string;
	status: string;
	at: string;
	[key: string]: Json;
}

/** A gated upgrade waiting for the user's one-tap approval (auto_upgrade off). Kept apart from lastRun, which later runs overwrite. */
export interface PendingUpgrade {
	tag: string;
	commit: string;
	runId: string;
}

/** Stock release a fork is served from after a safety grace period ends (spec 7). */
export interface SafetyFallback {
	tag: string;
	from: string;
	graceUntil: string;
}

export interface FleetFork {
	repo: string;
	userId: string;
	persona: string;
	pinnedTag: string;
	status: ForkStatus;
	lastRun: RunSummary | null;
	pendingUpgrade: PendingUpgrade | null;
	seeded: boolean;
	createdAt: string;
	updatedAt: string;
	/** Yellow to green lifecycle of main (a fork with no history is green). */
	health: HealthState;
	/** Latest fleet baseline: one dry run of the end-to-end tiers against main (a failing one flags the fork; nothing rolls back). */
	baseline: BaselineRecord | null;
}

export interface FleetSnapshot {
	stockTags: string[];
	releases: ReleaseRecord[];
	counts: Record<string, number>;
	healthCounts: Record<string, number>;
	baselineCounts: { passed: number; flagged: number; none: number };
	forks: (Omit<FleetFork, "userId" | "createdAt"> & { graceUntil: string | null })[];
}

export type FleetEvent =
	| { type: "fork"; fork: FleetFork }
	| { type: "removed"; repo: string }
	| { type: "stockTags"; stockTags: string[] }
	| ({ type: "release"; at: string } & ReleaseRecord);

const GATES_PER_REPO = 20;
const HEALTH_HISTORY_PER_REPO = 50;

const encoder = new TextEncoder();
const HEARTBEAT_MS = 25_000;

/**
 * Fleet stream caps for the public demo. A subscriber whose unread backlog
 * passes `backlogBytes` is dropped, so a client that stops reading cannot
 * make this object buffer without bound.
 */
export const FLEET_STREAM_LIMITS = { total: 200, perClient: 5, backlogBytes: 256 * 1024 };

/** A provisioning claim older than this is treated as abandoned and can be taken over. */
export const PROVISIONING_STALE_MS = 10 * 60 * 1000;

export type ClaimOutcome = "claimed" | "exists" | "busy" | "full";

interface Subscriber {
	writer: WritableStreamDefaultWriter<Uint8Array>;
	client: string;
}

export class Fleet extends DurableObject<Env> {
	private subscribers = new Set<Subscriber>();
	private heartbeat: ReturnType<typeof setInterval> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const sql = ctx.storage.sql;
		sql.exec(
			"CREATE TABLE IF NOT EXISTS forks (repo TEXT PRIMARY KEY, user_id TEXT NOT NULL, persona TEXT NOT NULL, pinned_tag TEXT NOT NULL, status TEXT NOT NULL, last_run TEXT, seeded INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
		);
		sql.exec("CREATE INDEX IF NOT EXISTS forks_user ON forks (user_id)");
		const columns = sql.exec("PRAGMA table_info(forks)").toArray().map((r) => r.name as string);
		if (!columns.includes("pending_upgrade")) sql.exec("ALTER TABLE forks ADD COLUMN pending_upgrade TEXT");
		if (!columns.includes("health")) sql.exec("ALTER TABLE forks ADD COLUMN health TEXT");
		if (!columns.includes("baseline")) sql.exec("ALTER TABLE forks ADD COLUMN baseline TEXT");
		sql.exec("CREATE TABLE IF NOT EXISTS health_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, event TEXT NOT NULL)");
		sql.exec("CREATE INDEX IF NOT EXISTS health_history_repo ON health_history (repo, seq)");
		sql.exec("CREATE TABLE IF NOT EXISTS stock_tags (tag TEXT PRIMARY KEY, published_at TEXT NOT NULL)");
		sql.exec("CREATE TABLE IF NOT EXISTS releases (tag TEXT PRIMARY KEY, record TEXT NOT NULL)");
		sql.exec("CREATE TABLE IF NOT EXISTS gates (seq INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, at TEXT NOT NULL, result TEXT NOT NULL)");
		sql.exec("CREATE INDEX IF NOT EXISTS gates_repo ON gates (repo, seq)");
		sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
	}

	register(input: { repo: string; userId: string; persona: string; pinnedTag: string; status?: ForkStatusInput; seeded?: boolean }, at = Date.now()): FleetFork {
		const now = new Date(at).toISOString();
		this.ctx.storage.sql.exec(
			"INSERT INTO forks (repo, user_id, persona, pinned_tag, status, seeded, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repo) DO UPDATE SET persona = excluded.persona, pinned_tag = excluded.pinned_tag, status = excluded.status, updated_at = excluded.updated_at",
			input.repo,
			input.userId,
			input.persona,
			input.pinnedTag,
			normalizeStatus(input.status ?? "pinned"),
			input.seeded ? 1 : 0,
			now,
			now,
		);
		const fork = this.get(input.repo)!;
		this.broadcast({ type: "fork", fork });
		return fork;
	}

	get(repo: string): FleetFork | null {
		const row = this.ctx.storage.sql.exec("SELECT * FROM forks WHERE repo = ?", repo).toArray()[0];
		return row ? toFork(row) : null;
	}

	forksOfUser(userId: string): FleetFork[] {
		return this.ctx.storage.sql.exec("SELECT * FROM forks WHERE user_id = ? ORDER BY created_at", userId).toArray().map(toFork);
	}

	list(): FleetFork[] {
		return this.ctx.storage.sql.exec("SELECT * FROM forks ORDER BY created_at").toArray().map(toFork);
	}

	/** Forks that exist or are being provisioned; failed provisioning attempts do not count. */
	count(): number {
		return this.ctx.storage.sql.exec("SELECT count(*) AS n FROM forks WHERE status != 'failed'").one().n as number;
	}

	/**
	 * Atomically reserves `repo` for provisioning. "exists": the fork is
	 * already provisioned. "busy": another request is provisioning it (a
	 * workflow retry passes `resume` to continue its own attempt; a claim
	 * older than PROVISIONING_STALE_MS is taken over). "full": a new fork
	 * would pass `maxTotal`. Durable Object calls run one at a time, so the
	 * check and the write cannot interleave with another claim.
	 */
	claimProvisioning(
		input: { repo: string; userId: string; persona: string; pinnedTag: string; seeded?: boolean; maxTotal?: number; resume?: boolean },
		now = Date.now(),
	): { outcome: ClaimOutcome; fork: FleetFork | null } {
		const existing = this.get(input.repo);
		if (existing && existing.status !== "provisioning" && existing.status !== "failed") return { outcome: "exists", fork: existing };
		const provisioning = existing?.status === "provisioning";
		if (provisioning && !input.resume && now - Date.parse(existing.updatedAt) < PROVISIONING_STALE_MS) return { outcome: "busy", fork: existing };
		if (!provisioning && input.maxTotal !== undefined && this.count() >= input.maxTotal) return { outcome: "full", fork: null };
		const fork = this.register({ repo: input.repo, userId: input.userId, persona: input.persona, pinnedTag: input.pinnedTag, status: "provisioning", seeded: input.seeded }, now);
		return { outcome: "claimed", fork };
	}

	/** Updates status, pinned tag, last run, and/or the pending upgrade, then notifies subscribers. */
	update(repo: string, patch: { status?: ForkStatusInput; pinnedTag?: string; lastRun?: RunSummary | null; pendingUpgrade?: PendingUpgrade | null }): FleetFork | null {
		const current = this.get(repo);
		if (!current) return null;
		this.ctx.storage.sql.exec(
			"UPDATE forks SET status = ?, pinned_tag = ?, last_run = ?, pending_upgrade = ?, updated_at = ? WHERE repo = ?",
			patch.status ? normalizeStatus(patch.status) : current.status,
			patch.pinnedTag ?? current.pinnedTag,
			JSON.stringify(patch.lastRun === undefined ? current.lastRun : patch.lastRun),
			JSON.stringify(patch.pendingUpgrade === undefined ? current.pendingUpgrade : patch.pendingUpgrade),
			new Date().toISOString(),
			repo,
		);
		const fork = this.get(repo)!;
		this.broadcast({ type: "fork", fork });
		return fork;
	}

	// ---------- yellow to green ----------

	health(repo: string): HealthState | null {
		return this.get(repo)?.health ?? null;
	}

	/** A gated change landed on main: the fork goes yellow (a newer change supersedes a soaking run). */
	yellowStart(repo: string, input: { commit: string; runId: string; previous: string | null; source: string }): HealthState | null {
		return this.transition(repo, (state, at) => startYellow(state, { ...input, at }));
	}

	yellowPass(repo: string, input: { runId: string; pass: number }): { state: HealthState; stale: boolean } | null {
		return this.transitionReport(repo, (state, at) => recordPass(state, { ...input, at }));
	}

	yellowBrowser(repo: string, input: { runId: string; browser: BrowserSummary }): { state: HealthState; stale: boolean } | null {
		return this.transitionReport(repo, (state, at) => recordBrowser(state, { ...input, at }));
	}

	yellowFailure(repo: string, input: { runId: string; failure: HealthFailure; revertCommit: string | null }): { state: HealthState; stale: boolean } | null {
		return this.transitionReport(repo, (state, at) => recordFailure(state, { ...input, at }));
	}

	yellowCancel(repo: string, input: { runId: string; reason: string }): { state: HealthState; stale: boolean } | null {
		return this.transitionReport(repo, (state, at) => cancelRun(state, { ...input, at }));
	}

	/** Stores a fork's baseline result. It never touches health, status, or main. */
	recordBaseline(repo: string, baseline: BaselineRecord): FleetFork | null {
		if (!this.get(repo)) return null;
		this.ctx.storage.sql.exec("UPDATE forks SET baseline = ? WHERE repo = ?", JSON.stringify(baseline), repo);
		const fork = this.get(repo)!;
		this.broadcast({ type: "fork", fork });
		return fork;
	}

	/** Health events for a fork, newest first. */
	healthHistory(repo: string, limit = HEALTH_HISTORY_PER_REPO): HealthEvent[] {
		return this.ctx.storage.sql.exec("SELECT event FROM health_history WHERE repo = ? ORDER BY seq DESC LIMIT ?", repo, limit).toArray().map((r) => JSON.parse(r.event as string) as HealthEvent);
	}

	private transition(repo: string, fn: (state: HealthState, at: string) => Transition): HealthState | null {
		return this.transitionReport(repo, fn)?.state ?? null;
	}

	/** Applies one state machine transition, appends its events to the history, and broadcasts the fork. */
	private transitionReport(repo: string, fn: (state: HealthState, at: string) => Transition): { state: HealthState; stale: boolean } | null {
		const current = this.get(repo);
		if (!current) return null;
		const at = new Date().toISOString();
		const result = fn(current.health, at);
		const sql = this.ctx.storage.sql;
		for (const event of result.events) sql.exec("INSERT INTO health_history (repo, event) VALUES (?, ?)", repo, JSON.stringify(event));
		if (result.events.length) sql.exec("DELETE FROM health_history WHERE repo = ? AND seq NOT IN (SELECT seq FROM health_history WHERE repo = ? ORDER BY seq DESC LIMIT ?)", repo, repo, HEALTH_HISTORY_PER_REPO);
		if (result.state !== current.health) {
			sql.exec("UPDATE forks SET health = ?, updated_at = ? WHERE repo = ?", JSON.stringify(result.state), at, repo);
			this.broadcast({ type: "fork", fork: this.get(repo)! });
		}
		return { state: result.state, stale: result.stale === true };
	}

	remove(repo: string): boolean {
		this.ctx.storage.sql.exec("DELETE FROM health_history WHERE repo = ?", repo);
		this.ctx.storage.sql.exec("DELETE FROM gates WHERE repo = ?", repo);
		const removed = this.ctx.storage.sql.exec("DELETE FROM forks WHERE repo = ? RETURNING repo", repo).toArray().length > 0;
		if (removed) this.broadcast({ type: "removed", repo });
		return removed;
	}

	addStockTag(tag: string): string[] {
		this.ctx.storage.sql.exec("INSERT INTO stock_tags (tag, published_at) VALUES (?, ?) ON CONFLICT(tag) DO NOTHING", tag, new Date().toISOString());
		const tags = this.stockTags();
		this.broadcast({ type: "stockTags", stockTags: tags });
		return tags;
	}

	stockTags(): string[] {
		return this.ctx.storage.sql
			.exec("SELECT tag FROM stock_tags")
			.toArray()
			.map((r) => r.tag as string)
			.sort(compareTagsAsc);
	}

	/** Records a published release (with safety grace period) and tells subscribers. */
	addRelease(record: ReleaseRecord): ReleaseRecord[] {
		this.ctx.storage.sql.exec("INSERT INTO releases (tag, record) VALUES (?, ?) ON CONFLICT(tag) DO UPDATE SET record = excluded.record", record.tag, JSON.stringify(record));
		this.addStockTag(record.tag);
		this.broadcast({ type: "release", at: new Date().toISOString(), ...record });
		return this.releases();
	}

	releases(): ReleaseRecord[] {
		return this.ctx.storage.sql.exec("SELECT record FROM releases").toArray().map((r) => JSON.parse(r.record as string) as ReleaseRecord);
	}

	/**
	 * Safety fallback (spec 7): once the grace period of the newest safety
	 * release that has expired is over, a fork still pinned below that
	 * release is served by stock at that tag until it upgrades or a repair
	 * merges. A fork whose upgrade to that tag passed and only waits for
	 * approval keeps its own code (it already passed the new floor).
	 */
	safetyFallback(repo: string, now = Date.now()): SafetyFallback | null {
		const fork = this.get(repo);
		if (!fork) return null;
		const expired = this.releases()
			.filter((r) => r.safety && r.graceUntil && Date.parse(r.graceUntil) <= now)
			.sort((a, b) => compareTagsAsc(a.tag, b.tag));
		const latest = expired[expired.length - 1];
		if (!latest || compareTagsAsc(fork.pinnedTag, latest.tag) >= 0) return null;
		if (fork.pendingUpgrade && compareTagsAsc(fork.pendingUpgrade.tag, latest.tag) >= 0) return null;
		return { tag: latest.tag, from: fork.pinnedTag, graceUntil: latest.graceUntil! };
	}

	/** Stores a gate result for GET /api/gates/:repo, keeping the most recent per repo. */
	addGate(repo: string, result: Record<string, Json>): void {
		const sql = this.ctx.storage.sql;
		sql.exec("INSERT INTO gates (repo, at, result) VALUES (?, ?, ?)", repo, new Date().toISOString(), JSON.stringify(result));
		sql.exec("DELETE FROM gates WHERE repo = ? AND seq NOT IN (SELECT seq FROM gates WHERE repo = ? ORDER BY seq DESC LIMIT ?)", repo, repo, GATES_PER_REPO);
	}

	gates(repo: string, limit = GATES_PER_REPO): Json[] {
		return this.ctx.storage.sql.exec("SELECT result FROM gates WHERE repo = ? ORDER BY seq DESC LIMIT ?", repo, limit).toArray().map((r) => JSON.parse(r.result as string) as Json);
	}

	setValue(key: string, value: Json): void {
		this.ctx.storage.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, JSON.stringify(value));
	}

	getValue(key: string): Json | null {
		const row = this.ctx.storage.sql.exec("SELECT v FROM kv WHERE k = ?", key).toArray()[0];
		return row ? (JSON.parse(row.v as string) as Json) : null;
	}

	counts(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const row of this.ctx.storage.sql.exec("SELECT status, count(*) AS n FROM forks GROUP BY status").toArray()) out[row.status as string] = row.n as number;
		return out;
	}

	snapshot(): FleetSnapshot {
		const releases = this.releases();
		const graceOf = (tag: string | undefined) => releases.find((r) => r.tag === tag)?.graceUntil ?? null;
		const forks = this.list();
		const healthCounts: Record<string, number> = { green: 0, yellow: 0, rolled_back: 0 };
		for (const fork of forks) healthCounts[fork.health.health] = (healthCounts[fork.health.health] ?? 0) + 1;
		const baselineCounts = { passed: 0, flagged: 0, none: 0 };
		for (const fork of forks) baselineCounts[fork.baseline ? (fork.baseline.passed ? "passed" : "flagged") : "none"]++;
		return {
			stockTags: this.stockTags(),
			releases,
			counts: this.counts(),
			healthCounts,
			baselineCounts,
			forks: forks.map(({ repo, persona, pinnedTag, status, lastRun, pendingUpgrade, updatedAt, seeded, health, baseline }) => ({
				repo,
				persona,
				pinnedTag,
				status,
				lastRun,
				pendingUpgrade,
				updatedAt,
				seeded,
				health,
				baseline,
				// A pinned fork that failed a safety release shows when its stock-mode fallback starts (spec 7).
				graceUntil: status === "repair_open" || status === "failed" ? graceOf(lastRun?.tag as string | undefined) : null,
			})),
		};
	}

	/** Number of open stream subscribers. */
	subscriberCount(): number {
		return this.subscribers.size;
	}

	/**
	 * GET /stream: an SSE stream that starts with a snapshot and then carries
	 * every change. The caller passes the client key in x-fluid-client.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname !== "/stream") return new Response("not found", { status: 404 });
		const client = request.headers.get("x-fluid-client") ?? "unknown";
		if (this.subscribers.size >= FLEET_STREAM_LIMITS.total) return streamRefusal(503, "the fleet stream is at capacity; try again later");
		if ([...this.subscribers].filter((s) => s.client === client).length >= FLEET_STREAM_LIMITS.perClient) return streamRefusal(429, "too many fleet streams from this client");
		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(
			{},
			new ByteLengthQueuingStrategy({ highWaterMark: FLEET_STREAM_LIMITS.backlogBytes }),
		);
		const subscriber: Subscriber = { writer: writable.getWriter(), client };
		this.subscribers.add(subscriber);
		this.ensureHeartbeat();
		this.send(subscriber, encoder.encode(sse("snapshot", this.snapshot())));
		request.signal?.addEventListener("abort", () => this.drop(subscriber));
		return new Response(readable, {
			headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
		});
	}

	private broadcast(event: FleetEvent): void {
		if (this.subscribers.size === 0) return;
		const chunk = encoder.encode(sse(event.type, event));
		for (const subscriber of this.subscribers) this.send(subscriber, chunk);
	}

	/** Writes to one subscriber, dropping it when it stopped reading or the stream failed. */
	private send(subscriber: Subscriber, chunk: Uint8Array): void {
		const desired = subscriber.writer.desiredSize;
		if (desired === null || desired <= 0) {
			this.drop(subscriber);
			return;
		}
		void subscriber.writer.write(chunk).catch(() => this.drop(subscriber));
	}

	private drop(subscriber: Subscriber): void {
		if (!this.subscribers.delete(subscriber)) return;
		void subscriber.writer.abort().catch(() => undefined);
		if (this.subscribers.size === 0 && this.heartbeat) {
			clearInterval(this.heartbeat);
			this.heartbeat = null;
		}
	}

	private ensureHeartbeat(): void {
		if (this.heartbeat) return;
		this.heartbeat = setInterval(() => {
			const ping = encoder.encode(`: ping ${Date.now()}\n\n`);
			for (const subscriber of this.subscribers) this.send(subscriber, ping);
		}, HEARTBEAT_MS);
	}
}

function streamRefusal(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), { status, headers: { "content-type": "application/json; charset=utf-8", "retry-after": "30" } });
}

/** Semantic version order, oldest first (v1.2.0 before v1.10.0). */
export function compareTagsAsc(a: string, b: string): number {
	const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => Number(x) || 0);
	const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => Number(x) || 0);
	for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
	return 0;
}

export function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function toFork(row: Record<string, unknown>): FleetFork {
	return {
		repo: row.repo as string,
		userId: row.user_id as string,
		persona: row.persona as string,
		pinnedTag: row.pinned_tag as string,
		status: normalizeStatus(row.status as string),
		lastRun: row.last_run ? (JSON.parse(row.last_run as string) as RunSummary | null) : null,
		pendingUpgrade: row.pending_upgrade ? (JSON.parse(row.pending_upgrade as string) as PendingUpgrade | null) : null,
		seeded: row.seeded === 1,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
		health: row.health ? (JSON.parse(row.health as string) as HealthState) : initialHealth(row.created_at as string),
		baseline: row.baseline ? (JSON.parse(row.baseline as string) as BaselineRecord) : null,
	};
}

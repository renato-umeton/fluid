// Fleet registry: every fork with its persona, pinned stock tag, status, and
// last run, plus the published stock tags. One instance ("global"). Status
// changes are broadcast to Server-Sent Events subscribers (the fleet view).
import { DurableObject } from "cloudflare:workers";
import type { Json } from "../lib/json.ts";

export type ForkStatus = "provisioning" | "ready" | "upgrading" | "gating" | "pinned" | "repair" | "failed";

export interface RunSummary {
	runId: string;
	kind: string;
	status: string;
	at: string;
	[key: string]: Json;
}

export interface FleetFork {
	repo: string;
	userId: string;
	persona: string;
	pinnedTag: string;
	status: ForkStatus;
	lastRun: RunSummary | null;
	seeded: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface FleetSnapshot {
	stockTags: string[];
	forks: Omit<FleetFork, "userId" | "seeded" | "createdAt">[];
}

export type FleetEvent = { type: "fork"; fork: FleetFork } | { type: "removed"; repo: string } | { type: "stockTags"; stockTags: string[] };

const encoder = new TextEncoder();
const HEARTBEAT_MS = 25_000;

export class Fleet extends DurableObject<Env> {
	private subscribers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
	private heartbeat: ReturnType<typeof setInterval> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const sql = ctx.storage.sql;
		sql.exec(
			"CREATE TABLE IF NOT EXISTS forks (repo TEXT PRIMARY KEY, user_id TEXT NOT NULL, persona TEXT NOT NULL, pinned_tag TEXT NOT NULL, status TEXT NOT NULL, last_run TEXT, seeded INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
		);
		sql.exec("CREATE INDEX IF NOT EXISTS forks_user ON forks (user_id)");
		sql.exec("CREATE TABLE IF NOT EXISTS stock_tags (tag TEXT PRIMARY KEY, published_at TEXT NOT NULL)");
	}

	register(input: { repo: string; userId: string; persona: string; pinnedTag: string; status?: ForkStatus; seeded?: boolean }): FleetFork {
		const now = new Date().toISOString();
		this.ctx.storage.sql.exec(
			"INSERT INTO forks (repo, user_id, persona, pinned_tag, status, seeded, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repo) DO UPDATE SET persona = excluded.persona, pinned_tag = excluded.pinned_tag, status = excluded.status, updated_at = excluded.updated_at",
			input.repo,
			input.userId,
			input.persona,
			input.pinnedTag,
			input.status ?? "ready",
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

	count(): number {
		return this.ctx.storage.sql.exec("SELECT count(*) AS n FROM forks").one().n as number;
	}

	/** Updates status, pinned tag, and/or last run, then notifies subscribers. */
	update(repo: string, patch: { status?: ForkStatus; pinnedTag?: string; lastRun?: RunSummary | null }): FleetFork | null {
		const current = this.get(repo);
		if (!current) return null;
		this.ctx.storage.sql.exec(
			"UPDATE forks SET status = ?, pinned_tag = ?, last_run = ?, updated_at = ? WHERE repo = ?",
			patch.status ?? current.status,
			patch.pinnedTag ?? current.pinnedTag,
			JSON.stringify(patch.lastRun === undefined ? current.lastRun : patch.lastRun),
			new Date().toISOString(),
			repo,
		);
		const fork = this.get(repo)!;
		this.broadcast({ type: "fork", fork });
		return fork;
	}

	remove(repo: string): boolean {
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
		return this.ctx.storage.sql.exec("SELECT tag FROM stock_tags ORDER BY published_at").toArray().map((r) => r.tag as string);
	}

	snapshot(): FleetSnapshot {
		return {
			stockTags: this.stockTags(),
			forks: this.list().map(({ repo, persona, pinnedTag, status, lastRun, updatedAt }) => ({ repo, persona, pinnedTag, status, lastRun, updatedAt })),
		};
	}

	/** GET /stream: an SSE stream that starts with a snapshot and then carries every change. */
	override async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname !== "/stream") return new Response("not found", { status: 404 });
		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		const writer = writable.getWriter();
		this.subscribers.add(writer);
		this.ensureHeartbeat();
		void writer.write(encoder.encode(sse("snapshot", this.snapshot()))).catch(() => this.drop(writer));
		request.signal?.addEventListener("abort", () => this.drop(writer));
		return new Response(readable, {
			headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
		});
	}

	private broadcast(event: FleetEvent): void {
		if (this.subscribers.size === 0) return;
		const chunk = encoder.encode(sse(event.type, event));
		for (const writer of this.subscribers) void writer.write(chunk).catch(() => this.drop(writer));
	}

	private drop(writer: WritableStreamDefaultWriter<Uint8Array>): void {
		if (!this.subscribers.delete(writer)) return;
		void writer.close().catch(() => undefined);
		if (this.subscribers.size === 0 && this.heartbeat) {
			clearInterval(this.heartbeat);
			this.heartbeat = null;
		}
	}

	private ensureHeartbeat(): void {
		if (this.heartbeat) return;
		this.heartbeat = setInterval(() => {
			const ping = encoder.encode(`: ping ${Date.now()}\n\n`);
			for (const writer of this.subscribers) void writer.write(ping).catch(() => this.drop(writer));
		}, HEARTBEAT_MS);
	}
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
		status: row.status as ForkStatus,
		lastRun: row.last_run ? (JSON.parse(row.last_run as string) as RunSummary | null) : null,
		seeded: row.seeded === 1,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}

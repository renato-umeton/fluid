// Fixed-window counters for the public demo: asks per minute per user,
// sessions per hour per client, and a global ask ceiling. One instance per
// subject (user id, client address, or "global").
import { DurableObject } from "cloudflare:workers";

export interface QuotaDecision {
	allowed: boolean;
	remaining: number;
	retryAfterSeconds: number;
}

export class Quota extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS windows (bucket TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)");
	}

	/** Counts one use of `bucket`; refuses once `limit` uses happened in the current window. */
	take(bucket: string, limit: number, windowSeconds: number, now = Date.now()): QuotaDecision {
		const windowMs = windowSeconds * 1000;
		const start = Math.floor(now / windowMs) * windowMs;
		const row = this.ctx.storage.sql.exec("SELECT window_start, count FROM windows WHERE bucket = ?", bucket).toArray()[0];
		const count = row && (row.window_start as number) === start ? (row.count as number) : 0;
		const retryAfterSeconds = Math.ceil((start + windowMs - now) / 1000);
		if (count >= limit) return { allowed: false, remaining: 0, retryAfterSeconds };
		this.ctx.storage.sql.exec(
			"INSERT INTO windows (bucket, window_start, count) VALUES (?, ?, ?) ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, count = excluded.count",
			bucket,
			start,
			count + 1,
		);
		return { allowed: true, remaining: limit - count - 1, retryAfterSeconds };
	}

	/** Returns one use of `bucket` taken in the current window (a refund); never below zero, and nothing for an earlier window. */
	give(bucket: string, windowSeconds: number, now = Date.now()): void {
		const start = Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000;
		this.ctx.storage.sql.exec("UPDATE windows SET count = MAX(0, count - 1) WHERE bucket = ? AND window_start = ?", bucket, start);
	}
}

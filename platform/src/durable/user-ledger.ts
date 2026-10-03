// Per-user run-time intent ledger (spec section 8). Every answer appends a
// record; overrides update it; once a day (alarm) or on demand the records
// are committed to the user's `ledger-<id>` Artifacts repo as one JSONL file
// per day, giving a versioned audit trail.
import { DurableObject } from "cloudflare:workers";
import type { Json } from "../lib/json.ts";
import { cloneRepo, commitChanges, initRepo, pushBranch, writeFiles, type Remote } from "../git/ops.ts";
import { ledgerRepoName } from "../lib/names.ts";
import { headOf, isNotFound } from "../runtime/repo-files.ts";

export const LEDGER_COMMIT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MODES = ["clinical", "research", "administrative"] as const;

export interface RunTimeRecord {
	answer_id: string;
	intent: string;
	confidence: number;
	signals: string[];
	override: string | null;
	attestation: boolean | null;
	sources: string[];
	fork_commit: string;
	stock_tag: string;
	[key: string]: Json;
}

export interface LedgerEntry {
	record: RunTimeRecord;
	repo: string;
	at: string;
	committed: boolean;
}

export interface LedgerCommitResult {
	repo: string;
	commit: string | null;
	records: number;
	files: string[];
}

export class UserLedger extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const sql = ctx.storage.sql;
		sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
		sql.exec(
			"CREATE TABLE IF NOT EXISTS records (seq INTEGER PRIMARY KEY AUTOINCREMENT, answer_id TEXT UNIQUE NOT NULL, at TEXT NOT NULL, repo TEXT NOT NULL, record TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 1)",
		);
	}

	private setUser(userId: string): void {
		this.ctx.storage.sql.exec("INSERT INTO meta (k, v) VALUES ('userId', ?) ON CONFLICT(k) DO NOTHING", userId);
	}

	private userId(): string | null {
		return (this.ctx.storage.sql.exec("SELECT v FROM meta WHERE k = 'userId'").toArray()[0]?.v as string | undefined) ?? null;
	}

	async append(userId: string, repo: string, record: RunTimeRecord): Promise<LedgerEntry> {
		validateRecord(record);
		this.setUser(userId);
		const at = new Date().toISOString();
		this.ctx.storage.sql.exec(
			"INSERT INTO records (answer_id, at, repo, record, dirty) VALUES (?, ?, ?, ?, 1) ON CONFLICT(answer_id) DO UPDATE SET record = excluded.record, dirty = 1",
			record.answer_id,
			at,
			repo,
			JSON.stringify(record),
		);
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + LEDGER_COMMIT_INTERVAL_MS);
		return { record, repo, at, committed: false };
	}

	list(limit = 100): LedgerEntry[] {
		return this.ctx.storage.sql
			.exec("SELECT at, repo, record, dirty FROM records ORDER BY seq DESC LIMIT ?", Math.min(Math.max(limit, 1), 1000))
			.toArray()
			.map(toEntry);
	}

	get(answerId: string): LedgerEntry | null {
		const row = this.ctx.storage.sql.exec("SELECT at, repo, record, dirty FROM records WHERE answer_id = ?", answerId).toArray()[0];
		return row ? toEntry(row) : null;
	}

	/** Records the user's mode override on an earlier answer. Returns the updated record, or null if unknown. */
	override(answerId: string, mode: string): RunTimeRecord | null {
		if (!(MODES as readonly string[]).includes(mode)) throw new Error(`override mode must be one of ${MODES.join(", ")}`);
		const entry = this.get(answerId);
		if (!entry) return null;
		const record = { ...entry.record, override: mode, override_at: new Date().toISOString() };
		this.ctx.storage.sql.exec("UPDATE records SET record = ?, dirty = 1 WHERE answer_id = ?", JSON.stringify(record), answerId);
		return record;
	}

	/** Commits every day that has new or changed records to ledger-<id>. */
	async commitPending(): Promise<LedgerCommitResult> {
		const userId = this.userId();
		if (!userId) return { repo: "", commit: null, records: 0, files: [] };
		const repoName = ledgerRepoName(userId);
		const dirtyDays = this.ctx.storage.sql
			.exec("SELECT DISTINCT substr(at, 1, 10) AS day FROM records WHERE dirty = 1")
			.toArray()
			.map((r) => r.day as string);
		if (dirtyDays.length === 0) return { repo: repoName, commit: null, records: 0, files: [] };
		const files: Record<string, string> = {};
		let count = 0;
		for (const day of dirtyDays) {
			const rows = this.ctx.storage.sql.exec("SELECT record FROM records WHERE substr(at, 1, 10) = ? ORDER BY seq", day).toArray();
			count += rows.length;
			files[`records/${day}.jsonl`] = rows.map((r) => r.record as string).join("\n") + "\n";
		}
		const { remote, empty } = await openLedgerRepo(this.env, repoName, userId);
		const ws = empty ? await initRepo("main") : await cloneRepo({ ...remote, ref: "main", singleBranch: true });
		if (empty) files["README.md"] = `# Run-time intent ledger for ${userId}\n\nOne JSONL file per day under records/. Each line is a run-time record (spec section 8). Synthetic demo data.\n`;
		await writeFiles(ws, files);
		const commit = await commitChanges(ws, { message: `Ledger: ${count} run-time records for ${dirtyDays.sort().join(", ")}` });
		await pushBranch(ws, remote, "main");
		const marker = dirtyDays.map(() => "?").join(", ");
		this.ctx.storage.sql.exec(`UPDATE records SET dirty = 0 WHERE substr(at, 1, 10) IN (${marker})`, ...dirtyDays);
		return { repo: repoName, commit, records: count, files: Object.keys(files) };
	}

	override async alarm(): Promise<void> {
		try {
			await this.commitPending();
		} finally {
			await this.ctx.storage.setAlarm(Date.now() + LEDGER_COMMIT_INTERVAL_MS);
		}
	}
}

async function openLedgerRepo(env: Env, repoName: string, userId: string): Promise<{ remote: Remote; empty: boolean }> {
	try {
		using repo = await env.ARTIFACTS.get(repoName);
		const info = await repo.info();
		const token = (await repo.createToken("write", 600)).plaintext;
		return { remote: { url: info.remote, token }, empty: (await headOf(repo, "main")) === null };
	} catch (error) {
		if (!isNotFound(error)) throw error;
		const created = await env.ARTIFACTS.create(repoName, { description: `Run-time intent ledger for ${userId}`, setDefaultBranch: "main" });
		return { remote: { url: created.remote, token: created.token }, empty: true };
	}
}

function toEntry(row: Record<string, unknown>): LedgerEntry {
	return { record: JSON.parse(row.record as string) as RunTimeRecord, repo: row.repo as string, at: row.at as string, committed: row.dirty === 0 };
}

function validateRecord(record: RunTimeRecord): void {
	if (!record || typeof record.answer_id !== "string" || record.answer_id === "") throw new Error("ledger record needs an answer_id");
	if (typeof record.intent !== "string") throw new Error("ledger record needs an intent");
}

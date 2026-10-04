// Run timelines for long agent work (customize, gate, upgrade, repair,
// harvest). One instance per run id; the run record plus an ordered list of
// steps. Workflows write here so the UI can poll GET /api/runs/:runId.
import { DurableObject } from "cloudflare:workers";
import type { Json } from "../lib/json.ts";

export type RunKind = "customize" | "gate" | "upgrade" | "repair" | "harvest" | "onboarding" | "release" | "seed" | "yellow";
/** Final statuses are passed, failed, and cancelled (the UI polls until it sees one). A yellow run is cancelled when a newer change supersedes it. */
export type RunStatus = "queued" | "running" | "waiting" | "passed" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "waiting" | "done" | "failed" | "info";

export interface RunStep {
	at: string;
	name: string;
	status: StepStatus;
	detail?: string;
	finishedAt?: string;
}

export interface Run {
	id: string;
	kind: RunKind;
	repo: string | null;
	status: RunStatus;
	createdAt: string;
	updatedAt: string;
	steps: RunStep[];
	branch?: string;
	commit?: string;
	suggestions?: Json[];
	gate?: Json;
	[key: string]: Json | RunStep[] | undefined;
}

const RESERVED = new Set(["id", "kind", "createdAt", "steps"]);

export class Runs extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS run (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS steps (seq INTEGER PRIMARY KEY AUTOINCREMENT, step TEXT NOT NULL)");
	}

	create(input: { id: string; kind: RunKind; repo?: string | null; status?: RunStatus; fields?: Record<string, Json> }): Run {
		if (this.read()) throw new Error(`run ${input.id} already exists`);
		const now = new Date().toISOString();
		const run = { ...(input.fields ?? {}), id: input.id, kind: input.kind, repo: input.repo ?? null, status: input.status ?? "queued", createdAt: now, updatedAt: now };
		this.write(run);
		return { ...run, steps: [] } as Run;
	}

	get(): Run | null {
		const run = this.read();
		if (!run) return null;
		const steps = this.ctx.storage.sql.exec("SELECT step FROM steps ORDER BY seq").toArray().map((r) => JSON.parse(r.step as string) as RunStep);
		return { ...run, steps } as Run;
	}

	addStep(step: Omit<RunStep, "at"> & { at?: string }): Run {
		if (!this.read()) throw new Error("addStep: run does not exist");
		this.ctx.storage.sql.exec("INSERT INTO steps (step) VALUES (?)", JSON.stringify({ ...step, at: step.at ?? new Date().toISOString() }));
		return this.touch({});
	}

	/**
	 * Records a step by name: updates the latest unfinished step with that name
	 * (running or waiting), or appends a new one. Finished steps get finishedAt.
	 */
	step(name: string, status: StepStatus, detail?: string): Run {
		if (!this.read()) throw new Error("step: run does not exist");
		const now = new Date().toISOString();
		const open = this.ctx.storage.sql
			.exec("SELECT seq, step FROM steps ORDER BY seq DESC")
			.toArray()
			.map((r) => ({ seq: r.seq as number, step: JSON.parse(r.step as string) as RunStep }))
			.find((r) => r.step.name === name && (r.step.status === "running" || r.step.status === "waiting" || r.step.status === "pending"));
		const finished = status === "done" || status === "failed" || status === "info";
		if (open) {
			const next: RunStep = { ...open.step, status, ...(detail !== undefined ? { detail } : {}), ...(finished ? { finishedAt: now } : {}) };
			this.ctx.storage.sql.exec("UPDATE steps SET step = ? WHERE seq = ?", JSON.stringify(next), open.seq);
		} else {
			const next: RunStep = { at: now, name, status, ...(detail !== undefined ? { detail } : {}), ...(finished ? { finishedAt: now } : {}) };
			this.ctx.storage.sql.exec("INSERT INTO steps (step) VALUES (?)", JSON.stringify(next));
		}
		return this.touch({});
	}

	/** Sets the decision on one suggestion; returns the run and whether every suggestion is now decided. */
	decide(testId: string, decision: "accept" | "reject" | "edit", edited?: Json): { run: Run; allDecided: boolean } {
		const run = this.read();
		if (!run) throw new Error("decide: run does not exist");
		const suggestions = (run.suggestions ?? []) as Record<string, Json>[];
		const target = suggestions.find((s) => s.id === testId);
		if (!target) throw new Error(`decide: no suggestion ${testId}`);
		if (target.decision) throw new Error(`decide: suggestion ${testId} was already decided (${target.decision})`);
		target.decision = decision;
		if (decision === "edit" && edited !== undefined) target.edited = edited;
		const updated = this.touch({ suggestions });
		return { run: updated, allDecided: suggestions.every((s) => Boolean(s.decision)) };
	}

	/** Merges fields into the run (status, branch, commit, suggestions, gate, ...). */
	update(patch: Record<string, Json>): Run {
		if (!this.read()) throw new Error("update: run does not exist");
		for (const key of Object.keys(patch)) if (RESERVED.has(key)) throw new Error(`update: ${key} cannot be changed`);
		return this.touch(patch);
	}

	private touch(patch: Record<string, unknown>): Run {
		this.write({ ...this.read()!, ...patch, updatedAt: new Date().toISOString() });
		return this.get()!;
	}

	private read(): Record<string, unknown> | null {
		const row = this.ctx.storage.sql.exec("SELECT v FROM run WHERE k = 'run'").toArray()[0];
		return row ? (JSON.parse(row.v as string) as Record<string, unknown>) : null;
	}

	private write(run: Record<string, unknown>): void {
		this.ctx.storage.sql.exec("INSERT INTO run (k, v) VALUES ('run', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(run));
	}
}

export function newRunId(kind: RunKind): string {
	const tail = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `run_${kind}_${tail}`;
}

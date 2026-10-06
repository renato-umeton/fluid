// Contest setup rules: who competes, on which branches, who may join late,
// and what a contest costs. Pure code; workflows/contest.ts runs it.
import type { QuotaDecision } from "../durable/quota.ts";
import type { CandidateCounts } from "./behavior.ts";
import type { Entrant } from "./winner.ts";

export const CONTEST_LIMITS = {
	minSize: 2,
	maxSize: 3,
	/** How long the contest waits for the owner's own agent to push its entry. */
	joinWindowMs: 5 * 60 * 1000,
	/** How long the contest waits for the owner to ship a contestant. */
	pickTimeout: "1 hour",
	/** One contest per fork at a time; a lease that was never released expires after this. */
	lockTtlMs: 2 * 60 * 60 * 1000,
	/** Contests per hour across the platform (each one also costs N customizations of its owner). */
	globalPerHour: 30,
};

export type ContestantKind = "recipe" | "model" | "agent";

export interface Seat {
	label: string;
	kind: ContestantKind;
	title: string;
	/** Model plans only: what this plan's prompt asks for, and its sampling temperature. */
	style?: string;
	temperature?: number;
}

/** Each model plan gets a different instruction and temperature, so the plans differ. */
export const MODEL_STYLES: Record<string, { style: string; temperature: number; title: string }> = {
	"model-a": { style: "Write the smallest change that does what the user asked. Touch as few files and lines as you can.", temperature: 0.2, title: "Model plan A: smallest change" },
	"model-b": { style: "Take the most direct route a careful engineer would choose, and keep every answer the request does not mention exactly as it is today.", temperature: 0.6, title: "Model plan B: direct and careful" },
	"model-c": { style: "Prefer editing one existing file in place over adding new files, and keep the change easy to read.", temperature: 0.9, title: "Model plan C: edit in place" },
};

/**
 * Who competes. The recipe goes first when one matches the request; model
 * plans fill the other seats; the owner's own agent takes the last seat when
 * asked for. N counts every seat, own agent included.
 */
export function lineup(input: { recipe: boolean; size: number; includeAgent: boolean }): Seat[] {
	const size = Math.min(CONTEST_LIMITS.maxSize, Math.max(CONTEST_LIMITS.minSize, input.size));
	const platformSeats = Math.max(1, size - (input.includeAgent ? 1 : 0));
	const labels = input.recipe ? ["recipe", "model-a", "model-b"] : ["model-a", "model-b", "model-c"];
	const seats: Seat[] = labels.slice(0, platformSeats).map((label) => (label === "recipe" ? { label, kind: "recipe", title: "Fixed recipe" } : { label, kind: "model", ...MODEL_STYLES[label]! }));
	if (input.includeAgent) seats.push({ label: "agent", kind: "agent", title: "Your own agent" });
	return seats;
}

export function parseContestOptions(body: Record<string, unknown>): { size: number; includeAgent: boolean } {
	const size = body.size ?? CONTEST_LIMITS.maxSize;
	if (typeof size !== "number" || !Number.isInteger(size) || size < CONTEST_LIMITS.minSize || size > CONTEST_LIMITS.maxSize) throw new Error(`size must be ${CONTEST_LIMITS.minSize} or ${CONTEST_LIMITS.maxSize}`);
	const includeAgent = body.includeAgent ?? false;
	if (typeof includeAgent !== "boolean") throw new Error("includeAgent must be true or false");
	return { size, includeAgent };
}

export function newContestId(): string {
	return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function contestRunId(contestId: string): string {
	return `run_contest_${contestId}`;
}

/** A contestant's own run timeline (a child of the contest run). */
export function contestantRunId(contestId: string, label: string): string {
	return `run_contest_${contestId}_${label}`;
}

export function contestBranch(contestId: string, label: string): string {
	return `work/contest-${contestId}-${label}`;
}

/** The inbox branch the owner's agent pushes to join: work/contest-<id>/<name>. */
export function agentInboxBranch(contestId: string, name = "my-entry"): string {
	return `work/contest-${contestId}/${name}`;
}

/** The contest id of an inbox branch (work/contest-<id>/<name>) or its import (work/inbox/contest-<id>/<name>). */
export function contestIdOfBranch(branch: string): string | null {
	return /^work\/(?:inbox\/)?contest-([0-9a-f]{12})\/[^/].*$/.exec(branch)?.[1] ?? null;
}

/** Fleet value naming a fork's current contest. */
export function contestKey(repo: string): string {
	return `contest:${repo}`;
}

export function contestLockKey(repo: string): string {
	return `contest-lock:${repo}`;
}

export interface ContestState {
	contestId: string;
	runId: string;
	status: "open" | "evaluating" | "waiting" | "shipping" | "done";
	includeAgent: boolean;
	joinUntil: string | null;
	agentJoined: boolean;
}

/** Whether an import of work/inbox/contest-<id>/... may join that contest now. */
export function joinDecision(state: ContestState | null, contestId: string, now = Date.now()): { ok: true; runId: string } | { ok: false; reason: string } {
	if (!state || state.contestId !== contestId) return { ok: false, reason: `there is no open contest ${contestId} on this fork` };
	if (!state.includeAgent) return { ok: false, reason: `contest ${contestId} has no seat for your own agent; start it with "include my own agent"` };
	if (state.agentJoined) return { ok: false, reason: `your agent already joined contest ${contestId}; one entry per contest` };
	if (state.status !== "open" || !state.joinUntil || Date.parse(state.joinUntil) < now) return { ok: false, reason: `the join window closed for contest ${contestId}` };
	return { ok: true, runId: state.runId };
}

/** Files that change behavior: intent records and the fork's own tests are left out. */
export function behaviorFiles(paths: string[]): string[] {
	return paths.filter((p) => !p.startsWith(".intent/") && !p.startsWith("tests/user/"));
}

/** A contestant as the winner rule sees it. */
export function entrantOf(c: { label: string; status?: unknown; error?: unknown; files?: unknown; readyAt?: unknown; gate?: { passed?: unknown; firstFailure?: unknown } | null }, counts: CandidateCounts | undefined): Entrant {
	const ready = c.status === "evaluated";
	return {
		label: c.label,
		ready,
		problem: ready ? null : typeof c.error === "string" ? c.error : "it did not finish",
		gatePassed: c.gate?.passed === true,
		firstFailure: typeof c.gate?.firstFailure === "string" ? c.gate.firstFailure : null,
		wishPassed: counts?.wishPassed ?? 0,
		wishTotal: counts?.wishTotal ?? 0,
		failingWish: counts?.failingWish ?? [],
		outsideChanges: counts?.outside ?? 0,
		filesChanged: Array.isArray(c.files) ? c.files.length : 0,
		finishedAt: typeof c.readyAt === "string" ? c.readyAt : null,
	};
}

/**
 * A contest costs N customizations of its owner's hourly quota (taken one by
 * one) and one of the platform's contests per hour. Returns why it is
 * refused, or null.
 */
export async function takeContestQuota(take: (subject: string, bucket: string, limit: number, windowSeconds: number) => Promise<QuotaDecision>, subject: string, size: number, customizationsPerHour: number): Promise<string | null> {
	for (let i = 0; i < size; i++) {
		const own = await take(subject, "customize", customizationsPerHour, 3600);
		if (!own.allowed) return `a contest of ${size} counts as ${size} customizations, and you have used your ${customizationsPerHour} customizations for this hour; retry in ${own.retryAfterSeconds}s`;
	}
	const all = await take("global", "contest", CONTEST_LIMITS.globalPerHour, 3600);
	if (!all.allowed) return `the platform is running ${CONTEST_LIMITS.globalPerHour} contests an hour already; retry in ${all.retryAfterSeconds}s`;
	return null;
}

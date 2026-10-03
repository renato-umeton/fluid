// Shared plumbing for the agent workflows: typed access to the workflow
// exports, run logging into the Runs Durable Object, and repo-scoped remotes.
// Tokens are minted inside step callbacks and never returned from a step, so
// they never land in workflow state.
import type { Remote } from "../git/ops.ts";
import type { Json } from "../lib/json.ts";
import type { PlatformExports } from "../runtime/loader.ts";
import { openRepo } from "../runtime/repo-files.ts";
import type { RunKind, RunStatus, StepStatus } from "../durable/runs.ts";
import { fleetStub, runsStub } from "../stubs.ts";
import type { PendingUpgrade, RunSummary, ForkStatusInput } from "../durable/fleet.ts";
import { fnv1a } from "../events/filter.ts";

export interface InstanceHandle {
	id: string;
	status(): Promise<{ status: string; output?: unknown; error?: { name: string; message: string } }>;
	sendEvent(event: { type: string; payload: unknown }): Promise<void>;
}

export interface WorkflowBinding<P> {
	create(options: { id?: string; params: P }): Promise<InstanceHandle>;
	createBatch(batch: { id?: string; params: P }[]): Promise<InstanceHandle[]>;
	get(id: string): Promise<InstanceHandle>;
}

export interface GateParams {
	repo: string;
	branch: string;
	commit: string;
	mode: "merge" | "check";
	source: "event" | "customize" | "direct" | "repair" | "repair-apply" | "seed";
	runId?: string;
	parentRunId?: string;
	/** Set when this gate checks the merge of main into the branch after main moved (fast-forward-only main). */
	regateOf?: string;
}

export interface CustomizeParams {
	runId: string;
	repo: string;
	request: string;
	userId: string;
	persona: string | null;
}

export interface RepairParams {
	runId: string;
	repo: string;
	branch: string;
	commit: string;
	reason: "customize" | "upgrade" | "gate";
	gateRunId: string;
	tag?: string;
	safety?: boolean;
	graceUntil?: string | null;
	customizeRunId?: string;
	upgradeRunId?: string;
}

export interface UpgradeParams {
	runId: string;
	repo: string;
	tag: string;
	safety: boolean;
	graceUntil: string | null;
	releaseRunId?: string;
}

export interface ReleaseParams {
	runId: string;
	tag: string;
	safety: boolean;
	graceUntil: string | null;
	repos: string[];
}

export interface SeedFleetParams {
	runId: string;
	batch: string;
	count: number;
}

export interface SeedForkParams {
	batch: string;
	index: number;
	count: number;
}

export interface HarvestParams {
	runId: string;
}

export interface AppExports extends PlatformExports {
	GateWorkflow: WorkflowBinding<GateParams>;
	CustomizeWorkflow: WorkflowBinding<CustomizeParams>;
	RepairWorkflow: WorkflowBinding<RepairParams>;
	UpgradeWorkflow: WorkflowBinding<UpgradeParams>;
	ReleaseWorkflow: WorkflowBinding<ReleaseParams>;
	SeedFleetWorkflow: WorkflowBinding<SeedFleetParams>;
	SeedForkWorkflow: WorkflowBinding<SeedForkParams>;
	HarvestWorkflow: WorkflowBinding<HarvestParams>;
}

export function appExports(ctx: unknown): AppExports {
	return (ctx as { exports: AppExports }).exports;
}

/** Creates a workflow instance; an instance that already exists with this id counts as started. */
export async function startInstance<P>(binding: WorkflowBinding<P>, id: string, params: P): Promise<{ id: string; created: boolean }> {
	try {
		const instance = await binding.create({ id, params });
		return { id: instance.id, created: true };
	} catch (error) {
		if (/already exists|duplicate|instance.*exists/i.test(String((error as Error)?.message ?? error))) return { id, created: false };
		throw error;
	}
}

/**
 * Starts an instance under a deterministic id. An instance with that id that
 * is running or finished counts as started; one that errored (for example,
 * Artifacts was unreachable) is started again under a new id.
 */
export async function startOrRetryInstance<P>(binding: WorkflowBinding<P>, id: string, paramsFor: (instanceId: string) => P): Promise<{ id: string; created: boolean }> {
	const first = await startInstance(binding, id, paramsFor(id));
	if (first.created) return { id, created: true };
	const status = await (await binding.get(id)).status().catch(() => ({ status: "unknown" }));
	if (status.status !== "errored" && status.status !== "terminated") return { id, created: false };
	const retryId = `${id.slice(0, 54)}-r${Date.now().toString(36).slice(-6)}`;
	await binding.create({ id: retryId, params: paramsFor(retryId) });
	return { id: retryId, created: true };
}

/** Starts the gate for one push: one gate per (repo, branch, commit); an errored one is started again. */
export async function startGateInstance(binding: WorkflowBinding<GateParams>, id: string, params: Omit<GateParams, "runId">): Promise<{ id: string; runId: string; created: boolean }> {
	const started = await startOrRetryInstance(binding, id, (instanceId) => ({ ...params, runId: `run_${instanceId}` }));
	return { id: started.id, runId: `run_${started.id}`, created: started.created };
}

/** Name of the record that links a push to the run that made it (see linkGateParent). */
export function gateLinkName(repo: string, branch: string, commit: string): string {
	return `gatelink_${repo}_${commit}_${fnv1a(branch)}`;
}

export interface GateLink {
	parentRunId: string;
	source: GateParams["source"];
}

/**
 * Records, before a push, which run made it. The push event can start the
 * gate before the pushing workflow does (queue delivery is not ordered with
 * the workflow), so the gate reads this record at start and still reports
 * to its parent and links the repair to it.
 */
export async function linkGateParent(env: Env, repo: string, branch: string, commit: string, link: GateLink): Promise<void> {
	const id = gateLinkName(repo, branch, commit);
	const stub = runsStub(env, id);
	if (await stub.get()) return;
	try {
		await stub.create({ id, kind: "gate", repo, status: "passed", fields: { parentRunId: link.parentRunId, source: link.source, branch, commit } });
	} catch (error) {
		if (!/already exists/.test(String((error as Error).message))) throw error;
	}
}

export async function gateLinkOf(env: Env, repo: string, branch: string, commit: string): Promise<GateLink | null> {
	const run = await runsStub(env, gateLinkName(repo, branch, commit)).get();
	if (!run || typeof run.parentRunId !== "string") return null;
	return { parentRunId: run.parentRunId, source: (run.source as GateParams["source"]) ?? "customize" };
}

/**
 * Tells a waiting customization run that its gate (or repair) finished. Only
 * customize runs wait for events; other parents are skipped. A failure to
 * deliver is logged, never thrown: the parent also checks the run record.
 */
export async function notifyParent(env: Env, exports: AppExports, parentRunId: string, type: "gate-finished" | "repair-finished", payload: Record<string, unknown>): Promise<void> {
	try {
		const parent = await runsStub(env, parentRunId).get();
		if (parent?.kind !== "customize") return;
		await (await exports.CustomizeWorkflow.get(parentRunId)).sendEvent({ type, payload });
	} catch (error) {
		console.warn(`notify ${parentRunId} (${type}) failed: ${errorText(error)}`);
	}
}

export function asJson<T>(value: T): Json {
	return value as unknown as Json;
}

export interface RunLog {
	step(name: string, status: StepStatus, detail?: string): Promise<void>;
	update(patch: Record<string, unknown>): Promise<void>;
	status(status: RunStatus, patch?: Record<string, unknown>): Promise<void>;
}

/** Creates the run if it does not exist yet (workflow retries and replays call this again). */
export async function ensureRun(env: Env, input: { id: string; kind: RunKind; repo?: string | null; fields?: Record<string, unknown> }): Promise<void> {
	const stub = runsStub(env, input.id);
	if (await stub.get()) return;
	try {
		await stub.create({ id: input.id, kind: input.kind, repo: input.repo ?? null, status: "running", fields: (input.fields ?? {}) as Record<string, Json> });
	} catch (error) {
		if (!/already exists/.test(String((error as Error).message))) throw error;
	}
}

export function runLog(env: Env, runId: string): RunLog {
	const stub = runsStub(env, runId);
	return {
		step: async (name, status, detail) => {
			await stub.step(name, status, detail);
		},
		update: async (patch) => {
			await stub.update(patch as Record<string, Json>);
		},
		status: async (status, patch = {}) => {
			await stub.update({ ...(patch as Record<string, Json>), status });
		},
	};
}

export async function setFleet(env: Env, repo: string, patch: { status?: ForkStatusInput; pinnedTag?: string; lastRun?: Record<string, unknown> | null; pendingUpgrade?: PendingUpgrade | null }): Promise<void> {
	const lastRun = patch.lastRun ? ({ at: new Date().toISOString(), ...patch.lastRun } as RunSummary) : patch.lastRun;
	await fleetStub(env).update(repo, { ...patch, lastRun: lastRun as RunSummary | null | undefined });
}

/** A short-lived repo-scoped token for git over HTTP. Call inside a step; never return it. */
export async function repoRemote(env: Env, repo: string, scope: "read" | "write" = "write"): Promise<Remote> {
	using handle = await openRepo(env.ARTIFACTS, repo);
	const info = await handle.info();
	const token = await handle.createToken(scope, 900);
	return { url: info.remote, token: token.plaintext };
}

export function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/art_v\d+_[A-Za-z0-9_-]+(\?expires=\d+)?/g, "<redacted-token>").slice(0, 500);
}

/** Retry policy for steps that talk to Artifacts over git. */
export const GIT_STEP = { retries: { limit: 4, delay: "3 seconds" as const, backoff: "exponential" as const }, timeout: "5 minutes" as const };
export const GATE_STEP = { retries: { limit: 2, delay: "5 seconds" as const, backoff: "exponential" as const }, timeout: "5 minutes" as const };

/**
 * The workflow step API with plain generics. The runtime types constrain
 * step results to a deep serializable type that our JSON-shaped records
 * overwhelm; every step result here is plain JSON data.
 */
export interface Steps {
	do<T>(name: string, fn: () => Promise<T>): Promise<T>;
	do<T>(name: string, config: Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
	sleep(name: string, duration: string | number): Promise<void>;
	waitForEvent<T>(name: string, options: { type: string; timeout?: string | number }): Promise<{ payload: T; type: string }>;
}

export function steps(step: unknown): Steps {
	return step as Steps;
}

/**
 * Runs a workflow body; when a step gives up after its retries, records the
 * error on the run (and the fork's fleet entry) so the UI never shows a run
 * stuck in "running", then rethrows so the instance ends as errored.
 */
export async function guarded<T>(step: Steps, env: Env, info: { runId: string; kind: RunKind; repo?: string | null; fleetStatus?: ForkStatusInput; lastRun?: Record<string, unknown> }, body: () => Promise<T>): Promise<T> {
	try {
		return await body();
	} catch (error) {
		const message = errorText(error);
		await step.do("record failure", async () => {
			await ensureRun(env, { id: info.runId, kind: info.kind, repo: info.repo ?? null });
			const log = runLog(env, info.runId);
			await log.step("Error", "failed", message);
			await log.status("failed", { error: message });
			if (info.repo && info.fleetStatus) await setFleet(env, info.repo, { status: info.fleetStatus, lastRun: { runId: info.runId, kind: info.kind, status: "error", error: message, ...(info.lastRun ?? {}) } });
			return true;
		});
		throw error;
	}
}

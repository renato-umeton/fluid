// Rotate Workflow (fluid-rotate): moves forks to their next renamed copy
// (polymorph/rotate.ts). With a repo it rotates that fork in one step that
// retries like a gate, and logs the outcome as a run. Without one (the
// schedule starts such an instance every six hours, and an admin may ask for
// the whole fleet) it starts one instance per fork in paced batches. Security
// events are rotateFork's to record. Each instance id names what asked for
// the rotation (a stored copy, a landed commit, a new fork, a fleet-wide run),
// so asking again, however often, starts nothing new.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { RunStatus, StepStatus } from "../durable/runs.ts";
import { fnv1a } from "../events/filter.ts";
import { polymorphSecret } from "../polymorph/install.ts";
import { rotateFork, type RotationReason, type RotationResult } from "../polymorph/rotate.ts";
import { fleetStub } from "../stubs.ts";
import { appExports, ensureRun, errorText, GATE_STEP, GIT_STEP, guarded, runLog, startInstance, steps, type RotateParams, type Steps, type WorkflowBinding } from "./common.ts";
import { FAN_OUT } from "./upgrade.ts";

const ROTATE_STEP = "Rotate to the next renamed copy";
const FLEET_STEP = "Rotate every fork";
const NO_SECRET = "POLYMORPH_SECRET is not set or is shorter than 16 characters";

/** The instance id of the rotation of `repo` that `key` names: rot-<fork hash>-<key>. */
export function rotationId(repo: string, key: string): string {
	return `rot-${fnv1a(repo)}-${key}`;
}

/** The key of a stored copy: the live path starts at most one rotation per copy, however many requests trip it. */
export function copyKey(copy: { epoch: number; fingerprint: string }): string {
	return `c${copy.epoch}-${copy.fingerprint}`;
}

/**
 * Starts the rotation of one fork that `key` names (see rotationId), with the
 * run that logs it; an instance that already exists counts as started.
 * Returns its id, or null when nothing started: a platform without a secret
 * starts none (it would only skip), and a failure to start is logged, never
 * thrown, since whatever asked for the rotation (a refused request, a landed
 * change, a new fork) finishes either way and the schedule rotates every fork
 * within six hours.
 */
export async function startRotation(env: Env, binding: WorkflowBinding<RotateParams> | undefined, input: { repo: string; reason: RotationReason; key: string }): Promise<{ id: string; created: boolean } | null> {
	if (polymorphSecret(env) === null) return null;
	const id = rotationId(input.repo, input.key);
	try {
		if (!binding) throw new Error("ctx.exports has no RotateWorkflow binding");
		return await startInstance(binding, id, { repo: input.repo, reason: input.reason, runId: `run_${id}` });
	} catch (error) {
		console.error(`polymorph: rotation ${id} of ${input.repo} (${input.reason}) did not start: ${errorText(error)}`);
		return null;
	}
}

export class RotateWorkflow extends WorkflowEntrypoint<Env, RotateParams> {
	async run(event: Readonly<WorkflowEvent<RotateParams>>, workflowStep: WorkflowStep) {
		// An instance the schedule starts has no params.
		const p: RotateParams = event.payload ?? {};
		const runId = p.runId ?? `run_${event.instanceId}`;
		const reason = p.reason ?? "schedule";
		const step = steps(workflowStep);
		const repo = p.repo;
		return guarded<RotationResult | { started: number }>(step, this.env, { runId, kind: "rotate", repo: repo ?? null }, () => (repo ? this.rotateOne(step, runId, repo, reason) : this.rotateFleet(step, runId, reason)));
	}

	private async rotateOne(step: Steps, runId: string, repo: string, reason: RotationReason): Promise<RotationResult> {
		const log = runLog(this.env, runId);
		await step.do("start", async () => {
			await ensureRun(this.env, { id: runId, kind: "rotate", repo, fields: { reason } });
			await log.step(ROTATE_STEP, "running", `Gating main with the renamed copy for the next epoch (${reason})`);
			return true;
		});
		// rotateFork throws, like runGate, when Artifacts fails, so this step retries rather than skip.
		const result = await step.do("rotate", GATE_STEP, () => rotateFork({ env: this.env, exports: appExports(this.ctx) }, repo, reason));
		await step.do("finish", async () => {
			const shown = runOutcome(result);
			await log.step(ROTATE_STEP, shown.step, shown.detail);
			await log.status(shown.status, shown.fields);
			return true;
		});
		return result;
	}

	private async rotateFleet(step: Steps, runId: string, reason: RotationReason): Promise<{ started: number }> {
		const log = runLog(this.env, runId);
		const plan = await step.do("list forks", async () => {
			await ensureRun(this.env, { id: runId, kind: "rotate", fields: { reason } });
			// Every child would only skip.
			if (polymorphSecret(this.env) === null) return { repos: [] as string[], skip: NO_SECRET as string | null };
			const repos = (await fleetStub(this.env).list()).filter((fork) => fork.status !== "provisioning").map((fork) => fork.repo);
			await log.step(FLEET_STEP, "running", `Starting one rotation for each of ${repos.length} forks (${reason}); forks still being provisioned are left out`);
			return { repos, skip: null as string | null };
		});
		if (plan.skip !== null) {
			const why = plan.skip;
			await step.do("finish skipped", async () => {
				await log.step(FLEET_STEP, "info", `Skipped: ${why}`);
				await log.status("cancelled", { cancelReason: why });
				return true;
			});
			return { started: 0 };
		}
		const exports = appExports(this.ctx);
		const key = `f${fnv1a(runId)}`;
		for (let i = 0; i < plan.repos.length; i += FAN_OUT.batchSize) {
			await step.do(`fan out ${i}`, GIT_STEP, async () => {
				const items = plan.repos.slice(i, i + FAN_OUT.batchSize).map((repo) => {
					const id = rotationId(repo, key);
					return { id, params: { repo, reason, runId: `run_${id}` } };
				});
				try {
					await exports.RotateWorkflow.createBatch(items);
				} catch {
					// Some exist already (a retried step): each of those counts as started.
					for (const item of items) await startInstance(exports.RotateWorkflow, item.id, item.params);
				}
				return items.length;
			});
			if (i + FAN_OUT.batchSize < plan.repos.length) await step.sleep(`pace ${i}`, FAN_OUT.pause);
		}
		await step.do("finish", async () => {
			await log.step(FLEET_STEP, "done", `Started ${plan.repos.length} rotations, one per fork; each logs its own run`);
			await log.status("passed", { forks: plan.repos.length });
			return true;
		});
		return { started: plan.repos.length };
	}
}

/**
 * How a rotation shows on its run. The run keeps the epoch and commit, never
 * the copy's fingerprint: a run can be read by anyone who knows its id, and
 * which copy a fork serves stays with the platform.
 */
function runOutcome(result: RotationResult): { step: StepStatus; status: RunStatus; detail: string; fields: Record<string, unknown> } {
	if (result.outcome === "rotated") {
		return { step: "done", status: "passed", detail: `The renamed copy for epoch ${result.epoch} of ${result.sha.slice(0, 7)} answered every probe like the plain fork, and the fork serves it now`, fields: { outcome: result.outcome, epoch: result.epoch, commit: result.sha } };
	}
	if (result.outcome === "refused") {
		const count = result.failures.length + result.more;
		const first = result.failures[0]?.probe;
		return {
			step: "failed",
			status: "failed",
			detail: `The gate failed the renamed copy for epoch ${result.epoch} of ${result.sha.slice(0, 7)} (${count} failure${count === 1 ? "" : "s"}${first ? `, first ${first}` : ""}); the fork keeps the copy it has`,
			fields: { outcome: result.outcome, epoch: result.epoch, commit: result.sha, failures: result.failures, more: result.more },
		};
	}
	return { step: "info", status: "cancelled", detail: `Skipped: ${result.why}`, fields: { outcome: result.outcome, cancelReason: result.why } };
}

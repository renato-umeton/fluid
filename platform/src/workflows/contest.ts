// Contest Workflow: best-of-N agents compete to grant one wish. The recipe
// (when one matches), one or two model plans with different prompts and
// temperatures, and optionally the owner's own agent (an inbox push to
// work/contest-<id>/<name>) each work on their own branch,
// work/contest-<id>-<label>. Each change is checked like a customization,
// committed with its intent record and its suggested tests, and gated in
// check mode while the platform keeps the card the fork answered for every
// probe. A behavior diff against main and a fixed rule (contest/winner.ts)
// pick the winner; the owner ships it or another passing contestant, and only
// that one is gated in merge mode and lands through the normal path
// (fast-forward, yellow soak, rollback). The others stay as branches.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { CandidateError, failureExplanation, MAX_REPAIRS, planWithRepairs, userFacingError } from "../agents/attempts.ts";
import { buildIntent, cleanText, intentJson, intentPath } from "../agents/intent.ts";
import { decideChange, inspectChange } from "../agents/outside-intent.ts";
import { matchRecipe, protocolsFor, redcapChange, replanOnMovedMain, tauChange, type PlannedChange } from "../agents/recipes.ts";
import { replayExtra, replayRecordFor } from "../agents/replay.ts";
import { fallbackSuggestion, mergeUserManifest, suggestTests, USER_MANIFEST, type Probe } from "../agents/suggester.ts";
import { uiChange } from "../agents/ui-recipe.ts";
import { behaviorTable, probeContentKey, type BehaviorTable, type Observation } from "../contest/behavior.ts";
import { capObservations, wishTestSet, type ManifestProbeLike } from "../contest/observe.ts";
import { behaviorFiles, CONTEST_LIMITS, contestantRunId, contestBranch, contestLockKey, entrantOf, lineup, type Seat } from "../contest/plan.ts";
import { decideWinner, pickNotes, type Entrant } from "../contest/winner.ts";
import { gateInstanceId } from "../events/filter.ts";
import synthetic from "../generated/synthetic.json";
import { checkoutBranch, cloneRepo, commitChanges, fetchBranch, headCommit, listRemoteRefs, parseTrailers, pushBranch, readCommitMessage, readWorkspaceFile, writeFiles } from "../git/ops.ts";
import { newIntentId } from "../lib/names.ts";
import type { Json } from "../lib/json.ts";
import { runGateObserved } from "../gate/run.ts";
import { gateBrief, type GateResult } from "../gate/tiers.ts";
import { isRuntimePath } from "../runtime/modules.ts";
import { headOf, openRepo, readCommitFiles } from "../runtime/repo-files.ts";
import { pinnedTagOf } from "../stock/releases.ts";
import { loadStockSuite } from "../stock/suite.ts";
import { fleetStub, runsStub } from "../stubs.ts";
import { UI_PREFERENCES_PATH } from "../ui/preferences.ts";
import { modelPlan, validateCandidate } from "./customize.ts";
import { appExports, ensureRun, errorText, GATE_STEP, GIT_STEP, guarded, repoRemote, runLog, startGateInstance, steps, waitForRun, type ContestParams, type Steps } from "./common.ts";
import { logTiers, persistGate } from "./gate.ts";

const PLAN_STEP = { retries: { limit: 1, delay: "2 seconds" as const }, timeout: "15 minutes" as const };
/** Size cap for the behavior diff stored on the run record. */
const MAX_BEHAVIOR_CHARS = 400_000;

interface ForkRead {
	sha: string;
	files: Record<string, string>;
	stockTag: string;
}

interface Prepared {
	label: string;
	ok: boolean;
	branch: string | null;
	commit: string | null;
	probes: ManifestProbeLike[];
	error?: string;
}

interface Evaluated {
	label: string;
	gate: GateResult;
	observations: Observation[];
}

export class ContestWorkflow extends WorkflowEntrypoint<Env, ContestParams> {
	async run(event: Readonly<WorkflowEvent<ContestParams>>, workflowStep: WorkflowStep) {
		const p = event.payload;
		const step = steps(workflowStep);
		try {
			return await guarded(step, this.env, { runId: p.runId, kind: "contest", repo: p.repo }, () => this.execute(p, step));
		} catch (error) {
			await step.do("release the fork after an error", async () => {
				await releaseContest(this.env, p);
				return true;
			});
			throw error;
		}
	}

	private async execute(p: ContestParams, step: Steps) {
		const log = runLog(this.env, p.runId);
		const request = cleanText(p.request, 1000);
		const seats = lineup({ recipe: matchRecipe(request) !== null, size: p.size, includeAgent: p.includeAgent });

		// The start route abandons a contest whose create call threw and whose instance it could not find
		// (closed, unlocked, refunded). If this instance was made anyway, it stops here and touches nothing:
		// no run record, no contest state, no lease, since a newer contest may own them by now.
		const abandoned = await step.do("check the contest is still open", async () => {
			const run = await runsStub(this.env, p.runId).get();
			const state = await fleetStub(this.env).contestState(p.repo);
			if (run?.status === "failed") return "the start route already failed this contest";
			if (state?.contestId !== p.contestId) return "the fork has no open contest with this id";
			if (state.status === "done") return "this contest was already closed";
			return null;
		});
		if (abandoned) {
			console.warn(`contest ${p.runId} stopped before it began: ${abandoned}`);
			return { winner: null, shipped: null, abandoned: true };
		}

		const fork = await step.do("read the fork", GIT_STEP, async (): Promise<ForkRead> => {
			await ensureRun(this.env, { id: p.runId, kind: "contest", repo: p.repo, fields: { request } });
			await log.step("Read the fork", "running");
			for (const seat of seats) await ensureRun(this.env, { id: contestantRunId(p.contestId, seat.label), kind: "contest", repo: p.repo, fields: { parentRunId: p.runId, label: seat.label, title: seat.title, request } });
			using repo = await openRepo(this.env.ARTIFACTS, p.repo);
			const sha = await headOf(repo, "main");
			if (!sha) throw new Error(`${p.repo} has no main branch`);
			const files = await readCommitFiles(repo, sha, { file: (path) => isRuntimePath(path) || path === "fluid.toml" || path === USER_MANIFEST || path === UI_PREFERENCES_PATH, dir: (d) => ["app", "intent", "policies", "connectors", "tests", "tests/user", "ui"].some((x) => d === x || d.startsWith(`${x}/`)) });
			const stockTag = pinnedTagOf(files["fluid.toml"]) ?? "unknown";
			await log.update({ baseCommit: sha, stockTag });
			await log.step("Read the fork", "done", `main at ${sha.slice(0, 7)} on stock ${stockTag}; ${seats.length} contestants: ${seats.map((s) => s.label).join(", ")}`);
			await log.step("Contestants work at the same time", "running", seats.filter((s) => s.kind !== "agent").map((s) => `${s.label} on ${contestBranch(p.contestId, s.label)}`).join("; "));
			return { sha, files, stockTag };
		});

		// Every platform contestant plans, checks, and commits at the same time, each on its own branch.
		const prepared = await Promise.all(seats.filter((s) => s.kind !== "agent").map((seat) => this.prepare(step, p, request, fork, seat)));
		const agent = p.includeAgent ? await this.awaitAgent(step, p) : null;
		await step.do("contestants ready", async () => {
			const ready = [...prepared, ...(agent ? [agent] : [])].filter((c) => c.ok).length;
			await log.step("Contestants work at the same time", ready > 0 ? "done" : "failed", `${ready} of ${seats.length} produced a change`);
			await fleetStub(this.env).setContestStatus(p.repo, p.contestId, "evaluating");
			await renewContest(this.env, p);
			return true;
		});

		// The wish tests: every platform contestant's suggested tests, copies merged, run against main and every candidate.
		const wish = wishTestSet(prepared.filter((c) => c.ok).map((c) => c.probes));
		const candidates = [...prepared, ...(agent ? [agent] : [])].filter((c): c is Prepared & { branch: string; commit: string } => c.ok && Boolean(c.branch && c.commit));
		await step.do("start the checks", async () => {
			await log.update({ wishTests: wish.probes.map((pr) => ({ id: pr.id, question: (pr.request as { question?: string } | undefined)?.question ?? null })) as unknown as Json });
			await log.step("Check every contestant", "running", `Tiers 1 to 3 in check mode for ${candidates.map((c) => c.label).join(", ") || "nobody"}, plus ${wish.probes.length} wish test${wish.probes.length === 1 ? "" : "s"}; the fork's answer to every probe is kept for the behavior diff`);
			return true;
		});

		const evaluations = await Promise.all([
			this.evaluate(step, p, { label: "main", branch: "main", commit: fork.sha, own: [] }, wish),
			...candidates.map((c) => this.evaluate(step, p, { label: c.label, branch: c.branch, commit: c.commit, own: c.probes }, wish)),
		]);

		const verdict = await step.do("decide", async () => {
			const main = evaluations[0]!;
			const table = behaviorTable(main.observations, evaluations.slice(1).map((e) => ({ label: e.label, observations: e.observations })));
			const run = await runsStub(this.env, p.runId).get();
			const records = ((run?.contestants ?? []) as unknown as Record<string, unknown>[]);
			const entrants = seats.map((seat) => entrantOf({ ...(records.find((r) => r.label === seat.label) ?? {}), label: seat.label } as never, table.counts[seat.label]));
			const decided = decideWinner(entrants);
			for (const e of entrants) await runsStub(this.env, p.runId).updateEntry("contestants", "label", e.label, { outside: e.outsideChanges, wish: { passed: e.wishPassed, total: e.wishTotal, failing: e.failingWish } as unknown as Json });
			await log.update({ behavior: capBehavior(table) as unknown as Json, mainGate: brief(main.gate) as unknown as Json, verdict: decided as unknown as Json, entrants: entrants as unknown as Json, winner: decided.winner });
			await log.step("Check every contestant", "done", `${table.rows.length} probes compared with main${table.omitted ? ` (${table.omitted} unchanged ones left out)` : ""}`);
			await log.step("Winner", decided.winner ? "done" : "failed", decided.reason);
			for (const e of entrants) await this.noteContestant(p, e.label, decided.winner === e.label ? "winner; waiting for your pick" : decided.notes[e.label] ?? "did not win", false);
			if (decided.winner) {
				await fleetStub(this.env).setContestStatus(p.repo, p.contestId, "waiting");
				await renewContest(this.env, p);
				await log.status("waiting");
				await log.step("Ship a contestant", "waiting", `Ship ${decided.winner} (the rule's choice) or another contestant that passed. Only the one you ship is gated in merge mode; the others stay as branches.`);
			}
			return { winner: decided.winner, entrants };
		});

		if (!verdict.winner) {
			await step.do("finish without a winner", async () => {
				await log.status("failed", { error: "No contestant passed every tier and every wish test. Nothing shipped; every branch stays." });
				for (const e of verdict.entrants) await this.noteContestant(p, e.label, "no winner; nothing shipped", true);
				await releaseContest(this.env, p);
				return true;
			});
			return { winner: null, shipped: null };
		}

		let pickedLabel: string | null = null;
		try {
			const event = await step.waitForEvent<{ label?: unknown }>("contest pick", { type: "contest-pick", timeout: CONTEST_LIMITS.pickTimeout });
			pickedLabel = typeof event.payload?.label === "string" ? event.payload.label : null;
		} catch {
			pickedLabel = null;
		}
		if (!pickedLabel) {
			await step.do("finish without a pick", async () => {
				await log.step("Ship a contestant", "info", "No pick within an hour; nothing shipped. Every branch stays; run the contest again to ship one.");
				await log.status("cancelled", { cancelReason: "no pick within an hour" });
				for (const e of verdict.entrants) await this.noteContestant(p, e.label, "contest ended without a pick", true);
				await releaseContest(this.env, p);
				return true;
			});
			return { winner: verdict.winner, shipped: null };
		}

		const ship = await step.do("ship the pick", async () => {
			const picked = pickNotes(verdict.entrants as Entrant[], pickedLabel!);
			if (!picked.ok) {
				await log.step("Ship a contestant", "failed", picked.error);
				return { ok: false as const, error: picked.error };
			}
			const run = await runsStub(this.env, p.runId).get();
			const record = shipTarget((run?.contestants ?? []) as unknown as ContestantRecord[], pickedLabel!);
			if (!record.ok) return { ok: false as const, error: record.error };
			await log.update({ picked: { label: pickedLabel, by: pickedLabel === verdict.winner ? "rule" : "you", reason: picked.reason, at: new Date().toISOString() }, notes: picked.notes });
			for (const [label, note] of Object.entries(picked.notes)) {
				await runsStub(this.env, p.runId).updateEntry("contestants", "label", label, { note });
				await this.noteContestant(p, label, note, true);
			}
			await fleetStub(this.env).setContestStatus(p.repo, p.contestId, "shipping");
			await renewContest(this.env, p);
			// The pick goes through the normal merge gate: tiers again in merge mode, fast-forward, yellow soak, rollback.
			const started = await startGateInstance(appExports(this.ctx).GateWorkflow, gateInstanceId(p.repo, record.branch, record.commit), { repo: p.repo, branch: record.branch, commit: record.commit, mode: "merge", source: record.source, parentRunId: p.runId });
			await log.update({ shipGateRunId: started.runId });
			await log.status("running");
			await log.step("Ship a contestant", "done", `${picked.reason} Gating ${record.branch} at ${record.commit.slice(0, 7)} in merge mode (${started.runId}).`);
			await this.noteContestant(p, pickedLabel!, "shipping: gating in merge mode", false);
			return { ok: true as const, gateRunId: started.runId, branch: record.branch };
		});
		if (!ship.ok) {
			await step.do("finish refused pick", async () => {
				await log.status("failed", { error: ship.error });
				await releaseContest(this.env, p);
				return true;
			});
			return { winner: verdict.winner, shipped: null };
		}

		const final = await waitForRun(this.env, step, "ship gate", "gate-finished", ship.gateRunId, (run) => (typeof run.regateRunId === "string" ? run.regateRunId : null));
		await step.do("finish", async () => {
			const gateRun = await runsStub(this.env, final.runId).get();
			const merged = final.passed === true && Boolean(gateRun?.mergedCommit);
			await log.step("Merge to main", merged ? "done" : "failed", merged ? `main is now ${String(gateRun!.mergedCommit).slice(0, 7)}; live in yellow until the soak passes` : `${ship.branch} did not reach main: the merge gate ${final.status === "running" ? "did not finish in time" : "failed"}. The other contestants stay on their branches.`);
			await log.status(merged ? "passed" : "failed", { shipGateRunId: final.runId, gate: (gateRun?.gate ?? null) as never, ...(merged ? {} : { error: `${pickedLabel} did not reach main` }) });
			await this.noteContestant(p, pickedLabel!, merged ? "won; merged to main" : "picked, but the merge gate did not pass", true);
			await releaseContest(this.env, p);
			return true;
		});
		return { winner: verdict.winner, shipped: pickedLabel };
	}

	/** Plans, checks, and commits one platform contestant on its own branch. Never throws for a bad plan: that contestant just has no change. */
	private async prepare(step: Steps, p: ContestParams, request: string, fork: ForkRead, seat: Seat): Promise<Prepared> {
		const childId = contestantRunId(p.contestId, seat.label);
		const child = runLog(this.env, childId);
		const branch = contestBranch(p.contestId, seat.label);
		const started = Date.now();

		const planned = await step.do(`plan ${seat.label}`, PLAN_STEP, async () => {
			await this.entry(p, seat.label, { status: "planning", title: seat.title, kind: seat.kind, runId: childId, branch });
			await child.step("Plan the change", "running", seat.kind === "recipe" ? "Fixed recipe" : `${seat.title} (temperature ${seat.temperature})`);
			const recipe = matchRecipe(request);
			const usesModel = seat.kind === "model";
			const result = await planWithRepairs(
				{
					plan: async (feedback) => {
						try {
							if (!usesModel && recipe?.kind === "redcap") return redcapChange({ indexSource: fork.files["app/index.ts"] ?? "", protocols: protocolsFor((synthetic as { personas: unknown }).personas, p.persona) });
							if (!usesModel && recipe?.kind === "tau") return tauChange(fork.files["fluid.toml"] ?? "", recipe);
							if (!usesModel && recipe?.kind === "ui") return uiChange(fork.files[UI_PREFERENCES_PATH] ?? null, request);
							return await modelPlan(this.env, request, fork.files, feedback, { style: seat.style, temperature: seat.temperature });
						} catch (error) {
							if (!usesModel && !(error instanceof CandidateError)) throw new CandidateError(errorText(error));
							throw error;
						}
					},
					validate: (change) => validateCandidate(this.env, appExports(this.ctx), p.repo, fork.sha, change.files, fork.files),
					onFailure: async (attempt, error, willRetry) => child.step("Plan the change", "running", `Attempt ${attempt} failed: ${userFacingError(error)}${willRetry ? ". Sending the exact error back to the agent." : ""}`),
				},
				usesModel ? MAX_REPAIRS : 0,
			);
			if (!result.ok) {
				const why = userFacingError(result.error);
				await child.step("Plan the change", "failed", failureExplanation({ attempts: result.attempts, error: result.error, lastSummary: result.lastSummary, model: usesModel }));
				await child.status("failed", { error: why });
				await this.entry(p, seat.label, { status: "no change", error: why, latencyMs: Date.now() - started });
				return { ok: false as const, error: why };
			}
			await child.step("Plan the change", "done", `${result.change.summary}; loaded in an isolate and answered a smoke question${result.attempts > 1 ? ` (after ${result.attempts - 1} repair${result.attempts > 2 ? "s" : ""})` : ""}`);
			return { ok: true as const, change: result.change, intentId: newIntentId() };
		});
		if (!planned.ok) return { label: seat.label, ok: false, branch: null, commit: null, probes: [], error: planned.error };

		return step.do(`commit ${seat.label}`, GIT_STEP, async (): Promise<Prepared> => {
			const change = planned.change as PlannedChange;
			const intentId = planned.intentId;
			await child.step("Commit the change and its tests", "running", branch);
			const invariants = await loadStockSuite(this.env, fork.stockTag).then((s) => s.manifests.invariant as { probes?: Probe[] }).catch(() => null);
			let suggestions = suggestTests({ change, intentId, invariants, protocols: protocolsFor((synthetic as { personas: unknown }).personas, p.persona), previousToml: fork.files["fluid.toml"] ?? null });
			if (change.recipe === "model" && !suggestions.some((s) => s.kind === "behavior")) suggestions = [fallbackSuggestion(intentId, change.modes_affected), ...suggestions];
			// In a contest every suggested test is accepted: they are the wish tests every contestant faces.
			const probes = suggestions.filter((s) => s.probe && s.kind === "behavior").map((s) => ({ ...s.probe!, intentId }));
			const intent = buildIntent({ id: intentId, userId: p.userId, agent: "customization-agent", request, purpose: change.purpose, modes: change.modes_affected, files: [...Object.keys(change.files), intentPath(intentId)], testsAdded: probes.map((pr) => `${USER_MANIFEST}#${pr.id}`), stockTag: fork.stockTag, extra: { recipe: change.recipe, contest: { id: p.contestId, label: seat.label, runId: p.runId }, ...(change.mapped?.length ? { mapped: change.mapped } : {}), ...replayExtra(replayRecordFor(change, request)) } });
			// The wish is in flight from the moment its branch exists: the intent record is in the branch's first commit.
			const remote = await repoRemote(this.env, p.repo, "write");
			const ws = await cloneRepo({ ...remote, ref: "main", singleBranch: true });
			const existing = (await listRemoteRefs(remote, undefined, { prefix: `refs/heads/${branch}` })).find((r) => r.ref === `refs/heads/${branch}`);
			let commit: string;
			if (existing) {
				await fetchBranch(ws, remote, branch);
				if (parseTrailers(await readCommitMessage(ws, existing.oid))["Intent-Id"] !== intentId) throw new Error(`${branch} exists and was not made by this contest`);
				commit = existing.oid;
			} else {
				const current: Record<string, string | null> = {};
				for (const path of Object.keys(change.files)) current[path] = await readWorkspaceFile(ws, path);
				const rebased = replanOnMovedMain({ change, request, before: fork.files, current, protocols: protocolsFor((synthetic as { personas: unknown }).personas, p.persona) });
				if ("error" in rebased) {
					await child.step("Commit the change and its tests", "failed", rebased.error);
					await child.status("failed", { error: rebased.error });
					await this.entry(p, seat.label, { status: "no change", error: rebased.error });
					return { label: seat.label, ok: false, branch: null, commit: null, probes: [], error: rebased.error };
				}
				await checkoutBranch(ws, branch, { create: true, from: "main" });
				const author = { name: `user:${p.userId}`, email: `${p.userId}@users.fluid.invalid` };
				await writeFiles(ws, { ...rebased.files, [intentPath(intentId)]: intentJson({ ...intent, ...replayExtra(rebased.replay ?? null) }) });
				await commitChanges(ws, { message: `${change.summary}\n\nContest ${p.contestId}, contestant ${seat.label}. Requested: ${cleanText(request, 200)}`, intentId, author });
				if (probes.length) {
					await writeFiles(ws, { [USER_MANIFEST]: mergeUserManifest(await readWorkspaceFile(ws, USER_MANIFEST), probes) });
					await commitChanges(ws, { message: `Add wish tests for ${intentId}\n\nSuggested by the test suggester; every contestant in contest ${p.contestId} faces them: ${probes.map((pr) => pr.id).join(", ")}.`, intentId, author });
				}
				commit = await headCommit(ws);
				await pushBranch(ws, remote, branch, { force: true });
			}
			const readyAt = new Date().toISOString();
			const files = behaviorFiles(Object.keys(change.files));
			await child.update({ branch, commit, intent: intent as unknown as Json });
			await child.step("Commit the change and its tests", "done", `${branch} at ${commit.slice(0, 7)}: ${files.join(", ")}; ${probes.length} wish test${probes.length === 1 ? "" : "s"}`);
			await this.entry(p, seat.label, { status: "ready", branch, commit, intentId, summary: change.summary, files, wishTests: probes.length, readyAt, latencyMs: Date.now() - started });
			await this.noteWish(p, seat.label, { branch, intentId, status: "checking" });
			return { label: seat.label, ok: true, branch, commit, probes: probes as unknown as ManifestProbeLike[] };
		});
	}

	/** Waits for the owner's own agent to join through the inbox, until the join window closes. */
	private async awaitAgent(step: Steps, p: ContestParams): Promise<Prepared> {
		const childId = contestantRunId(p.contestId, "agent");
		const child = runLog(this.env, childId);
		const wait = await step.do("open the join window", async () => {
			const state = await fleetStub(this.env).contestState(p.repo);
			const left = Math.max(0, Date.parse(state?.joinUntil ?? "") - Date.now()) || 0;
			const joined = await this.agentEntry(p);
			if (!joined) await child.step("Wait for your agent", "waiting", `Push your entry to work/contest-${p.contestId}/<name> in your inbox before ${state?.joinUntil ?? "the window closes"}`);
			return { left, joined: Boolean(joined) };
		});
		if (!wait.joined && wait.left > 0) {
			try {
				await step.waitForEvent("agent joined", { type: "contest-joined", timeout: wait.left });
			} catch {
				// The window closed with no entry.
			}
		}
		return step.do("close the join window", GIT_STEP, async (): Promise<Prepared> => {
			const fleet = fleetStub(this.env);
			await fleet.setContestStatus(p.repo, p.contestId, "evaluating");
			let entry = await this.agentEntry(p);
			// The import claims the seat before it writes the entry: give a claimed seat a moment to show up.
			for (let i = 0; !entry && (await fleet.contestState(p.repo))?.agentJoined && i < 10; i++) {
				await new Promise((r) => setTimeout(r, 1000));
				entry = await this.agentEntry(p);
			}
			if (!entry) {
				const why = "no push arrived in the join window";
				await child.step("Wait for your agent", "failed", `${why}; your agent does not compete this time`);
				await child.status("failed", { error: why });
				await this.entry(p, "agent", { status: "no change", error: why, title: "Your own agent", kind: "agent" });
				return { label: "agent", ok: false, branch: null, commit: null, probes: [], error: why };
			}
			// Records are append-only and may not claim a platform agent's name, as in any gate.
			const remote = await repoRemote(this.env, p.repo, "read");
			const ws = await cloneRepo({ ...remote, ref: "main", singleBranch: true });
			await fetchBranch(ws, remote, entry.branch);
			const seen = await inspectChange(ws, { branch: entry.branch, commit: entry.commit });
			if (seen.status !== "ok") {
				const why = "your branch moved on after it joined";
				await this.entry(p, "agent", { status: "no change", error: why });
				return { label: "agent", ok: false, branch: null, commit: null, probes: [], error: why };
			}
			const decision = decideChange(seen, false);
			const violations = decision.action === "fail" ? { appendOnly: decision.appendOnly, platformClaims: decision.platformClaims } : { appendOnly: [], platformClaims: [] };
			const files = behaviorFiles(seen.changes.map((c) => c.path));
			await child.step("Wait for your agent", "done", `${entry.branch} at ${entry.commit.slice(0, 7)}: ${files.join(", ") || "no behavior files"}`);
			await this.entry(p, "agent", { status: "ready", files, violations: violations as unknown as Json, intentId: seen.addedIds[0] ?? null });
			await this.noteWish(p, "agent", { branch: entry.branch, intentId: seen.addedIds[0] ?? null, status: "checking" });
			return { label: "agent", ok: true, branch: entry.branch, commit: entry.commit, probes: [] };
		});
	}

	/** Gates one commit in check mode and keeps the card for every probe. "main" is the baseline. */
	private async evaluate(step: Steps, p: ContestParams, target: { label: string; branch: string; commit: string; own: ManifestProbeLike[] }, wish: { probes: ManifestProbeLike[]; keys: Map<string, string> }): Promise<Evaluated> {
		return step.do(`evaluate ${target.label}`, GATE_STEP, async () => {
			const isMain = target.label === "main";
			const childId = isMain ? null : contestantRunId(p.contestId, target.label);
			if (!isMain) await this.entry(p, target.label, { status: "checking" });
			const own = new Set(target.own.map(probeContentKey));
			const run = isMain ? null : await runsStub(this.env, p.runId).get();
			const violations = ((run?.contestants ?? []) as unknown as { label: string; violations?: { appendOnly?: string[]; platformClaims?: string[] } }[]).find((c) => c.label === target.label)?.violations;
			const started = Date.now();
			const { gate, observations } = await runGateObserved(
				{ env: this.env, exports: appExports(this.ctx) },
				{ repo: p.repo, ref: target.branch, commit: target.commit, mode: "check", intentViolations: violations?.appendOnly, platformClaims: violations?.platformClaims },
				{ extraProbes: wish.probes.filter((pr) => !own.has(probeContentKey(pr))), wishKeys: wish.keys },
			);
			if (childId) {
				await logTiers(this.env, childId, gate);
				await persistGate(this.env, gate, childId);
				await this.entry(p, target.label, { status: "evaluated", gate: brief(gate) as unknown as Json, checkMs: Date.now() - started });
				await runLog(this.env, childId).status(gate.passed ? "passed" : "failed");
			} else {
				await runLog(this.env, p.runId).step("Check main as the baseline", "done", `main at ${target.commit.slice(0, 7)}: ${gate.passed ? "every tier passed" : `${gate.failures.length} failure(s)`}; ${observations.length} probes recorded`);
			}
			return { label: target.label, gate, observations: capObservations(observations) };
		});
	}

	private async entry(p: ContestParams, label: string, patch: Record<string, Json>): Promise<void> {
		await runsStub(this.env, p.runId).updateEntry("contestants", "label", label, patch);
	}

	private async agentEntry(p: ContestParams): Promise<{ branch: string; commit: string } | null> {
		const run = await runsStub(this.env, p.runId).get();
		const entry = ((run?.contestants ?? []) as unknown as { label: string; status?: string; branch?: string; commit?: string }[]).find((c) => c.label === "agent");
		return entry?.status === "joined" && entry.branch && entry.commit ? { branch: entry.branch, commit: entry.commit } : null;
	}

	private async noteWish(p: ContestParams, label: string, patch: { branch: string | null; intentId: string | null; status: string; final?: boolean }): Promise<void> {
		try {
			await fleetStub(this.env).noteWish(p.repo, { id: `${p.runId}:${label}`, runId: p.runId, kind: "contest", request: p.request, at: new Date().toISOString(), contest: { id: p.contestId, label }, ...patch });
		} catch (error) {
			console.warn(`wish note for ${p.runId}:${label} failed: ${errorText(error)}`);
		}
	}

	/** Updates a contestant's wish note with its status; keeps the branch and intent id it already has. */
	private async noteContestant(p: ContestParams, label: string, status: string, final: boolean): Promise<void> {
		const run = await runsStub(this.env, p.runId).get();
		const c = ((run?.contestants ?? []) as unknown as { label: string; branch?: string; intentId?: string | null; status?: string }[]).find((x) => x.label === label);
		await this.noteWish(p, label, { branch: c?.status === "no change" ? null : c?.branch ?? null, intentId: c?.intentId ?? null, status, final });
	}
}

interface ContestantRecord {
	label: string;
	status?: string;
	branch?: string;
	commit?: string;
}

/**
 * What the merge gate gets for the pick: the exact commit the contest checked
 * (not whatever the branch points at now), and the gate source: "import" for
 * the owner's agent (so a missing intent record is drafted and no repair
 * agent starts), "contest" for a platform contestant.
 */
export function shipTarget(contestants: ContestantRecord[], label: string): { ok: true; branch: string; commit: string; source: "import" | "contest" } | { ok: false; error: string } {
	const c = contestants.find((x) => x.label === label);
	if (!c || c.status !== "evaluated" || !c.branch || !c.commit) return { ok: false, error: `${label} has no checked commit to ship` };
	return { ok: true, branch: c.branch, commit: c.commit, source: label === "agent" ? "import" : "contest" };
}

/** Compact gate summary for a contestant column. */
function brief(gate: GateResult): Record<string, unknown> {
	const tier = (t: GateResult["tiers"][keyof GateResult["tiers"]]) => (t ? { passed: t.passed, total: t.total, failed: t.failed } : null);
	return { passed: gate.passed, firstFailure: gateBrief(gate).firstFailure, tiers: { invariant: tier(gate.tiers.invariant), functional: tier(gate.tiers.functional), user: tier(gate.tiers.user) }, durationMs: gate.durationMs, stockTag: gate.stockTag };
}

/** Keeps the stored diff under MAX_BEHAVIOR_CHARS by dropping field lists from unchanged rows, then trimming them everywhere. */
export function capBehavior(table: BehaviorTable, max = MAX_BEHAVIOR_CHARS): BehaviorTable {
	if (JSON.stringify(table).length <= max) return table;
	let perCell = 6;
	let out = table;
	while (perCell >= 0) {
		out = { ...table, rows: table.rows.map((r) => ({ ...r, cells: Object.fromEntries(Object.entries(r.cells).map(([k, c]) => [k, { ...c, changes: c.changes.slice(0, perCell) }])) })) };
		if (JSON.stringify(out).length <= max) return out;
		perCell = perCell === 0 ? -1 : Math.floor(perCell / 2);
	}
	return { ...out, rows: out.rows.slice(0, 20), omitted: out.omitted + Math.max(0, out.rows.length - 20) };
}

/**
 * Each phase (contestants ready, waiting for the pick, shipping) is shorter
 * than the lease, so renewing it at each one keeps the fork's contest held
 * until the contest ends, never past it.
 */
export async function renewContest(env: Env, p: ContestParams): Promise<void> {
	await fleetStub(env).renewLock(contestLockKey(p.repo), CONTEST_LIMITS.lockTtlMs, p.runId);
}

/** The contest is over: the fork may start another one. */
export async function releaseContest(env: Env, p: ContestParams): Promise<void> {
	const fleet = fleetStub(env);
	await fleet.setContestStatus(p.repo, p.contestId, "done");
	await fleet.unlock(contestLockKey(p.repo), p.runId);
}

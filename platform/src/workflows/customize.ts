// Customization agent (spec 3, 6.3, 8): turns a plain-language request into
// a change on work/<slug> with a build-time intent record, has the test
// suggester propose tier 3 probes, waits for the user's decisions, commits
// the accepted tests, pushes, and starts the gate for that push.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { diffEntries } from "../agents/diff.ts";
import { buildIntent, cleanText, intentJson, intentPath, slugify } from "../agents/intent.ts";
import { matchRecipe, protocolsFor, redcapChange, tauChange, type PlannedChange } from "../agents/recipes.ts";
import { fallbackSuggestion, mergeUserManifest, suggestionsFromModel, suggestTests, SUGGESTION_SCHEMA, USER_MANIFEST, type Probe, type Suggestion } from "../agents/suggester.ts";
import { fnv1a, gateInstanceId } from "../events/filter.ts";
import synthetic from "../generated/synthetic.json";
import { checkoutBranch, cloneRepo, commitChanges, headCommit, pushBranch, readWorkspaceFile, writeFiles } from "../git/ops.ts";
import { readIntents } from "../forks/provision.ts";
import { newIntentId } from "../lib/names.ts";
import { pinnedTagOf } from "../stock/releases.ts";
import { loadStockSuite } from "../stock/suite.ts";
import { AGENT_MODEL, callModel } from "../runtime/llm.ts";
import { FORK_CALL_TIMEOUT_MS, loadForkRuntime, withTimeout } from "../runtime/loader.ts";
import { isRuntimePath, transformTs } from "../runtime/modules.ts";
import { headOf, openRepo, readCommitFiles } from "../runtime/repo-files.ts";
import { runsStub } from "../stubs.ts";
import { repairRunId } from "./gate.ts";
import { appExports, ensureRun, errorText, GIT_STEP, repoRemote, runLog, startGateInstance, guarded, steps, type CustomizeParams } from "./common.ts";

export const MODEL_LIMITS = { maxFiles: 3, maxFileChars: 16_000 };
const MODEL_PATH = /^(app|intent|policies|connectors)\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.(ts|json)$/;
const DECISION_TIMEOUT = "1 hour";
const GATE_POLLS = 150;

const PLAN_SCHEMA = {
	type: "object",
	properties: {
		summary: { type: "string" },
		purpose: { type: "string" },
		modes_affected: { type: "array", items: { type: "string" } },
		files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
	},
	required: ["summary", "purpose", "modes_affected", "files"],
} as const;

/** Checks model-written files against the limits before anything runs them. Returns an error or null. */
export function checkModelFiles(files: { path: string; content: string }[]): string | null {
	if (files.length === 0) return "the plan changes no files";
	if (files.length > MODEL_LIMITS.maxFiles) return `the plan changes ${files.length} files; at most ${MODEL_LIMITS.maxFiles} are allowed`;
	for (const f of files) {
		if (typeof f.path !== "string" || !MODEL_PATH.test(f.path) || f.path.includes("..")) return `path ${JSON.stringify(f.path)} is outside app/, intent/, policies/, connectors/`;
		if (typeof f.content !== "string" || f.content.length === 0) return `${f.path} is empty`;
		if (f.content.length > MODEL_LIMITS.maxFileChars) return `${f.path} is larger than ${MODEL_LIMITS.maxFileChars} characters`;
		try {
			if (f.path.endsWith(".json")) JSON.parse(f.content);
			else transformTs(f.content, f.path);
		} catch (error) {
			return `${f.path} does not parse: ${errorText(error)}`;
		}
	}
	return null;
}

export class CustomizeWorkflow extends WorkflowEntrypoint<Env, CustomizeParams> {
	async run(event: Readonly<WorkflowEvent<CustomizeParams>>, workflowStep: WorkflowStep) {
		const p = event.payload;
		return guarded(steps(workflowStep), this.env, { runId: p.runId, kind: "customize", repo: p.repo }, () => this.execute(event, workflowStep));
	}

	private async execute(event: Readonly<WorkflowEvent<CustomizeParams>>, workflowStep: WorkflowStep) {
		const step = steps(workflowStep);
		const p = event.payload;
		const log = runLog(this.env, p.runId);
		const exports = appExports(this.ctx);
		const request = cleanText(p.request, 1000);

		const fork = await step.do("read the fork", GIT_STEP, async () => {
			await ensureRun(this.env, { id: p.runId, kind: "customize", repo: p.repo, fields: { request } });
			await log.step("Read the fork's intent ledger", "running");
			using repo = await openRepo(this.env.ARTIFACTS, p.repo);
			const sha = await headOf(repo, "main");
			if (!sha) throw new Error(`${p.repo} has no main branch`);
			const files = await readCommitFiles(repo, sha, { file: (path) => isRuntimePath(path) || path === "fluid.toml" || path === USER_MANIFEST, dir: (d) => ["app", "intent", "policies", "connectors", "tests", "tests/user"].some((x) => d === x || d.startsWith(`${x}/`)) });
			const intents = await readIntents(this.env, p.repo, sha);
			const stockTag = pinnedTagOf(files["fluid.toml"]) ?? "unknown";
			const custom = intents.filter((i) => i.agent && i.agent !== "onboarding");
			await log.step("Read the fork's intent ledger", "done", `main at ${sha.slice(0, 7)} on stock ${stockTag}; ${intents.length} intent records (${custom.length} customizations)`);
			return { sha, files, stockTag, intentCount: intents.length };
		});

		const change = await step.do("plan the change", { retries: { limit: 1, delay: "2 seconds" }, timeout: "10 minutes" }, async () => {
			const recipe = matchRecipe(request);
			await log.step("Plan the change", "running", recipe ? `Matched the ${recipe.kind} recipe` : `Planning with ${AGENT_MODEL}`);
			let planned: PlannedChange;
			if (recipe?.kind === "redcap") {
				planned = redcapChange({ indexSource: fork.files["app/index.ts"] ?? "", protocols: protocolsFor((synthetic as { personas: unknown }).personas, p.persona) });
			} else if (recipe?.kind === "tau") {
				planned = tauChange(fork.files["fluid.toml"] ?? "", recipe);
			} else {
				planned = await this.modelPlan(request, fork.files, fork.sha, p.runId);
			}
			await log.step("Plan the change", "done", planned.summary);
			return planned;
		});

		await step.do("validate the change", { retries: { limit: 1, delay: "2 seconds" }, timeout: "5 minutes" }, async () => {
			await log.step("Write code and load it in an isolate", "running");
			await validateInIsolate(this.env, exports, p.repo, fork.sha, change.files);
			await log.step("Write code and load it in an isolate", "done", `${Object.keys(change.files).length} file(s) changed; type-stripped and answered a smoke question in a Worker Loader isolate`);
			return true;
		});

		const recorded = await step.do("record intent", async () => {
			await log.step("Record build-time intent", "running");
			const intentId = newIntentId();
			const intent = buildIntent({ id: intentId, userId: p.userId, agent: "customization-agent", request, purpose: change.purpose, modes: change.modes_affected, files: [...Object.keys(change.files), intentPath(intentId)], stockTag: fork.stockTag, extra: { recipe: change.recipe } });
			const before = Object.fromEntries(Object.keys(change.files).map((path) => [path, fork.files[path] ?? null]));
			const diff = diffEntries({ ...before, [intentPath(intentId)]: null }, { ...change.files, [intentPath(intentId)]: intentJson(intent) }, { ...change.notes, [intentPath(intentId)]: "Why this change exists; the commit carries Intent-Id" });
			const branch = `work/${slugify(request)}-${fnv1a(p.runId).slice(0, 4)}`;
			await log.update({ intent, diff, branch });
			await log.step("Record build-time intent", "done", intentPath(intentId));
			return { intentId, intent, branch };
		});

		const suggestions = await step.do("suggest tests", { retries: { limit: 1, delay: "2 seconds" }, timeout: "5 minutes" }, async () => {
			await log.step("Suggest tier 3 tests", "running");
			let invariants: { probes?: Probe[] } | null = null;
			try {
				invariants = (await loadStockSuite(this.env, fork.stockTag)).manifests.invariant as { probes?: Probe[] };
			} catch {
				invariants = null;
			}
			let list: Suggestion[] = suggestTests({ change, intentId: recorded.intentId, invariants, protocols: protocolsFor((synthetic as { personas: unknown }).personas, p.persona), previousToml: fork.files["fluid.toml"] ?? null });
			if (change.recipe === "model") {
				try {
					const out = await callModel(this.env.AI, suggesterPrompt(request, change, recorded.intentId), SUGGESTION_SCHEMA, { model: AGENT_MODEL, maxTokens: 3000 });
					list = [...suggestionsFromModel(out, recorded.intentId), ...list];
				} catch (error) {
					await log.step("Suggest tier 3 tests", "running", `Model suggestions unavailable (${errorText(error)}); using deterministic probes`);
				}
				if (!list.some((s) => s.kind === "behavior")) list.unshift(fallbackSuggestion(recorded.intentId, change.modes_affected));
			}
			await log.status("waiting", { suggestions: list });
			await log.step("Suggest tier 3 tests", "waiting", `${list.length} proposed from the diff and intent ${recorded.intentId}. Accept, edit, or reject each one to start the gate.`);
			return list;
		});

		if (suggestions.length > 0) {
			try {
				await step.waitForEvent("suggestion decisions", { type: "suggestions-decided", timeout: DECISION_TIMEOUT });
			} catch {
				await step.do("decisions timed out", async () => {
					await log.step("Suggest tier 3 tests", "info", "No decision within an hour; undecided suggestions are treated as rejected");
					return true;
				});
			}
		}

		const pushed = await step.do("commit and push", GIT_STEP, async () => {
			const run = await runsStub(this.env, p.runId).get();
			const decided = ((run?.suggestions ?? []) as unknown as (Suggestion & { edited?: { assert?: unknown[] } })[]).filter((s) => s.decision === "accept" || s.decision === "edit");
			const probes = decided.map((s) => ({ ...s.probe, ...(s.decision === "edit" && Array.isArray(s.edited?.assert) ? { assert: s.edited!.assert as Record<string, unknown>[] } : {}), intentId: recorded.intentId }));
			const rejected = (run?.suggestions?.length ?? 0) - decided.length;
			await log.status("running");
			await log.step("Suggest tier 3 tests", "done", `${decided.length} accepted, ${rejected} rejected`);
			await log.step("Commit and push to a work branch", "running");
			const remote = await repoRemote(this.env, p.repo, "write");
			const ws = await cloneRepo({ ...remote, ref: "main", singleBranch: true });
			await checkoutBranch(ws, recorded.branch, { create: true });
			const testsAdded = probes.map((pr) => `${USER_MANIFEST}#${pr.id}`);
			const intent = { ...recorded.intent, tests_added: testsAdded };
			await writeFiles(ws, { ...change.files, [intentPath(recorded.intentId)]: intentJson(intent) });
			await commitChanges(ws, { message: `${change.summary}\n\nRequested: ${cleanText(request, 200)}`, intentId: recorded.intentId, author: { name: `user:${p.userId}`, email: `${p.userId}@users.fluid.invalid` } });
			let diffAdd: { path: string; status: string; additions: number; deletions: number; summary: string }[] = [];
			if (probes.length > 0) {
				const before = await readWorkspaceFile(ws, USER_MANIFEST);
				const manifest = mergeUserManifest(before, probes);
				await writeFiles(ws, { [USER_MANIFEST]: manifest });
				await commitChanges(ws, { message: `Add tier 3 tests for ${recorded.intentId}\n\nAccepted from the test suggester: ${probes.map((pr) => pr.id).join(", ")}.`, intentId: recorded.intentId, author: { name: `user:${p.userId}`, email: `${p.userId}@users.fluid.invalid` } });
				diffAdd = [{ path: USER_MANIFEST, status: before === null ? "added" : "modified", additions: probes.length, deletions: 0, summary: `Tier 3 tests: ${probes.map((pr) => pr.id).join(", ")}` }];
			}
			const commit = await headCommit(ws);
			await pushBranch(ws, remote, recorded.branch, { force: true });
			const diff = [...((run?.diff ?? []) as unknown as unknown[]), ...diffAdd];
			await log.update({ commit, intent, diff });
			await log.step("Commit and push to a work branch", "done", `${recorded.branch} at ${commit.slice(0, 7)}; the push event (or this direct trigger) starts the gate`);
			return { commit };
		});

		const gate = await step.do("start the gate", async () => {
			const started = await startGateInstance(exports.GateWorkflow, gateInstanceId(p.repo, recorded.branch, pushed.commit), { repo: p.repo, branch: recorded.branch, commit: pushed.commit, mode: "merge", source: "customize", parentRunId: p.runId });
			await log.step("Gate", "running", `${started.runId}${started.created ? "" : " (already started by the push event)"}`);
			return { runId: started.runId };
		});

		let final: { status: string; passed: boolean | null } = { status: "running", passed: null };
		for (let i = 0; i < GATE_POLLS && final.status === "running"; i++) {
			await step.sleep(`wait for gate ${i}`, "2 seconds");
			final = await step.do(`check gate ${i}`, async () => {
				const run = await runsStub(this.env, gate.runId).get();
				if (!run || run.status === "running" || run.status === "queued") return { status: "running", passed: null };
				return { status: run.status, passed: run.status === "passed" };
			});
		}

		if (final.passed === false) {
			const repairId = repairRunId(p.repo, pushed.commit);
			for (let i = 0; i < GATE_POLLS; i++) {
				await step.sleep(`wait for repair ${i}`, "2 seconds");
				const done = await step.do(`check repair ${i}`, async () => {
					const run = await runsStub(this.env, repairId).get();
					return Boolean(run && run.status !== "running" && run.status !== "queued");
				});
				if (done) break;
			}
		}

		await step.do("finish", async () => {
			const gateRun = await runsStub(this.env, gate.runId).get();
			const passed = final.passed === true;
			await log.step("Gate", passed ? "done" : "failed", passed ? "All three tiers passed" : `Gate ${final.status === "running" ? "did not finish in time" : "failed"}`);
			if (passed) await log.step("Merge to main", gateRun?.mergedCommit ? "done" : "failed", gateRun?.mergedCommit ? `main is now ${String(gateRun.mergedCommit).slice(0, 7)}` : "The gate passed but main could not be updated");
			else await log.step("Merge blocked", "failed", `${recorded.branch} stays unmerged; main is untouched`);
			await log.status(passed && gateRun?.mergedCommit ? "passed" : "failed", { gate: (gateRun?.gate ?? null) as never, gateRunId: gate.runId });
			return true;
		});
		return { passed: final.passed, branch: recorded.branch, commit: pushed.commit };
	}

	private async modelPlan(request: string, files: Record<string, string>, sha: string, runId: string): Promise<PlannedChange> {
		const log = runLog(this.env, runId);
		let feedback = "";
		for (let attempt = 1; attempt <= 2; attempt++) {
			const out = await callModel(this.env.AI, planPrompt(request, files, feedback), PLAN_SCHEMA, { model: AGENT_MODEL, maxTokens: 6000 });
			const list = (Array.isArray(out.files) ? out.files : []) as { path: string; content: string }[];
			const problem = checkModelFiles(list);
			if (!problem) {
				return {
					summary: cleanText(String(out.summary), 200),
					purpose: cleanText(String(out.purpose), 400),
					modes_affected: (Array.isArray(out.modes_affected) ? out.modes_affected : []).map(String),
					files: Object.fromEntries(list.map((f) => [f.path, f.content])),
					notes: Object.fromEntries(list.map((f) => [f.path, files[f.path] === undefined ? "New file written by the customization agent" : "Edited by the customization agent"])),
					recipe: "model",
				};
			}
			feedback = `Your previous plan was rejected: ${problem}. Fix it.`;
			await log.step("Plan the change", "running", `Attempt ${attempt} rejected: ${problem}`);
		}
		throw new Error(`the model did not produce a valid change: ${feedback}`);
	}
}

/** Loads the fork with the candidate files overlaid in a throwaway isolate variant and asks one question. */
export async function validateInIsolate(env: Env, exports: Parameters<typeof loadForkRuntime>[0]["exports"], repo: string, sha: string, files: Record<string, string>): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		if (path.endsWith(".ts")) transformTs(content, path);
		else if (path.endsWith(".json")) JSON.parse(content);
	}
	const variant = `candidate-${fnv1a(JSON.stringify(files))}`;
	const loaded = await loadForkRuntime({ env, exports }, repo, sha, { extraFiles: files, variant });
	const card = (await withTimeout(loaded.fork.ask({ question: "What is the formulary status of Morphinex?", context: {} }, { useModel: false }), FORK_CALL_TIMEOUT_MS, "candidate fork did not answer")) as { override_available?: unknown; ledger?: unknown };
	if (card?.override_available !== true || !card.ledger) throw new Error("the changed fork answered without the card contract (override and ledger)");
}

function planPrompt(request: string, files: Record<string, string>, feedback: string): string {
	const listing = Object.keys(files).filter((p) => p !== "fluid.toml" && p !== USER_MANIFEST).sort().join("\n");
	const show = ["app/index.ts", "app/types.ts", "connectors/types.ts"].map((p) => `### ${p}\n${files[p] ?? "(missing)"}`).join("\n\n");
	return `You customize one user's fork of Fluid, a clinical assistant runtime written in TypeScript (ES modules, relative imports end in ".js", no Node APIs, no network, no dependencies). Write the smallest change that does what the user asked.

Rules: change at most ${MODEL_LIMITS.maxFiles} files, only under app/, intent/, policies/, or connectors/; give the complete new content of each file; keep app/index.ts default-exporting { ask }; every answer card keeps override_available, ledger, sources, and framing; clinical mode never computes a patient-specific dose; never lower tau or edit fluid.toml.

User request: ${request}
${feedback ? `\n${feedback}\n` : ""}
Files in the fork:
${listing}

${show}`;
}

function suggesterPrompt(request: string, change: PlannedChange, intentId: string): string {
	const diff = Object.entries(change.files).map(([p, c]) => `### ${p}\n${c.slice(0, 4000)}`).join("\n\n");
	return `Propose up to three tests for this customization of a clinical assistant fork. Each test asks the assistant one question (with a context object such as {"documentType":"manuscript"} or {}) and asserts on the JSON answer card: paths like "mode", "body", "sources", "computed_dose"; ops equals, notEquals, contains, notContains, exists, gte, lte, length_gte. Use focusMode ("clinical", "research", "administrative") to assert on the card in that mode. The tests verify intent ${intentId}: "${change.purpose}".\n\nUser request: ${request}\n\n${diff}`;
}

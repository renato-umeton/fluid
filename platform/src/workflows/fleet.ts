// Fleet seeding and harvesting. SeedFleet registers N synthetic forks and
// starts one SeedFork workflow per fork in paced batches; each SeedFork
// provisions its fork at the seed base tag (the newest release before the
// floor a demo release tightens), commits customizations that pass that
// floor to main, and pushes a floor-breaking change (lower tau) to a work
// branch that the gate fails and the repair agent answers. Harvest reads build-time intent records across
// opted-in forks, clusters them, labels clusters with the model, and drafts
// eligible ones as harvest/<slug> branches in stock.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { clusterRecords, deterministicLabel, draftFilesFor, harvestable, LABEL_SCHEMA, labelPrompt, proposalOf, type HarvestProposal, type HarvestRecord } from "../agents/harvest-cluster.ts";
import { buildIntent, intentJson, intentPath, cleanText } from "../agents/intent.ts";
import { cloneRepo, commitChanges, checkoutBranch, deleteRemoteBranch, headCommit, listRemoteRefs, pushBranch, readWorkspaceFile, writeFiles } from "../git/ops.ts";
import synthetic from "../generated/synthetic.json";
import { approveMainMove } from "../forks/main-guard.ts";
import { currentStockTag, findPersona, preferencesOf, provisionFork, readIntents } from "../forks/provision.ts";
import { forkRepoName, newIntentId, STOCK_REPO } from "../lib/names.ts";
import { parseToml } from "../lib/toml.ts";
import { FAST_MODEL, callModel } from "../runtime/llm.ts";
import { isRuntimePath } from "../runtime/modules.ts";
import { headOf, openRepo, readCommitFiles, readTextFile } from "../runtime/repo-files.ts";
import { gateInstanceId } from "../events/filter.ts";
import { isReleaseTag } from "../gate/pins.ts";
import { hasDemoTightening, pinnedTagOf } from "../stock/releases.ts";
import { fleetStub } from "../stubs.ts";
import { requestFor, seedChange, seedPlan, seedTarget, type SeedKind } from "../fleet/seed-catalog.ts";
import { appExports, ensureRun, errorText, GIT_STEP, repoRemote, runLog, setFleet, startGateInstance, startInstance, guarded, steps, type HarvestParams, type SeedFleetParams, type SeedForkParams } from "./common.ts";
import { FAN_OUT } from "./upgrade.ts";

export const HARVEST_KEY = "harvest";
const HARVEST_BATCH = 25;
const READ_CONCURRENCY = 8;
const MAX_DRAFTS = 3;
const MAX_LABELS = 8;

export class SeedFleetWorkflow extends WorkflowEntrypoint<Env, SeedFleetParams> {
	async run(event: Readonly<WorkflowEvent<SeedFleetParams>>, workflowStep: WorkflowStep) {
		const p = event.payload;
		return guarded(steps(workflowStep), this.env, { runId: p.runId, kind: "seed" }, () => this.execute(event, workflowStep));
	}

	private async execute(event: Readonly<WorkflowEvent<SeedFleetParams>>, workflowStep: WorkflowStep) {
		const step = steps(workflowStep);
		const p = event.payload;
		const log = runLog(this.env, p.runId);
		const exports = appExports(this.ctx);
		const plan = seedPlan(p.batch, p.count);
		const tag = await step.do("register", async () => {
			await ensureRun(this.env, { id: p.runId, kind: "seed", fields: { batch: p.batch, count: plan.length } });
			const base = await seedBaseTag(this.env);
			await log.step(`Seed ${plan.length} forks`, "running", `Batch ${p.batch}, pinned to ${base}, the newest release before the floor a demo release tightens`);
			const fleet = fleetStub(this.env);
			for (const spec of plan) await fleet.register({ repo: forkRepoName(spec.userId), userId: spec.userId, persona: spec.persona, pinnedTag: base, status: "provisioning", seeded: true });
			return base;
		});
		for (let i = 0; i < plan.length; i += FAN_OUT.batchSize) {
			await step.do(`fan out ${i}`, GIT_STEP, async () => {
				const items = plan.slice(i, i + FAN_OUT.batchSize).map((spec) => ({ id: `seed-${p.batch}-${spec.index}`, params: { batch: p.batch, index: spec.index, count: p.count, stockTag: tag } }));
				try {
					await exports.SeedForkWorkflow.createBatch(items);
				} catch {
					for (const item of items) await startInstance(exports.SeedForkWorkflow, item.id, item.params);
				}
				return items.length;
			});
			if (i + FAN_OUT.batchSize < plan.length) await step.sleep(`pace ${i}`, FAN_OUT.pause);
		}
		await step.do("finish", async () => {
			await log.step(`Seed ${plan.length} forks`, "done", `${plan.length} seed workflows started`);
			await log.status("passed");
			return true;
		});
		return { started: plan.length };
	}
}

export class SeedForkWorkflow extends WorkflowEntrypoint<Env, SeedForkParams> {
	async run(event: Readonly<WorkflowEvent<SeedForkParams>>, workflowStep: WorkflowStep) {
		const p = event.payload;
		return guarded(steps(workflowStep), this.env, { runId: `run_seed_${p.batch}_${p.index}`, kind: "seed" }, () => this.execute(event, workflowStep));
	}

	private async execute(event: Readonly<WorkflowEvent<SeedForkParams>>, workflowStep: WorkflowStep) {
		const step = steps(workflowStep);
		const p = event.payload;
		const spec = seedPlan(p.batch, p.count)[p.index];
		if (!spec) throw new Error(`seed ${p.batch}/${p.index} is not in the plan`);
		const repo = forkRepoName(spec.userId);
		await step.do("provision", GIT_STEP, async () => {
			const persona = findPersona(spec.persona);
			if (!persona) throw new Error(`unknown persona ${spec.persona}`);
			await provisionFork(this.env, { userId: spec.userId, persona, seeded: true, resume: true, ...(p.stockTag ? { stockTag: p.stockTag } : {}), preferences: { auto_upgrade: spec.autoUpgrade, harvest_opt_in: spec.harvestOptIn } });
			return true;
		});
		const kinds = spec.kinds.filter((k): k is Exclude<SeedKind, "none"> => k !== "none");
		const onMain = kinds.filter((k) => seedTarget(k) === "main");
		const onBranch = kinds.filter((k) => seedTarget(k) === "work-branch");
		const personas = (synthetic as { personas: unknown }).personas;
		if (onMain.length > 0) {
			await step.do("customize", GIT_STEP, async () => {
				const remote = await repoRemote(this.env, repo, "write");
				const ws = await cloneRepo({ ...remote, ref: "main", singleBranch: true });
				const toml = (await readWorkspaceFile(ws, "fluid.toml")) ?? "";
				// A retried step may find the customization already committed.
				const existing = await readIntents(this.env, repo, "main");
				if (existing.some((i) => i.agent === "seed-customization")) return true;
				const before = await headCommit(ws, "main");
				for (const kind of onMain) await commitSeedChange(ws, kind, spec, personas, pinnedTagOf(toml));
				await approveMainMove(this.env, repo, before, await headCommit(ws, "main"));
				await pushBranch(ws, remote, "main");
				return true;
			});
		}
		// A change that would break the floor never lands on main: it goes to a work branch and through the gate.
		const work =
			onBranch.length > 0
				? await step.do("push work branch", GIT_STEP, async () => {
						const branch = `work/seed-${onBranch.join("-")}-${spec.index}`;
						const remote = await repoRemote(this.env, repo, "write");
						const pushed = (await listRemoteRefs(remote, undefined, { prefix: `refs/heads/${branch}` })).find((r) => r.ref === `refs/heads/${branch}`);
						if (pushed) return { branch, commit: pushed.oid };
						const ws = await cloneRepo({ ...remote, ref: "main", singleBranch: true });
						const toml = (await readWorkspaceFile(ws, "fluid.toml")) ?? "";
						await checkoutBranch(ws, branch, { create: true });
						for (const kind of onBranch) await commitSeedChange(ws, kind, spec, personas, pinnedTagOf(toml));
						await pushBranch(ws, remote, branch);
						return { branch, commit: await headCommit(ws) };
					})
				: null;
		await step.do("ready", async () => {
			await setFleet(this.env, repo, { status: work ? "gating" : "pinned", lastRun: { runId: `seed-${p.batch}-${p.index}`, kind: "seed", status: "passed", customizations: kinds.join(",") || "none", ...(work ? { workBranch: work.branch } : {}) } });
			return true;
		});
		if (work) {
			await step.do("gate the work branch", async () => {
				await startGateInstance(appExports(this.ctx).GateWorkflow, gateInstanceId(repo, work.branch, work.commit), { repo, branch: work.branch, commit: work.commit, mode: "merge", source: "seed" });
				return true;
			});
		}
		return { repo, kinds };
	}
}

/** Commits one seeded customization with its build-time intent record on the checked-out branch. */
async function commitSeedChange(ws: Awaited<ReturnType<typeof cloneRepo>>, kind: Exclude<SeedKind, "none">, spec: { index: number; userId: string; persona: string }, personas: unknown, stockTag: string | null): Promise<void> {
	const files: Record<string, string> = {};
	for (const path of ["app/index.ts", "app/cards.ts", "fluid.toml"]) files[path] = (await readWorkspaceFile(ws, path)) ?? "";
	const change = seedChange(kind, files, { personas, persona: spec.persona });
	const intentId = newIntentId();
	const intent = buildIntent({ id: intentId, userId: spec.userId, agent: "seed-customization", request: requestFor(kind, spec.index), purpose: change.purpose, modes: change.modes_affected, files: [...Object.keys(change.files), intentPath(intentId)], stockTag: stockTag ?? "unknown", extra: { seeded: true, kind } });
	await writeFiles(ws, { ...change.files, [intentPath(intentId)]: intentJson(intent) });
	await commitChanges(ws, { message: `${change.summary}\n\nSeeded customization for the demo fleet (${kind}).`, intentId, author: { name: `user:${spec.userId}`, email: `${spec.userId}@users.fluid.invalid` } });
}

/** Picks the newest tag whose floor does not carry the demo tightening yet; falls back to the newest tag. */
export function pickSeedBaseTag(newestFirst: { tag: string; tightened: boolean }[]): string | null {
	return newestFirst.find((t) => !t.tightened)?.tag ?? newestFirst[0]?.tag ?? null;
}

/**
 * Seeded forks pin the newest published release whose invariants do not yet
 * include the demo release overlay, so a demo release tightens their floor.
 * On a fresh account that is simply the latest release.
 */
async function seedBaseTag(env: Env): Promise<string> {
	const tags = (await fleetStub(env).stockTags()).filter(isReleaseTag).reverse().slice(0, 12);
	const checked: { tag: string; tightened: boolean }[] = [];
	{
		using stock = await openRepo(env.ARTIFACTS, STOCK_REPO);
		for (const tag of tags) {
			const tightened = hasDemoTightening(await readTextFile(stock, tag, "tests/invariants/manifest.json").catch(() => null));
			checked.push({ tag, tightened });
			if (!tightened) break;
		}
	}
	return pickSeedBaseTag(checked) ?? (await currentStockTag(env));
}

export class HarvestWorkflow extends WorkflowEntrypoint<Env, HarvestParams> {
	async run(event: Readonly<WorkflowEvent<HarvestParams>>, workflowStep: WorkflowStep) {
		const p = event.payload;
		return guarded(steps(workflowStep), this.env, { runId: p.runId, kind: "harvest" }, () => this.execute(event, workflowStep));
	}

	private async execute(event: Readonly<WorkflowEvent<HarvestParams>>, workflowStep: WorkflowStep) {
		const step = steps(workflowStep);
		const p = event.payload;
		const log = runLog(this.env, p.runId);
		const repos = await step.do("list forks", async () => {
			await ensureRun(this.env, { id: p.runId, kind: "harvest" });
			const forks = (await fleetStub(this.env).list()).filter((f) => f.status !== "provisioning").map((f) => f.repo);
			await log.step(`Read build-time intent records across ${forks.length} forks`, "running", "Only forks with harvest_opt_in = true are read");
			return forks;
		});
		const records: HarvestRecord[] = [];
		let optedIn = 0;
		for (let i = 0; i < repos.length; i += HARVEST_BATCH) {
			const part = await step.do(`read intents ${i}`, GIT_STEP, async () => readBatch(this.env, repos.slice(i, i + HARVEST_BATCH)));
			records.push(...part.records);
			optedIn += part.optedIn;
		}
		const proposals = await step.do("cluster and label", { retries: { limit: 1, delay: "2 seconds" }, timeout: "5 minutes" }, async () => {
			await log.step(`Read build-time intent records across ${repos.length} forks`, "done", `${optedIn} opted in; ${records.filter((r) => harvestable(r.intent)).length} customization records (onboarding, merge, and repair records are skipped)`);
			await log.step("Cluster similar requests", "running");
			const clusters = clusterRecords(records);
			await log.step("Cluster similar requests", "done", `${clusters.length} clusters by request, purpose, and files (keyword Jaccard)`);
			await log.step("Label clusters", "running");
			const out: HarvestProposal[] = [];
			for (const [index, cluster] of clusters.entries()) {
				let label = deterministicLabel(cluster);
				let summary: string | null = null;
				if (index < MAX_LABELS && cluster.records.length > 1) {
					try {
						const res = await callModel(this.env.AI, labelPrompt(cluster), LABEL_SCHEMA, { model: FAST_MODEL });
						label = cleanText(String(res.label), 60).replace(/[.!]+$/, "") || label;
						summary = cleanText(String(res.summary), 300) || null;
					} catch {
						summary = null;
					}
				}
				out.push(proposalOf(cluster, label, summary));
			}
			await log.step("Label clusters", "done", out.slice(0, 5).map((pr) => `${pr.cluster} (${pr.count})`).join(", ") || "no clusters");
			return out;
		});
		const drafted = await step.do("draft stock branches", GIT_STEP, async () => {
			await log.step("Draft stock feature branches for eligible clusters", "running");
			const eligible = proposals.filter((pr) => pr.eligible && pr.referenceFork).slice(0, MAX_DRAFTS);
			const result = proposals.map((pr) => ({ ...pr }));
			const remote = await repoRemote(this.env, STOCK_REPO, "write");
			const ws = await cloneRepo({ ...remote, ref: "main", singleBranch: true });
			// A harvest run replaces earlier drafts: harvest/* branches no current cluster drafts are removed.
			const keep = new Set(eligible.map((pr) => `harvest/${pr.slug}`));
			for (const ref of await listRemoteRefs(remote)) {
				const name = ref.ref.replace(/^refs\/heads\//, "");
				if (ref.ref.startsWith("refs/heads/harvest/") && !keep.has(name)) await deleteRemoteBranch(ws, remote, name);
			}
			for (const pr of eligible) {
				const draftBranch = `harvest/${pr.slug}`;
				const files = await referenceFiles(this.env, pr.referenceFork!, draftFilesFor(pr));
				await checkoutBranch(ws, "main");
				await checkoutBranch(ws, draftBranch, { create: true });
				const intentId = newIntentId();
				const intent = buildIntent({
					id: intentId,
					userId: "mothership",
					agent: "harvester",
					request: `Harvest "${pr.cluster}" from ${pr.count} forks`,
					purpose: pr.summary,
					modes: pr.modes_affected,
					files: [...Object.keys(files), `harvest/${pr.slug}.md`, intentPath(intentId)],
					stockTag: "main",
					extra: { forks: pr.forks.slice(0, 50), source_intents: pr.intents.slice(0, 50).map((x) => `${x.repo}:${x.id}`), reference_fork: pr.referenceFork },
				});
				intent.author = "mothership:harvester";
				const doc = proposalDoc(pr, draftBranch);
				await writeFiles(ws, { ...files, [`harvest/${pr.slug}.md`]: doc, [intentPath(intentId)]: intentJson(intent) });
				await commitChanges(ws, { message: `Draft ${pr.cluster} as a stock feature\n\n${pr.count} opted-in forks built this independently. Reference implementation from ${pr.referenceFork}. Draft only: it needs review, tests in tests/functional, and a release.`, intentId, author: { name: "Fluid harvester", email: "harvester@fluid.invalid" } });
				await pushBranch(ws, remote, draftBranch, { force: true });
				const target = result.find((x) => x.slug === pr.slug)!;
				target.draftBranch = draftBranch;
				target.retires = `When this ships in stock, upgrade agents retire the matching custom code in ${pr.count} forks, guided by these intent records.`;
			}
			await log.step("Draft stock feature branches for eligible clusters", "done", result.filter((x) => x.draftBranch).map((x) => `${x.draftBranch} (${x.count} forks)`).join(", ") || "No cluster is eligible");
			return result;
		});
		await step.do("finish", async () => {
			const stored = drafted.map((pr) => ({ ...pr, intents: pr.intents.slice(0, 30) }));
			await fleetStub(this.env).setValue(HARVEST_KEY, { at: new Date().toISOString(), runId: p.runId, proposals: stored } as never);
			await log.status("passed", { proposals: stored.length });
			return true;
		});
		return { clusters: drafted.length, drafted: drafted.filter((x) => x.draftBranch).length };
	}
}

async function readBatch(env: Env, repos: string[]): Promise<{ records: HarvestRecord[]; optedIn: number }> {
	const records: HarvestRecord[] = [];
	let optedIn = 0;
	let next = 0;
	const worker = async () => {
		while (next < repos.length) {
			const repo = repos[next++]!;
			try {
				let toml: string | null;
				{
					using handle = await openRepo(env.ARTIFACTS, repo);
					toml = await readTextFile(handle, "main", "fluid.toml");
				}
				if (!toml || !preferencesOf(parseToml(toml)).harvest_opt_in) continue;
				optedIn++;
				for (const intent of await readIntents(env, repo, "main")) records.push({ repo, intent });
			} catch (error) {
				console.warn(`harvest: skipped ${repo}: ${errorText(error)}`);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, repos.length) }, worker));
	return { records, optedIn };
}

async function referenceFiles(env: Env, repo: string, paths: string[]): Promise<Record<string, string>> {
	using handle = await openRepo(env.ARTIFACTS, repo);
	const sha = await headOf(handle, "main");
	if (!sha) return {};
	const wanted = new Set(paths.filter((path) => isRuntimePath(path)));
	return await readCommitFiles(handle, sha, { file: (path) => wanted.has(path) });
}

function proposalDoc(pr: HarvestProposal, branch: string): string {
	return [
		`# Harvest proposal: ${pr.cluster}`,
		"",
		pr.summary,
		"",
		`- Forks: ${pr.count} (${pr.forks.slice(0, 20).join(", ")}${pr.forks.length > 20 ? ", ..." : ""})`,
		`- Modes affected: ${pr.modes_affected.join(", ") || "none"}`,
		`- Reference implementation: ${pr.referenceFork}`,
		`- Files: ${pr.proposedFiles.join(", ")}`,
		`- Branch: ${branch}`,
		"",
		"## Intent records",
		"",
		...pr.intents.slice(0, 20).map((i) => `- ${i.repo}: ${i.id} "${i.request}"`),
		"",
		"This is a draft. Before it ships: review the code, add functional probes, and publish it in a stock release.",
		"",
	].join("\n");
}

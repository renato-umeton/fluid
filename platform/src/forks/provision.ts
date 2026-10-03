// Fork provisioning (spec section 4.2): fork `stock` into `user-<id>`, then
// commit the onboarding change on main: fluid.toml keeps the stock values and
// gains the user's preferences, and a build-time intent record explains why.
import synthetic from "../generated/synthetic.json";
import { cloneRepo, commitChanges, deleteRemoteBranch, listRemoteRefs, pushBranch, readWorkspaceFile, writeFiles, type Remote } from "../git/ops.ts";
import { forkRepoName, newIntentId, STOCK_REPO } from "../lib/names.ts";
import { parseToml, setTomlValue } from "../lib/toml.ts";
import { headOf, isNotFound, openRepo, readCommitFiles, readTextFile } from "../runtime/repo-files.ts";
import { listStockTags } from "../stock/publish.ts";
import { fleetStub } from "../stubs.ts";
export { fleetStub };

export interface Persona {
	id: string;
	displayName: string;
	role: string;
	department: string;
	story: string;
	[key: string]: unknown;
}

export interface Preferences {
	auto_upgrade?: boolean;
	harvest_opt_in?: boolean;
}

export interface BuildTimeIntent {
	id: string;
	author: string;
	agent: string | null;
	request: string;
	purpose: string;
	modes_affected: string[];
	files: string[];
	tests_added: string[];
	stock_tag: string;
	[key: string]: unknown;
}

export interface ForkInfo {
	repo: string;
	remote: string;
	stockTag: string;
	tau: number | null;
	stockMinTau: number;
	preferences: { auto_upgrade: boolean; harvest_opt_in: boolean };
	persona: string | null;
	status: string | null;
	branches: string[];
	head: string | null;
	lastGate: unknown;
}

export const STOCK_MIN_TAU = 0.85;

export function personas(): Persona[] {
	return (synthetic as unknown as { personas: { personas: Persona[] } }).personas.personas;
}

export function findPersona(id: string): Persona | null {
	return personas().find((p) => p.id === id) ?? null;
}

/** fluid.toml for a new fork: stock values, the pinned tag, and the user's preferences. */
export function onboardingToml(stockToml: string, input: { stockTag: string; persona: string; preferences?: Preferences }): string {
	let toml = setTomlValue(stockToml, null, "stock_tag", input.stockTag);
	toml = setTomlValue(toml, "preferences", "persona", input.persona);
	for (const key of ["auto_upgrade", "harvest_opt_in"] as const) {
		const value = input.preferences?.[key];
		if (value !== undefined) {
			if (typeof value !== "boolean") throw new Error(`preferences.${key} must be a boolean`);
			toml = setTomlValue(toml, "preferences", key, value);
		}
	}
	return toml;
}

export function onboardingIntent(input: { id: string; userId: string; persona: Persona; stockTag: string }): BuildTimeIntent {
	return {
		id: input.id,
		author: `user:${input.userId}`,
		agent: "onboarding",
		request: `Provision a personal Fluid fork for ${input.persona.role.toLowerCase()} work`,
		purpose: `Start from stock ${input.stockTag} with the stock floor intact and record the persona (${input.persona.id}) and preferences in fluid.toml.`,
		modes_affected: [],
		files: ["fluid.toml", `.intent/${input.id}.json`],
		tests_added: [],
		stock_tag: input.stockTag,
	};
}

export async function currentStockTag(env: Env): Promise<string> {
	const tags = await fleetStub(env).stockTags();
	const latest = tags[tags.length - 1] ?? (await listStockTags(env))[0];
	if (!latest) throw new Error("no stock release is published yet; publish stock first");
	return latest;
}

export interface ProvisionInput {
	userId: string;
	persona: Persona;
	preferences?: Preferences;
	seeded?: boolean;
	/** Refuse a new fork once the fleet holds this many (failed attempts do not count). */
	maxTotal?: number;
	/** A workflow retry continuing its own earlier attempt. */
	resume?: boolean;
}

export class ProvisioningBusyError extends Error {
	constructor(readonly repo: string) {
		super(`fork ${repo} is already being provisioned`);
		this.name = "ProvisioningBusyError";
	}
}

export class FleetFullError extends Error {
	constructor() {
		super("the demo fleet is full; try again later");
		this.name = "FleetFullError";
	}
}

/** Creates the user's fork if needed and returns its info. Safe to call twice. */
export async function provisionFork(env: Env, input: ProvisionInput): Promise<ForkInfo> {
	const repoName = forkRepoName(input.userId);
	const fleet = fleetStub(env);
	const stockTag = await currentStockTag(env);
	const claim = await fleet.claimProvisioning({ repo: repoName, userId: input.userId, persona: input.persona.id, pinnedTag: stockTag, seeded: input.seeded, maxTotal: input.maxTotal, resume: input.resume });
	if (claim.outcome === "exists") return getForkInfo(env, repoName);
	if (claim.outcome === "busy") throw new ProvisioningBusyError(repoName);
	if (claim.outcome === "full") throw new FleetFullError();
	try {
		const remote = await forkStock(env, repoName, input.persona);
		const ws = await cloneRepo({ ...remote, ref: "main", singleBranch: true });
		// The fork copies every stock branch; draft branches (harvest/*) are mothership work, not the user's.
		for (const ref of await listRemoteRefs(remote)) {
			if (ref.ref.startsWith("refs/heads/") && ref.ref !== "refs/heads/main") await deleteRemoteBranch(ws, remote, ref.ref.slice("refs/heads/".length));
		}
		const stockToml = await readWorkspaceFile(ws, "fluid.toml");
		if (stockToml === null) throw new Error("stock has no fluid.toml");
		// A retry after a partial failure may find the onboarding commit already pushed.
		const alreadyOnboarded = (parseToml(stockToml).preferences as Record<string, unknown> | undefined)?.persona !== undefined;
		if (!alreadyOnboarded) {
			const intentId = newIntentId();
			const intent = onboardingIntent({ id: intentId, userId: input.userId, persona: input.persona, stockTag });
			await writeFiles(ws, {
				"fluid.toml": onboardingToml(stockToml, { stockTag, persona: input.persona.id, preferences: input.preferences }),
				[`.intent/${intentId}.json`]: `${JSON.stringify(intent, null, 2)}\n`,
			});
			await commitChanges(ws, {
				message: `Onboard ${input.persona.id} on stock ${stockTag}\n\nRecords the persona and preferences so agents and the gate know whose fork this is and which release it is pinned to.`,
				intentId,
				author: { name: `user:${input.userId}`, email: `${input.userId}@users.fluid.invalid` },
			});
			await pushBranch(ws, remote, "main");
		}
		await fleet.update(repoName, { status: "pinned" });
		return getForkInfo(env, repoName);
	} catch (error) {
		await fleet.update(repoName, { status: "failed" });
		throw error;
	}
}

async function forkStock(env: Env, repoName: string, persona: Persona): Promise<Remote> {
	using stock = await env.ARTIFACTS.get(STOCK_REPO);
	try {
		const fork = await stock.fork(repoName, { description: `Fluid fork for ${persona.displayName}`, defaultBranchOnly: true });
		return { url: fork.remote, token: fork.token };
	} catch (error) {
		if ((error as { code?: string }).code !== "ALREADY_EXISTS" && !/already exists/i.test(String((error as Error).message))) throw error;
		using existing = await env.ARTIFACTS.get(repoName);
		const info = await existing.info();
		return { url: info.remote, token: (await existing.createToken("write", 900)).plaintext };
	}
}

export async function getForkInfo(env: Env, repoName: string): Promise<ForkInfo> {
	let repo: ArtifactsRepo;
	try {
		repo = await env.ARTIFACTS.get(repoName);
	} catch (error) {
		if (isNotFound(error)) throw new ForkNotFoundError(repoName);
		throw error;
	}
	using handle = repo;
	const info = await handle.info().catch((error: unknown) => {
		if (isNotFound(error)) throw new ForkNotFoundError(repoName);
		throw error;
	});
	const [toml, head, refs, fleetEntry] = await Promise.all([
		readTextFile(handle, "main", "fluid.toml"),
		headOf(handle, "main"),
		handle.createToken("read", 300).then((t) => listRemoteRefs({ url: info.remote, token: t.plaintext })),
		fleetStub(env).get(repoName),
	]);
	const parsed = toml ? parseToml(toml) : {};
	const thresholds = parsed.thresholds as Record<string, unknown> | undefined;
	const lastRun = fleetEntry?.lastRun ?? null;
	return {
		repo: repoName,
		remote: info.remote,
		stockTag: typeof parsed.stock_tag === "string" ? parsed.stock_tag : (fleetEntry?.pinnedTag ?? "unknown"),
		tau: typeof thresholds?.tau === "number" ? thresholds.tau : null,
		stockMinTau: STOCK_MIN_TAU,
		preferences: preferencesOf(parsed),
		persona: fleetEntry?.persona ?? null,
		status: fleetEntry?.status ?? null,
		branches: refs.filter((r) => r.ref.startsWith("refs/heads/")).map((r) => r.ref.slice("refs/heads/".length)).sort(),
		head,
		lastGate: lastRun && lastRun.kind === "gate" ? lastRun : null,
	};
}

export function preferencesOf(parsed: Record<string, unknown>): { auto_upgrade: boolean; harvest_opt_in: boolean } {
	const prefs = (parsed.preferences ?? {}) as Record<string, unknown>;
	return { auto_upgrade: prefs.auto_upgrade === true, harvest_opt_in: prefs.harvest_opt_in !== false };
}

export class ForkNotFoundError extends Error {
	constructor(readonly repo: string) {
		super(`fork ${repo} not found`);
		this.name = "ForkNotFoundError";
	}
}

/** Build-time intent records at a ref (files under .intent/). */
export async function readIntents(env: Env, repoName: string, ref = "main"): Promise<BuildTimeIntent[]> {
	using repo = await openRepo(env.ARTIFACTS, repoName);
	const sha = await headOf(repo, ref);
	if (!sha) throw new ForkNotFoundError(`${repoName}@${ref}`);
	const files = await readCommitFiles(repo, sha, { file: (p) => p.startsWith(".intent/") && p.endsWith(".json"), dir: (p) => p === ".intent" });
	return Object.entries(files)
		.map(([path, text]) => {
			try {
				return JSON.parse(text) as BuildTimeIntent;
			} catch {
				throw new Error(`invalid intent record ${path} in ${repoName}@${ref}`);
			}
		})
		.sort((a, b) => a.id.localeCompare(b.id));
}

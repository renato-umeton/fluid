// Publishes a stock release into the Artifacts `stock` repo: the complete file
// set becomes the tree of main, committed with an Intent-Id trailer and tagged
// with an annotated tag. Publishing an existing tag is a no-op, so the admin
// route and the script are safe to re-run.
import stockSource from "../generated/stock-source.json";
import { cloneRepo, commitChanges, createTag, initRepo, listRemoteRefs, pushBranch, pushTag, replaceTree, type Remote, type Workspace } from "../git/ops.ts";
import { parseToml, setTomlValue } from "../lib/toml.ts";
import { STOCK_REPO } from "../lib/names.ts";
import { headOf, isNotFound, readCommitFiles } from "../runtime/repo-files.ts";

export interface StockRelease {
	tag: string;
	files: Record<string, string>;
	intentId: string | null;
	message?: string;
}

export interface PublishResult {
	repo: string;
	tag: string;
	commit: string;
	created: boolean;
	alreadyPublished: boolean;
	files: number;
}

const TAG_PATTERN = /^v\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/;

/** The stock release bundled into the platform from the monorepo's stock/ directory. */
export function bundledStockRelease(): StockRelease {
	return { tag: stockSource.stockTag, files: stockSource.files as Record<string, string>, intentId: stockSource.intentId };
}

/** Makes fluid.toml in the release name the release tag. */
export function alignStockTag(files: Record<string, string>, tag: string): Record<string, string> {
	const toml = files["fluid.toml"];
	if (toml === undefined) throw new Error("stock release has no fluid.toml");
	if (parseToml(toml).stock_tag === tag) return files;
	return { ...files, "fluid.toml": setTomlValue(toml, null, "stock_tag", tag) };
}

export async function publishStockRelease(env: Env, release: StockRelease): Promise<PublishResult> {
	if (!TAG_PATTERN.test(release.tag)) throw new Error(`invalid stock tag ${JSON.stringify(release.tag)}: expected vMAJOR.MINOR.PATCH`);
	if (!release.files["app/index.ts"] && !release.files["app/index.js"]) throw new Error("stock release has no app/index.ts");
	const files = alignStockTag(release.files, release.tag);
	const target = await openOrCreateStock(env);
	if (target.existingTagCommit) {
		return { repo: STOCK_REPO, tag: release.tag, commit: target.existingTagCommit, created: false, alreadyPublished: true, files: Object.keys(files).length };
	}
	const remote: Remote = { url: target.remote, token: target.token };
	const ws: Workspace = target.empty ? await initRepo("main") : await cloneRepo({ ...remote, ref: "main", singleBranch: true });
	await replaceTree(ws, files);
	const commit = await commitChanges(ws, {
		message: release.message ?? `Stock release ${release.tag}\n\nPublishes the ${release.tag} floor: intent engine, mode contracts, policies, connectors, and the invariant and functional suites.`,
		intentId: release.intentId,
	});
	await createTag(ws, { tag: release.tag, message: `Fluid stock release ${release.tag}` });
	await pushBranch(ws, remote, "main");
	await pushTag(ws, remote, release.tag);
	return { repo: STOCK_REPO, tag: release.tag, commit, created: target.created, alreadyPublished: false, files: Object.keys(files).length };

	async function openOrCreateStock(e: Env) {
		const existing = await tryGet(e, STOCK_REPO);
		if (!existing) {
			const created = await e.ARTIFACTS.create(STOCK_REPO, { description: "Fluid stock release (mothership)", setDefaultBranch: "main" });
			return { remote: created.remote, token: created.token, empty: true, created: true, existingTagCommit: null as string | null };
		}
		using repo = existing;
		const info = await repo.info();
		const tagCommit = await headOf(repo, release.tag);
		const mainCommit = tagCommit ? null : await headOf(repo, "main");
		const token = tagCommit ? "" : (await repo.createToken("write", 900)).plaintext;
		return { remote: info.remote, token, empty: !tagCommit && !mainCommit, created: false, existingTagCommit: tagCommit };
	}
}

async function tryGet(env: Env, name: string): Promise<ArtifactsRepo | null> {
	try {
		const repo = await env.ARTIFACTS.get(name);
		await repo.info();
		return repo;
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
}

/** Every file of the stock repo at a ref (for building the next release from the current one). */
export async function readStockFiles(env: Env, ref: string): Promise<Record<string, string>> {
	using repo = await env.ARTIFACTS.get(STOCK_REPO);
	const sha = await headOf(repo, ref);
	if (!sha) throw new Error(`stock ref ${ref} not found`);
	return readCommitFiles(repo, sha, { file: () => true });
}

/** Tags published in stock, newest first by semantic version. */
export async function listStockTags(env: Env): Promise<string[]> {
	const repo = await tryGet(env, STOCK_REPO);
	if (!repo) return [];
	using handle = repo;
	const info = await handle.info();
	const token = (await handle.createToken("read", 300)).plaintext;
	const refs = await listRemoteRefs({ url: info.remote, token });
	return refs
		.map((r) => r.ref)
		.filter((ref) => ref.startsWith("refs/tags/") && !ref.endsWith("^{}"))
		.map((ref) => ref.slice("refs/tags/".length))
		.filter((tag) => TAG_PATTERN.test(tag))
		.sort(compareSemverDesc);
}

export function compareSemverDesc(a: string, b: string): number {
	const pa = a.slice(1).split(/[.-]/).map((x) => Number(x) || 0);
	const pb = b.slice(1).split(/[.-]/).map((x) => Number(x) || 0);
	for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i]! - pa[i]!;
	return 0;
}

// The floor a gate enforces always comes from the `stock` repo at the fork's
// pinned tag: the probe runner (with stock's own toml and types modules) and
// the invariant and functional manifests. Copies of tests/ inside a fork are
// ignored, and no fork file is ever loaded next to the runner.
//
// The pin must name a published release: it has to look like vMAJOR.MINOR.PATCH,
// exist as a tag in stock, and be recorded as a release (fleet stock tags or
// releases/<tag>.json). It is resolved only as a tag, never as a branch or SHA.
import { StockTagError, isReleaseTag } from "../gate/pins.ts";
import { listRemoteRefs } from "../git/ops.ts";
import { STOCK_REPO } from "../lib/names.ts";
import { RUNNER_PATH, RUNNER_STOCK_DEPS } from "../runtime/modules.ts";
import { resolveCommit } from "../runtime/refs.ts";
import { openRepo, readTextFile } from "../runtime/repo-files.ts";
import { fleetStub } from "../stubs.ts";
import { releaseMetadataPath } from "./releases.ts";

export interface StockSuite {
	tag: string;
	sha: string;
	/** tests/runner.ts, app/toml.ts, app/types.ts at the tag. */
	runnerFiles: Record<string, string>;
	manifests: { invariant: unknown; functional: unknown };
	/** Stock fluid.toml at the tag (the stock minimum tau lives here and in the invariants). */
	fluidToml: string | null;
}

const suites = new Map<string, StockSuite>();
/** Release tags never move, so a tag's commit is cached for the life of the isolate. */
const tagCommits = new Map<string, string>();

/** Commit of a published stock release tag. Throws StockTagError for anything else. */
export async function resolveStockTag(env: Env, tag: unknown): Promise<string> {
	if (!isReleaseTag(tag)) throw new StockTagError(String(tag), "must name a stock release tag such as v1.2.0 (not a branch or commit)");
	const cached = tagCommits.get(tag);
	if (cached) return cached;
	using repo = await openRepo(env.ARTIFACTS, STOCK_REPO);
	const info = await repo.info();
	const token = (await repo.createToken("read", 300)).plaintext;
	const refs = await listRemoteRefs({ url: info.remote, token }, undefined, { prefix: "refs/tags/", peelTags: true });
	const entry = refs.find((r) => r.ref === `refs/tags/${tag}`);
	if (!entry) throw new StockTagError(tag, "is not a tag in stock");
	const published = (await fleetStub(env).stockTags()).includes(tag) || (await readTextFile(repo, tag, releaseMetadataPath(tag))) !== null;
	if (!published) throw new StockTagError(tag, "is not a published stock release");
	// An annotated tag is peeled to its commit; a lightweight tag already names one.
	const sha = entry.peeled ?? (await resolveCommit(repo, entry.oid).catch(() => resolveCommit(repo, tag)));
	tagCommits.set(tag, sha);
	return sha;
}

export async function loadStockSuite(env: Env, tag: string): Promise<StockSuite> {
	const sha = await resolveStockTag(env, tag);
	const cached = suites.get(sha);
	if (cached) return { ...cached, tag };
	using repo = await openRepo(env.ARTIFACTS, STOCK_REPO);
	const paths = [RUNNER_PATH, ...RUNNER_STOCK_DEPS, "tests/invariants/manifest.json", "tests/functional/manifest.json", "fluid.toml"];
	const texts = await Promise.all(paths.map((path) => readTextFile(repo, sha, path)));
	const byPath = Object.fromEntries(paths.map((path, i) => [path, texts[i]]));
	const runnerFiles: Record<string, string> = {};
	for (const path of [RUNNER_PATH, ...RUNNER_STOCK_DEPS]) {
		const text = byPath[path];
		if (text === null || text === undefined) throw new Error(`stock ${tag} has no ${path}`);
		runnerFiles[path] = text;
	}
	const invariant = byPath["tests/invariants/manifest.json"];
	const functional = byPath["tests/functional/manifest.json"];
	if (!invariant || !functional) throw new Error(`stock ${tag} is missing a test manifest`);
	const suite: StockSuite = {
		tag,
		sha,
		runnerFiles,
		manifests: { invariant: JSON.parse(invariant), functional: JSON.parse(functional) },
		fluidToml: byPath["fluid.toml"] ?? null,
	};
	if (suites.size > 20) suites.delete(suites.keys().next().value!);
	suites.set(sha, suite);
	return suite;
}

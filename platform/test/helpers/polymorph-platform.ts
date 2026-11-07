// The platform with polymorphic copies switched on, for Node tests: stock
// published at its bundled release tag with upstream's list, forks seeded
// from stock files (patched where a test needs other behavior), the
// polymorph secret set, a fake Worker Loader, and fetch answering only the
// fake git remotes. Call cleanup() in afterAll: it fails when anything asked
// the model through these deps, which no test here should do.
import { vi } from "vitest";
import stockSource from "../../src/generated/stock-source.json";
import { POLYMORPH_LIST_PATH, parsePolymorphList } from "../../src/polymorph/list.ts";
import type { RuntimeDeps } from "../../src/runtime/loader.ts";
import { releaseMetadata, releaseMetadataPath } from "../../src/stock/releases.ts";
import { apiEnv } from "./api-env.ts";
import { fakeLoader } from "./fake-loader.ts";

export const TAG = stockSource.stockTag;
export const POLYMORPH_TEST_SECRET = "polymorph-platform-test-secret-01";
const stockFiles = stockSource.files as Record<string, string>;
/** Upstream's list at TAG. */
export const LISTED = parsePolymorphList(stockFiles[POLYMORPH_LIST_PATH]!);

/** releases/<tag>.json, which makes a stock tag a published release. */
export function release(tag: string): Record<string, string> {
	return { [releaseMetadataPath(tag)]: `${JSON.stringify(releaseMetadata({ tag, date: new Date("2026-10-04T00:00:00Z") }), null, 2)}\n` };
}

/** Stock at TAG as publishStockRelease commits it. */
export const PUBLISHED: Record<string, string> = { ...stockFiles, ...release(TAG) };

/** The line of stock's app/index.ts that builds the card. */
export const BUILD_CARD = "  return buildCard({ request, env, decision, classification, signals, config, answerId: newAnswerId(env) });";
/** The line of stock's app/cards.ts that applies the mode contract, with the attestation flag. */
export const ENFORCE_CONTRACT = "  return enforceContract(draft, { researchNeedsAttestation: decision.researchNeedsAttestation });";

/** Stock files with one file patched. The anchor must still be in stock, so a stock change cannot quietly empty a test. */
export function patched(path: string, anchor: string, replacement: string, files: Record<string, string> = PUBLISHED): Record<string, string> {
	const text = files[path]!;
	if (!text.includes(anchor)) throw new Error(`stock ${path} no longer contains ${JSON.stringify(anchor)}`);
	return { ...files, [path]: text.replace(anchor, replacement) };
}

/**
 * A fork whose behavior depends on a name it builds at run time and reads by
 * computed key, which no static check can see: it reads the decision's
 * attestation flag as decision["research" + "NeedsAttestation"]. The plain
 * fork finds the flag; a copy renamed the property, so it releases held
 * research doses.
 */
export const REFLECTIVE = patched(
	"app/cards.ts",
	ENFORCE_CONTRACT,
	[
		'  const flag = ["research", "NeedsAttestation"].join("");',
		"  return enforceContract(draft, { researchNeedsAttestation: (decision as unknown as Record<string, unknown>)[flag] === true });",
	].join("\n"),
);

export interface PolymorphPlatform {
	t: ReturnType<typeof apiEnv>;
	loader: ReturnType<typeof fakeLoader>;
	deps: RuntimeDeps;
	/** Commit of each seeded fork's main. */
	heads: Record<string, string>;
	/** The same platform without the polymorph secret. */
	withoutSecret(): RuntimeDeps;
	/**
	 * The prompts the model was asked through deps. Stock answers with its
	 * template when the model fails, so a host that threw would never fail a
	 * test: the calls are recorded instead, and cleanup() fails on any.
	 */
	modelCalls: string[];
	cleanup(): void;
}

/** Stock published at TAG and one single-commit fork per entry of forks. */
export function polymorphPlatform(forks: Record<string, Record<string, string>>): PolymorphPlatform {
	const t = apiEnv();
	t.artifacts.seed("stock", { commits: [PUBLISHED], tags: { [TAG]: 0 } });
	const heads: Record<string, string> = {};
	for (const [repo, files] of Object.entries(forks)) heads[repo] = t.artifacts.seed(repo, { commits: [files] }).commits[0]!;
	const loader = fakeLoader();
	Object.assign(t.env, { LOADER: loader, POLYMORPH_SECRET: POLYMORPH_TEST_SECRET });
	vi.stubGlobal("fetch", t.artifacts.fetch);
	const modelCalls: string[] = [];
	const exports = {
		LlmHost: () => ({
			complete: async (prompt: string) => {
				modelCalls.push(prompt);
				return { body: "Reworded by the model." };
			},
		}),
	};
	const deps: RuntimeDeps = { env: t.env, exports };
	return {
		t,
		loader,
		deps,
		heads,
		withoutSecret: () => ({ env: { ...t.env, POLYMORPH_SECRET: undefined } as unknown as Env, exports }),
		modelCalls,
		cleanup: () => {
			loader.cleanup();
			vi.unstubAllGlobals();
			if (modelCalls.length > 0) throw new Error(`these tests never use the model, but it was asked ${modelCalls.length} times`);
		},
	};
}

// The live ask path with renamed copies: serveAsk on production main. A fork
// whose main has a verified copy (stored in Fleet as a rotation stores it)
// answers from that copy, with the model off; any other fork answers plain,
// exactly as before. Forks run through the platform's loader on in-memory
// repos and a fake Worker Loader, so the timeouts leave room for a loaded
// machine.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serveAsk, type ServeAskInput, type ServedCard } from "../src/api/ask.ts";
import { cardDifferences } from "../src/polymorph/equivalence.ts";
import { deriveSeed, fingerprint, namesHash } from "../src/polymorph/names.ts";
import { rotateFork } from "../src/polymorph/rotate.ts";
import { askLoaded, loadForkRuntime, type RuntimeDeps } from "../src/runtime/loader.ts";
import { ledgerStub } from "../src/stubs.ts";
import { LISTED, POLYMORPH_TEST_SECRET, PUBLISHED, TAG, polymorphPlatform, type PolymorphPlatform } from "./helpers/polymorph-platform.ts";
import { fakeWorkflows } from "./helpers/workflows.ts";

const SLOW_MS = 120_000;
const RENAMED = /\$[0-9a-z]{8}/;
const t0 = Date.parse("2026-11-06T10:00:00Z");

const requests = {
	administrative: { question: "Is Morphinex on formulary?", context: { documentType: "budget" } },
	research: { question: "What is the right dose of Morphinex for a patient of 70 kg and 45 years?", context: { documentType: "manuscript", onService: false, screenLabel: { label: "manuscript_editor", confidence: 0.9 } } },
	clinical: { question: "What dose of Morphinex should I give this patient now?", context: { chartOpen: { patientId: "synthetic_patient_117", identified: true }, orderEntryActive: true, onService: true } },
};

// The model rewords a card only when the fork is asked with useModel; each call is recorded here.
const modelCalls: string[] = [];
const MODEL = {
	LlmHost: () => ({
		complete: async (prompt: string) => {
			modelCalls.push(prompt);
			return { body: "Reworded by the model." };
		},
	}),
};
const MODEL_WORDING = "wording:model";

// A fork whose main moved on after its copy was stored.
const MOVED = [PUBLISHED, { ...PUBLISHED, "app/moved.ts": "export const moved = 2;\n" }];

let p: PolymorphPlatform;
const workflows = fakeWorkflows(MODEL);
let deps: RuntimeDeps;

beforeAll(() => {
	p = polymorphPlatform({
		"user-1": PUBLISHED,
		"user-plain": { ...PUBLISHED, "app/plain.ts": "export const plain = 1;\n" },
		"user-model": { ...PUBLISHED, "app/model.ts": "export const model = 1;\n" },
		"user-nosecret": { ...PUBLISHED, "app/nosecret.ts": "export const nosecret = 1;\n" },
		"user-safety": { ...PUBLISHED, "app/safety.ts": "export const safety = 1;\n" },
	});
	p.heads["user-moved"] = p.t.artifacts.seed("user-moved", { commits: MOVED }).commits[1]!;
	for (const repo of Object.keys(p.heads)) p.t.fleet.register({ repo, userId: repo.slice(5), persona: "p", pinnedTag: TAG, status: "pinned" });
	deps = { env: p.t.env, exports: workflows.exports as never };
});

afterAll(() => p?.cleanup());

afterEach(() => {
	vi.restoreAllMocks();
});

/** Stores a verified copy for a fork the way a rotation does, at main's commit unless told otherwise. */
async function storeCopy(repo: string, epoch: number, sha = p.heads[repo]!) {
	const state = { epoch, sha, fingerprint: await fingerprint(await deriveSeed(POLYMORPH_TEST_SECRET, repo, sha, epoch)), namesHash: await namesHash(LISTED) };
	if (!p.t.fleet.setMorph(repo, state, { from: p.t.fleet.morphState(repo)?.epoch ?? null }, t0)) throw new Error(`${repo}: no copy stored`);
	return state;
}

/** serveAsk on production main, as POST /api/ask calls it for the fork's owner. */
function ask(repo: string, request: Record<string, unknown>, options: Partial<ServeAskInput> & { deps?: RuntimeDeps } = {}): Promise<ServedCard> {
	const { deps: using = deps, ...input } = options;
	return serveAsk(using, { repo, ref: "main", request, useModel: false, userId: repo.slice(5), fallback: true, ...input });
}

/** The card as the fork answered it, without what the platform adds (fork, and the ledger's variant). */
function answered(served: ServedCard): Record<string, unknown> {
	const { fork: _fork, ...card } = served;
	const { variant: _variant, ...ledger } = card.ledger;
	return { ...card, ledger };
}

async function ledgerOf(repo: string) {
	return (await ledgerStub(p.t.env, repo.slice(5)).list()).map((entry) => entry.record);
}

describe("serveAsk with a verified copy of main", () => {
	it(
		"answers from the copy: the plain fork's card, named by fork.variant, and recorded with the copy's variant",
		async () => {
			const rotated = await rotateFork(p.deps, "user-1", "schedule");
			if (rotated.outcome !== "rotated") throw new Error(`expected a rotation, got ${rotated.outcome}`);
			const plain = await loadForkRuntime(p.deps, "user-1", "main");
			for (const request of Object.values(requests)) {
				const served = await ask("user-1", request);
				expect(served.fork).toEqual({ repo: "user-1", ref: "main", commit: p.heads["user-1"], variant: rotated.fingerprint });
				expect(cardDifferences(await askLoaded(plain, request), answered(served))).toEqual([]);
				expect(JSON.stringify(served)).not.toMatch(RENAMED);
			}
			const copyId = `user-1:${p.heads["user-1"]}:m${rotated.epoch}.${rotated.fingerprint}.${rotated.namesHash}`;
			expect(p.loader.built).toContain(copyId);
			const ledger = await ledgerOf("user-1");
			expect(ledger).toHaveLength(Object.keys(requests).length);
			expect(ledger.map((record) => record.variant)).toEqual(Object.keys(requests).map(() => rotated.fingerprint));
		},
		SLOW_MS,
	);

	it(
		"records a re-ask with both the question it re-asks and the copy that answered",
		async () => {
			const state = p.t.fleet.morphState("user-1")!;
			const first = await ask("user-1", requests.research);
			const again = await ask("user-1", { ...requests.research, attestation: true }, { reaskOf: first.answer_id });
			expect(again.ledger).toMatchObject({ reask_of: first.answer_id, variant: state.fingerprint });
		},
		SLOW_MS,
	);

	it(
		"answers from the copy with the model off even when the request asks for the model",
		async () => {
			const state = await storeCopy("user-model", 1);
			const calls = modelCalls.length;
			const served = await ask("user-model", requests.administrative, { useModel: true });
			expect(served.fork).toMatchObject({ variant: state.fingerprint });
			expect(served.signals).not.toContain(MODEL_WORDING);
			expect(modelCalls.length).toBe(calls);
			expect(p.loader.built.filter((id) => id.startsWith("user-model:") && id.endsWith(":llm"))).toEqual([]);
		},
		SLOW_MS,
	);
});

describe("serveAsk without a copy to serve", () => {
	it(
		"answers plain, exactly as before, for a fork with no stored copy: no variant, and the model when asked",
		async () => {
			const warn = vi.spyOn(console, "warn");
			const served = await ask("user-plain", requests.administrative, { useModel: true });
			expect(served.fork).toEqual({ repo: "user-plain", ref: "main", commit: p.heads["user-plain"] });
			expect(served.signals).toContain(MODEL_WORDING);
			expect((await ledgerOf("user-plain")).map((record) => "variant" in record)).toEqual([false]);
			expect(p.loader.built).toContain(`user-plain:${p.heads["user-plain"]}:llm`);
			expect(warn).not.toHaveBeenCalled();
		},
		SLOW_MS,
	);

	it(
		"answers plain, honoring useModel, without trying the copy or logging, when the stored copy is of an older commit",
		async () => {
			await storeCopy("user-moved", 1, p.t.artifacts.repos.get("user-moved")!.git.commits[0]!);
			const warn = vi.spyOn(console, "warn");
			const sign = vi.spyOn(crypto.subtle, "sign");
			const served = await ask("user-moved", requests.administrative, { useModel: true });
			expect(served.fork).toEqual({ repo: "user-moved", ref: "main", commit: p.heads["user-moved"] });
			expect(served.signals).toContain(MODEL_WORDING);
			expect(warn).not.toHaveBeenCalled();
			expect(sign).not.toHaveBeenCalled();
			expect(p.loader.built.filter((id) => id.startsWith("user-moved:") && id.includes(":m"))).toEqual([]);
		},
		SLOW_MS,
	);

	it(
		"answers plain, exactly as before, on a platform without a secret, whatever Fleet stored",
		async () => {
			await storeCopy("user-nosecret", 1);
			const warn = vi.spyOn(console, "warn");
			const served = await ask("user-nosecret", requests.administrative, { useModel: true, deps: { ...deps, env: p.withoutSecret().env } });
			expect(served.fork).toEqual({ repo: "user-nosecret", ref: "main", commit: p.heads["user-nosecret"] });
			expect(served.signals).toContain(MODEL_WORDING);
			expect(warn).not.toHaveBeenCalled();
		},
		SLOW_MS,
	);

	it(
		"lets stock answer once a safety grace period is over, even for a fork with a copy",
		async () => {
			await storeCopy("user-safety", 1);
			p.t.fleet.register({ repo: "user-safety", userId: "safety", persona: "p", pinnedTag: "v0.9.0", status: "pinned" });
			p.t.fleet.addRelease({ tag: TAG, notes: "", safety: true, date: new Date(t0).toISOString(), graceDays: 14, graceUntil: new Date(t0).toISOString(), commit: null });
			const served = await ask("user-safety", requests.administrative);
			expect(served.fork).toMatchObject({ repo: "user-safety", servedBy: { repo: "stock", ref: TAG } });
			expect(served.fork).not.toHaveProperty("variant");
		},
		SLOW_MS,
	);
});

// The live ask path with renamed copies: serveAsk on production main. A fork
// whose main has a verified copy (stored in Fleet as a rotation stores it)
// answers from that copy, with the model off; any other fork answers plain,
// exactly as before. Forks run through the platform's loader on in-memory
// repos and a fake Worker Loader, so the timeouts leave room for a loaded
// machine.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { COPY_RETRY, serveAsk, TRIPWIRE_REFUSAL, UNSCANNABLE_REFUSAL, type ServeAskInput, type ServedCard } from "../src/api/ask.ts";
import { HttpError } from "../src/api/http.ts";
import { cardDifferences } from "../src/polymorph/equivalence.ts";
import { deriveSeed, fingerprint, namesHash, variantNames } from "../src/polymorph/names.ts";
import { rotateFork } from "../src/polymorph/rotate.ts";
import { SCAN_LIMITS } from "../src/polymorph/tokens.ts";
import { askLoaded, loadForkRuntime, type RuntimeDeps } from "../src/runtime/loader.ts";
import { ledgerStub } from "../src/stubs.ts";
import { copyKey, rotationId } from "../src/workflows/common.ts";
import { cookieFor, post } from "./helpers/api-env.ts";
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
		"user-trip": { ...PUBLISHED, "app/trip.ts": "export const trip = 1;\n" },
		"user-flood": { ...PUBLISHED, "app/flood.ts": "export const flood = 1;\n" },
		"user-deep": { ...PUBLISHED, "app/deep.ts": "export const deep = 1;\n" },
		"user-route": { ...PUBLISHED, "app/route.ts": "export const route = 1;\n" },
		"user-busy": { ...PUBLISHED, "app/busy.ts": "export const busy = 1;\n" },
		"user-flaky": { ...PUBLISHED, "app/flaky.ts": "export const flaky = 1;\n" },
		"user-resecret": { ...PUBLISHED, "app/resecret.ts": "export const resecret = 1;\n" },
		"user-renames": { ...PUBLISHED, "app/renames.ts": "export const renames = 1;\n" },
		// More JavaScript in one module than the renamer reads: no copy of it can be built.
		"user-unreadable": { ...PUBLISHED, "app/big.js": `// ${"x".repeat(SCAN_LIMITS.moduleChars)}\nexport const big = 1;\n` },
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

describe("serveAsk and a copy's tripwires", () => {
	/** A research question whose display options set a key: an original listed name, or a renamed one. */
	const naming = (key: string) => ({ ...requests.research, context: { ...requests.research.context, display: { [key]: false } } });
	/** A renamed researchNeedsAttestation that is not this copy's own: another copy's name. */
	async function foreignName(repo: string, epoch: number): Promise<string> {
		const own = (await variantNames(await deriveSeed(POLYMORPH_TEST_SECRET, repo, p.heads[repo]!, epoch), LISTED)).get("researchNeedsAttestation")!;
		return own.endsWith("$zzzzzzzz") ? "researchNeedsAttestation$yyyyyyyy" : "researchNeedsAttestation$zzzzzzzz";
	}
	const refusal = async (pending: Promise<unknown>) => {
		const error = await pending.then(
			() => null,
			(thrown: unknown) => thrown,
		);
		if (!(error instanceof HttpError)) throw new Error(`expected a refusal, got ${String(error)}`);
		return { status: error.status, message: error.message, extra: error.extra, headers: error.headers };
	};
	const rotationsOf = (repo: string) => workflows.of("RotateWorkflow").filter((instance) => (instance.params as { repo: string }).repo === repo);

	it(
		"refuses an original name and another copy's name with one and the same 403, records each, and neither asks the fork nor writes the ledger",
		async () => {
			const state = await storeCopy("user-trip", 3);
			const decoy = await refusal(ask("user-trip", naming("researchNeedsAttestation")));
			const foreign = await refusal(ask("user-trip", naming(await foreignName("user-trip", 3))));
			expect(decoy).toEqual({ status: 403, message: TRIPWIRE_REFUSAL, extra: {}, headers: {} });
			expect(foreign).toEqual(decoy);
			expect(TRIPWIRE_REFUSAL).toBe("Request refused by a security check.");
			const events = p.t.fleet.securityEvents("user-trip");
			expect(events.map((event) => [event.kind, event.detail?.hit])).toEqual([
				["tripwire", "foreign"],
				["tripwire", "decoy"],
			]);
			expect(events[1]!.detail).toEqual({ hit: "decoy", name: "researchNeedsAttestation", path: "context.display.researchNeedsAttestation", epoch: 3, fingerprint: state.fingerprint });
			expect(await ledgerOf("user-trip")).toEqual([]);
			// The copy's isolate starts on the first call into it: none was made.
			expect(p.loader.built.filter((id) => id.startsWith("user-trip:"))).toEqual([]);
		},
		SLOW_MS,
	);

	it(
		"starts exactly one rotation of the copy, named by its epoch but not its fingerprint, however many requests trip it",
		async () => {
			const state = await storeCopy("user-flood", 2);
			vi.spyOn(Date, "now").mockReturnValue(t0);
			for (let i = 0; i < 5; i++) await refusal(ask("user-flood", naming("researchNeedsAttestation")));
			await refusal(ask("user-flood", naming(await foreignName("user-flood", 2))));
			const id = rotationId("user-flood", copyKey(state, t0));
			expect(id).toContain(`-c${state.epoch}-`);
			expect(id).not.toContain(state.fingerprint);
			expect(rotationsOf("user-flood")).toEqual([{ workflow: "RotateWorkflow", id, params: { repo: "user-flood", reason: "tripwire", runId: `run_${id}` } }]);
			expect(p.t.fleet.securityEvents("user-flood")).toHaveLength(6);
		},
		SLOW_MS,
	);

	it(
		"starts the copy's rotation again ten minutes on when the first one skipped because the fork was busy",
		async () => {
			const state = await storeCopy("user-busy", 3);
			p.t.fleet.update("user-busy", { status: "gating" });
			const now = vi.spyOn(Date, "now").mockReturnValue(t0);
			await refusal(ask("user-busy", naming("researchNeedsAttestation")));
			// The rotation it started finds the fork gating and changes nothing.
			expect(await rotateFork(p.deps, "user-busy", "tripwire")).toMatchObject({ outcome: "skipped", why: "the fork is gating" });
			p.t.fleet.update("user-busy", { status: "pinned" });
			now.mockReturnValue(t0 + 9 * 60_000);
			await refusal(ask("user-busy", naming("researchNeedsAttestation")));
			expect(rotationsOf("user-busy")).toHaveLength(1);
			now.mockReturnValue(t0 + 10 * 60_000);
			await refusal(ask("user-busy", naming("researchNeedsAttestation")));
			expect(rotationsOf("user-busy").map((instance) => instance.id)).toEqual([rotationId("user-busy", copyKey(state, t0)), rotationId("user-busy", copyKey(state, t0 + 10 * 60_000))]);
			expect(rotationId("user-busy", copyKey(state, t0))).not.toBe(rotationId("user-busy", copyKey(state, t0 + 10 * 60_000)));
		},
		SLOW_MS,
	);

	it(
		"refuses a request too deep or too wide to scan with a 400, recording nothing and starting nothing",
		async () => {
			await storeCopy("user-deep", 1);
			let deep: Record<string, unknown> = { leaf: true };
			for (let i = 0; i < 40; i++) deep = { inner: deep };
			const wide = Object.fromEntries(Array.from({ length: 10_001 }, (_, i) => [`k${i}`, i]));
			for (const context of [deep, wide]) {
				expect(await refusal(ask("user-deep", { question: "Is Morphinex on formulary?", context }))).toEqual({ status: 400, message: UNSCANNABLE_REFUSAL, extra: {}, headers: {} });
			}
			expect(UNSCANNABLE_REFUSAL).toBe("Request too large or too deeply nested.");
			expect(p.t.fleet.securityEvents("user-deep")).toEqual([]);
			expect(rotationsOf("user-deep")).toEqual([]);
			expect(await ledgerOf("user-deep")).toEqual([]);
		},
		SLOW_MS,
	);

	it(
		"leaves the original names alone on a fork with no copy, where they are live",
		async () => {
			const served = await ask("user-plain", naming("researchNeedsAttestation"));
			expect(served.mode).toBe("research");
			expect(p.t.fleet.securityEvents("user-plain")).toEqual([]);
		},
		SLOW_MS,
	);

	it(
		"answers POST /api/ask with the same 403 and the refusal's words only",
		async () => {
			await storeCopy("user-route", 1);
			const cookie = await cookieFor({ userId: "route" });
			const response = await worker.fetch(post("/api/ask", { cookie }, { question: requests.research.question, context: naming("researchNeedsAttestation").context }), p.t.env, workflows.ctx);
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: TRIPWIRE_REFUSAL, requestId: expect.any(String) });
			expect(rotationsOf("user-route")).toHaveLength(1);
		},
		SLOW_MS,
	);
});

describe("serveAsk when main's verified copy does not load", () => {
	const rotationsOf = (repo: string) => workflows.of("RotateWorkflow").filter((instance) => (instance.params as { repo: string }).repo === repo);

	it(
		"refuses as retryable when Artifacts fails to read what the copy needs, rather than let the plain fork answer, and serves the copy once it reads again",
		async () => {
			vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const state = await storeCopy("user-flaky", 1);
			const git = p.t.artifacts.repos.get("user-flaky")!.git;
			const read = git.readFile.bind(git);
			let failures = 0;
			vi.spyOn(git, "readFile").mockImplementation(async (args: { ref: string; path: string }) => {
				if (args.path === "tests/user/manifest.json" && failures++ === 0) throw new Error("Artifacts: 503 service unavailable");
				return read(args);
			});
			const error = await ask("user-flaky", requests.administrative).catch((thrown: unknown) => thrown);
			expect(error).toBeInstanceOf(HttpError);
			expect([(error as HttpError).status, (error as HttpError).message, (error as HttpError).headers]).toEqual([503, COPY_RETRY, { "retry-after": "10" }]);
			expect(COPY_RETRY).toBe("The fork's renamed copy could not be loaded; retry shortly.");
			expect(await ledgerOf("user-flaky")).toEqual([]);
			expect(rotationsOf("user-flaky")).toEqual([]);
			expect(p.t.fleet.securityEvents("user-flaky")).toEqual([]);
			expect((await ask("user-flaky", requests.administrative)).fork).toMatchObject({ variant: state.fingerprint });
		},
		SLOW_MS,
	);

	const stale: [string, string, (state: Awaited<ReturnType<typeof storeCopy>>) => Partial<Awaited<ReturnType<typeof storeCopy>>>][] = [
		["the secret makes another fingerprint now", "user-resecret", () => ({ fingerprint: "00000000" })],
		["the copy would rename other names now", "user-renames", () => ({ namesHash: "00000000" })],
		["no copy of the fork's code can be built now", "user-unreadable", () => ({})],
	];

	it.each(stale)(
		"answers plain, with the model off as the copy would, and starts one rotation, when %s",
		async (_case, repo, change) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const verified = await storeCopy(repo, 4);
			const stored = { ...verified, ...change(verified) };
			p.t.fleet.setMorph(repo, stored, { from: 4 }, t0);
			vi.spyOn(Date, "now").mockReturnValue(t0);
			const calls = modelCalls.length;
			for (let i = 0; i < 3; i++) {
				const served = await ask(repo, requests.administrative, { useModel: true });
				expect(served.fork).toEqual({ repo, ref: "main", commit: p.heads[repo] });
				expect(served.signals).not.toContain(MODEL_WORDING);
			}
			expect(modelCalls.length).toBe(calls);
			const id = rotationId(repo, copyKey(stored, t0));
			expect(rotationsOf(repo)).toEqual([{ workflow: "RotateWorkflow", id, params: { repo, reason: "mismatch", runId: `run_${id}` } }]);
			expect((await ledgerOf(repo)).map((record) => "variant" in record)).toEqual([false, false, false]);
			expect(warn).toHaveBeenCalledTimes(1);
		},
		SLOW_MS,
	);
});

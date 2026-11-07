// The live ask path with renamed copies: serveAsk on production main. A fork
// whose main has a verified copy (stored in Fleet as a rotation stores it)
// answers from that copy, with the model off; any other fork answers plain,
// exactly as before. Forks run through the platform's loader on in-memory
// repos and a fake Worker Loader, so the timeouts leave room for a loaded
// machine.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { COPY_RETRY, onCopyFailure, serveAsk, TRIPWIRE_REFUSAL, UNSCANNABLE_REFUSAL, type ServeAskInput, type ServedCard } from "../src/api/ask.ts";
import { HttpError } from "../src/api/http.ts";
import { cardDifferences } from "../src/polymorph/equivalence.ts";
import { deriveSeed, fingerprint, namesHash, variantNames } from "../src/polymorph/names.ts";
import { rotateFork } from "../src/polymorph/rotate.ts";
import { SCAN_LIMITS } from "../src/polymorph/tokens.ts";
import { askLoaded, loadForkRuntime, type RuntimeDeps } from "../src/runtime/loader.ts";
import { ledgerStub } from "../src/stubs.ts";
import { hostCallback } from "../src/yellow/run.ts";
import { copyKey, rotationId, tripKey } from "../src/workflows/common.ts";
import { cookieFor, post } from "./helpers/api-env.ts";
import { BUILD_CARD, LISTED, patched, POLYMORPH_TEST_SECRET, PUBLISHED, TAG, polymorphPlatform, type PolymorphPlatform } from "./helpers/polymorph-platform.ts";
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

// A fork that puts a computed dose on every clinical card, which the platform's backstop never serves.
const DOSING = patched(
	"app/index.ts",
	BUILD_CARD,
	[
		"  const card = await buildCard({ request, env, decision, classification, signals, config, answerId: newAnswerId(env) });",
		'  return card.mode === "clinical" ? { ...card, computed_dose: { value: 5, unit: "mg", basis: "a test fork" } } : card;',
	].join("\n"),
);

/** A fork's main and a work/next branch one commit ahead of it. */
const withNext = (name: string) => [{ ...PUBLISHED, [`app/${name}.ts`]: `export const ${name} = 1;\n` }, { ...PUBLISHED, [`app/${name}.ts`]: `export const ${name} = 2;\n` }];

let p: PolymorphPlatform;
const workflows = fakeWorkflows(MODEL);
let deps: RuntimeDeps;
/** The commit of user-ahead's work/next, one commit ahead of its main. */
let aheadCommit: string;
/** The commit of each fork's work/next, for the forks seeded withNext. */
const nextOf: Record<string, string> = {};

beforeAll(() => {
	p = polymorphPlatform({
		"user-1": PUBLISHED,
		"user-plain": { ...PUBLISHED, "app/plain.ts": "export const plain = 1;\n" },
		"user-model": { ...PUBLISHED, "app/model.ts": "export const model = 1;\n" },
		"user-nosecret": { ...PUBLISHED, "app/nosecret.ts": "export const nosecret = 1;\n" },
		"user-safety": { ...PUBLISHED, "app/safety.ts": "export const safety = 1;\n" },
		"user-trip": { ...PUBLISHED, "app/trip.ts": "export const trip = 1;\n" },
		"user-flood": { ...PUBLISHED, "app/flood.ts": "export const flood = 1;\n" },
		"user-chain": { ...PUBLISHED, "app/chain.ts": "export const chain = 1;\n" },
		"user-echo": { ...PUBLISHED, "app/echo.ts": "export const echo = 1;\n" },
		"user-deep": { ...PUBLISHED, "app/deep.ts": "export const deep = 1;\n" },
		"user-route": { ...PUBLISHED, "app/route.ts": "export const route = 1;\n" },
		"user-busy": { ...PUBLISHED, "app/busy.ts": "export const busy = 1;\n" },
		"user-asbuilt": { ...PUBLISHED, "app/asbuilt.ts": "export const asbuilt = 1;\n" },
		"user-http": { ...PUBLISHED, "app/http.ts": "export const http = 1;\n" },
		"user-other": { ...PUBLISHED, "app/other.ts": "export const other = 1;\n" },
		"user-crowd": { ...PUBLISHED, "app/crowd.ts": "export const crowd = 1;\n" },
		"user-dosing": DOSING,
		"user-reask": { ...PUBLISHED, "app/reask.ts": "export const reask = 1;\n" },
		"user-live-names": { ...PUBLISHED, "app/live.ts": "export const live = 1;\n" },
		"user-http-model": { ...PUBLISHED, "app/httpmodel.ts": "export const httpModel = 1;\n" },
		"user-flag": { ...PUBLISHED, "app/flag.ts": "export const flag = 1;\n" },
		"user-unbound": { ...PUBLISHED, "app/unbound.ts": "export const unbound = 1;\n" },
		// Its stored copy no longer builds, as after a change to the renamer's limits.
		"user-gone": { ...PUBLISHED, "app/big.js": `// ${"x".repeat(SCAN_LIMITS.moduleChars)}\nexport const gone = 1;\n` },
		"user-flaky": { ...PUBLISHED, "app/flaky.ts": "export const flaky = 1;\n" },
		"user-resecret": { ...PUBLISHED, "app/resecret.ts": "export const resecret = 1;\n" },
		"user-renames": { ...PUBLISHED, "app/renames.ts": "export const renames = 1;\n" },
		// More JavaScript in one module than the renamer reads: no copy of it can be built.
		"user-unreadable": { ...PUBLISHED, "app/big.js": `// ${"x".repeat(SCAN_LIMITS.moduleChars)}\nexport const big = 1;\n` },
		// Stale copies whose names must still guard the plain fork.
		"user-stale-print": { ...PUBLISHED, "app/stale.ts": "export const stale = 1;\n" },
		"user-stale-names": { ...PUBLISHED, "app/stale.ts": "export const stale = 2;\n" },
		"user-stale-code": { ...PUBLISHED, "app/big.js": `// ${"x".repeat(SCAN_LIMITS.moduleChars)}\nexport const stale = 3;\n` },
	});
	p.heads["user-moved"] = p.t.artifacts.seed("user-moved", { commits: MOVED }).commits[1]!;
	// A merged work branch still at main's commit, and a branch one commit ahead of main.
	p.heads["user-branchy"] = p.t.artifacts.seed("user-branchy", { commits: [{ ...PUBLISHED, "app/branchy.ts": "export const branchy = 1;\n" }], branches: { main: 0, "work/old-change": 0 } }).commits[0]!;
	const ahead = p.t.artifacts.seed("user-ahead", { commits: [{ ...PUBLISHED, "app/ahead.ts": "export const ahead = 1;\n" }, { ...PUBLISHED, "app/ahead.ts": "export const ahead = 2;\n" }], branches: { main: 0, "work/next": 1 } });
	p.heads["user-ahead"] = ahead.commits[0]!;
	aheadCommit = ahead.commits[1]!;
	p.heads["user-reads"] = p.t.artifacts.seed("user-reads", { commits: withNext("reads"), branches: { main: 0, "work/next": 1 } }).commits[0]!;
	for (const repo of ["user-m1", "user-m2"]) {
		const seeded = p.t.artifacts.seed(repo, { commits: withNext(repo.slice(5)), branches: { main: 0, "work/next": 1 } });
		p.heads[repo] = seeded.commits[0]!;
		nextOf[repo] = seeded.commits[1]!;
	}
	for (const repo of Object.keys(p.heads)) p.t.fleet.register({ repo, userId: repo.slice(5), persona: "p", pinnedTag: TAG, status: "pinned" });
	deps = { env: p.t.env, exports: workflows.exports as never };
});

afterAll(() => p?.cleanup());

afterEach(() => {
	vi.restoreAllMocks();
});

/** Stores a verified copy for a fork the way a rotation does, at main's commit unless told otherwise. */
async function storeCopy(repo: string, epoch: number, sha = p.heads[repo]!) {
	const state = { epoch, sha, fingerprint: await fingerprint(await deriveSeed(POLYMORPH_TEST_SECRET, repo, sha, epoch)), namesHash: await namesHash(LISTED), names: [...LISTED].sort() };
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

/** A research question whose display options set a key: an original listed name, or a renamed one. */
const naming = (key: string) => ({ ...requests.research, context: { ...requests.research.context, display: { [key]: false } } });

/** A renamed researchNeedsAttestation that is not the copy's own (of the fork's main at `epoch`): another copy's name. */
async function foreignName(repo: string, epoch: number, sha = p.heads[repo]!): Promise<string> {
	const own = (await variantNames(await deriveSeed(POLYMORPH_TEST_SECRET, repo, sha, epoch), LISTED)).get("researchNeedsAttestation")!;
	return own.endsWith("$zzzzzzzz") ? "researchNeedsAttestation$yyyyyyyy" : "researchNeedsAttestation$zzzzzzzz";
}

/** The refusal a pending ask ends in, failing the test when it answered or failed otherwise. */
async function refusal(pending: Promise<unknown>) {
	const error = await pending.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	if (!(error instanceof HttpError)) throw new Error(`expected a refusal, got ${String(error)}`);
	return { status: error.status, message: error.message, extra: error.extra, headers: error.headers };
}

const rotationsOf = (repo: string) => workflows.of("RotateWorkflow").filter((instance) => (instance.params as { repo: string }).repo === repo);

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
			const state = await storeCopy("user-reask", 1);
			const first = await ask("user-reask", requests.research);
			const again = await ask("user-reask", { ...requests.research, attestation: true }, { reaskOf: first.answer_id });
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
		"answers plain, honoring useModel, when main moved past the stored copy, once the request passes the stored copy's wires",
		async () => {
			const old = p.t.artifacts.repos.get("user-moved")!.git.commits[0]!;
			await storeCopy("user-moved", 1, old);
			const warn = vi.spyOn(console, "warn");
			const served = await ask("user-moved", requests.administrative, { useModel: true });
			expect(served.fork).toEqual({ repo: "user-moved", ref: "main", commit: p.heads["user-moved"] });
			expect(served.signals).toContain(MODEL_WORDING);
			expect(warn).not.toHaveBeenCalled();
			// Until the landed rotation stores a copy of the new main, the old copy's wires still guard it.
			expect((await refusal(ask("user-moved", naming("researchNeedsAttestation")))).status).toBe(403);
			// The old copy's names were only built, never started.
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
		"reads Fleet on a platform without a secret only as before: the safety fallback, and only for an ask that applies it",
		async () => {
			const noSecret = { ...deps, env: p.withoutSecret().env };
			const askState = vi.spyOn(p.t.fleet, "askState");
			const safetyFallback = vi.spyOn(p.t.fleet, "safetyFallback");
			const input = { repo: "user-nosecret", ref: "main", request: requests.administrative, useModel: false, userId: "nosecret" };
			await serveAsk(noSecret, { ...input, fallback: false });
			expect([askState.mock.calls.length, safetyFallback.mock.calls.length]).toEqual([0, 0]);
			await serveAsk(noSecret, { ...input, fallback: true });
			expect([askState.mock.calls.length, safetyFallback.mock.calls.length]).toEqual([0, 1]);
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
		"starts exactly one rotation of the fork, named by its window and never by its copy, however many requests trip it",
		async () => {
			const state = await storeCopy("user-flood", 2);
			vi.spyOn(Date, "now").mockReturnValue(t0);
			for (let i = 0; i < 5; i++) await refusal(ask("user-flood", naming("researchNeedsAttestation")));
			await refusal(ask("user-flood", naming(await foreignName("user-flood", 2))));
			const id = rotationId("user-flood", tripKey(t0));
			expect(id).not.toContain(`-c${state.epoch}-`);
			expect(id).not.toContain(state.fingerprint);
			expect(rotationsOf("user-flood")).toEqual([{ workflow: "RotateWorkflow", id, params: { repo: "user-flood", reason: "tripwire", runId: `run_${id}` } }]);
			expect(p.t.fleet.securityEvents("user-flood")).toHaveLength(6);
		},
		SLOW_MS,
	);

	it(
		"starts one tripwire rotation per fork in each window, even after that rotation stores a new copy for the next hit to trip",
		async () => {
			await storeCopy("user-chain", 2);
			const now = vi.spyOn(Date, "now").mockReturnValue(t0);
			await refusal(ask("user-chain", naming("researchNeedsAttestation")));
			// The rotation it started stores the next copy, and the hits go on.
			await storeCopy("user-chain", 3);
			now.mockReturnValue(t0 + 9 * 60_000);
			for (let i = 0; i < 3; i++) await refusal(ask("user-chain", naming("researchNeedsAttestation")));
			expect(rotationsOf("user-chain").map((instance) => instance.id)).toEqual([rotationId("user-chain", tripKey(t0))]);
			now.mockReturnValue(t0 + 10 * 60_000);
			await refusal(ask("user-chain", naming("researchNeedsAttestation")));
			expect(rotationsOf("user-chain").map((instance) => instance.id)).toEqual([rotationId("user-chain", tripKey(t0)), rotationId("user-chain", tripKey(t0 + 10 * 60_000))]);
			expect(p.t.fleet.securityEvents("user-chain")).toHaveLength(5);
		},
		SLOW_MS,
	);

	it(
		"starts the fork's rotation again ten minutes on when the first one skipped because the fork was busy",
		async () => {
			await storeCopy("user-busy", 3);
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
			expect(rotationsOf("user-busy").map((instance) => instance.id)).toEqual([rotationId("user-busy", tripKey(t0)), rotationId("user-busy", tripKey(t0 + 10 * 60_000))]);
			expect(rotationId("user-busy", tripKey(t0))).not.toBe(rotationId("user-busy", tripKey(t0 + 10 * 60_000)));
		},
		SLOW_MS,
	);

	it(
		"refuses a renamed name sent in a value, the copy's own as well as a guess, so no answer can show which guess was right",
		async () => {
			const state = await storeCopy("user-echo", 1);
			const own = (await variantNames(await deriveSeed(POLYMORPH_TEST_SECRET, "user-echo", state.sha, 1), LISTED)).get("researchNeedsAttestation")!;
			const asking = (name: string) => ({ ...requests.research, question: `${requests.research.question} (${name})` });
			const refusals = [await refusal(ask("user-echo", asking(own))), await refusal(ask("user-echo", asking(await foreignName("user-echo", 1))))];
			expect(refusals).toEqual([0, 1].map(() => ({ status: 403, message: TRIPWIRE_REFUSAL, extra: {}, headers: {} })));
			expect(p.t.fleet.securityEvents("user-echo").map((event) => [event.detail?.hit, event.detail?.path])).toEqual([
				["foreign", "question"],
				["foreign", "question"],
			]);
			expect(await ledgerOf("user-echo")).toEqual([]);
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
			const served = await ask("user-live-names", naming("researchNeedsAttestation"));
			expect(served.mode).toBe("research");
			expect(p.t.fleet.securityEvents("user-live-names")).toEqual([]);
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

	const staleGuards: typeof stale = [
		["the secret makes another fingerprint now", "user-stale-print", () => ({ fingerprint: "00000000" })],
		["the copy would rename other names now", "user-stale-names", () => ({ namesHash: "00000000" })],
		["no copy of the fork's code can be built now", "user-stale-code", () => ({})],
	];

	it.each(staleGuards)(
		"still refuses a request with the stored copy's names, original or suffixed, before the plain fork sees it, when %s",
		async (_case, repo, change) => {
			vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const verified = await storeCopy(repo, 4);
			p.t.fleet.setMorph(repo, { ...verified, ...change(verified) }, { from: 4 }, t0);
			vi.spyOn(Date, "now").mockReturnValue(t0);
			// The plain fork answers, so the stored copy's own renamed name is as foreign as any other suffix.
			const own = (await variantNames(await deriveSeed(POLYMORPH_TEST_SECRET, repo, verified.sha, 4), LISTED)).get("researchNeedsAttestation")!;
			for (const key of ["researchNeedsAttestation", own, await foreignName(repo, 4)]) {
				expect(await refusal(ask(repo, naming(key)))).toEqual({ status: 403, message: TRIPWIRE_REFUSAL, extra: {}, headers: {} });
			}
			expect(p.t.fleet.securityEvents(repo).map((event) => [event.kind, event.detail?.hit, event.detail?.epoch])).toEqual([
				["tripwire", "foreign", 4],
				["tripwire", "foreign", 4],
				["tripwire", "decoy", 4],
			]);
			expect(await ledgerOf(repo)).toEqual([]);
			expect(rotationsOf(repo).map((instance) => (instance.params as { reason: string }).reason)).toEqual(["mismatch", "tripwire"]);
			// A request that names none of them still gets the plain fork's answer.
			expect((await ask(repo, requests.administrative)).fork).toEqual({ repo, ref: "main", commit: p.heads[repo] });
		},
		SLOW_MS,
	);
});

describe("serveAsk on another ref of a fork with a copy", () => {
	it(
		"guards a branch at the copy's commit as it guards main: the same 403 for an original name, and the copy's answer otherwise",
		async () => {
			const state = await storeCopy("user-branchy", 1);
			const cookie = await cookieFor({ userId: "branchy" });
			const askRoute = (body: Record<string, unknown>) => worker.fetch(post("/api/ask", { cookie }, { question: requests.research.question, ...body }), p.t.env, workflows.ctx);
			const onMain = await askRoute({ context: naming("researchNeedsAttestation").context });
			const onBranch = await askRoute({ context: naming("researchNeedsAttestation").context, ref: "work/old-change" });
			expect([onMain.status, onBranch.status]).toEqual([403, 403]);
			expect(await onBranch.json()).toEqual({ error: TRIPWIRE_REFUSAL, requestId: expect.any(String) });
			const clean = await askRoute({ context: requests.research.context, ref: "work/old-change", useModel: true });
			expect(clean.status).toBe(200);
			const served = (await clean.json()) as ServedCard;
			expect(served.fork).toEqual({ repo: "user-branchy", ref: "work/old-change", commit: p.heads["user-branchy"], variant: state.fingerprint });
			expect(served.signals).not.toContain(MODEL_WORDING);
		},
		SLOW_MS,
	);

	it(
		"answers another commit plain, model and all, but only for a request the stored copy's wires let through",
		async () => {
			await storeCopy("user-ahead", 2);
			const onNext = (request: Record<string, unknown>, useModel = false) => serveAsk(deps, { repo: "user-ahead", ref: "work/next", request, useModel, userId: "ahead", fallback: false });
			vi.spyOn(Date, "now").mockReturnValue(t0);
			const decoy = await refusal(onNext(naming("researchNeedsAttestation")));
			const foreign = await refusal(onNext(naming(await foreignName("user-ahead", 2))));
			expect(decoy).toEqual({ status: 403, message: TRIPWIRE_REFUSAL, extra: {}, headers: {} });
			expect(foreign).toEqual(decoy);
			let deep: Record<string, unknown> = { leaf: true };
			for (let i = 0; i < 40; i++) deep = { inner: deep };
			expect((await refusal(onNext({ question: "Is Morphinex on formulary?", context: deep }))).status).toBe(400);
			expect(p.t.fleet.securityEvents("user-ahead").map((event) => [event.detail?.hit, event.detail?.epoch])).toEqual([
				["foreign", 2],
				["decoy", 2],
			]);
			const id = rotationId("user-ahead", tripKey(t0));
			expect(rotationsOf("user-ahead")).toEqual([{ workflow: "RotateWorkflow", id, params: { repo: "user-ahead", reason: "tripwire", runId: `run_${id}` } }]);
			const served = await onNext(requests.administrative, true);
			expect(served.fork).toEqual({ repo: "user-ahead", ref: "work/next", commit: aheadCommit });
			expect(served.signals).toContain(MODEL_WORDING);
			expect((await ledgerOf("user-ahead")).map((record) => "variant" in record)).toEqual([false]);
		},
		SLOW_MS,
	);

	it(
		"leaves the yellow soak's host asking the commit as built, even where Fleet holds a copy of it",
		async () => {
			await storeCopy("user-asbuilt", 1);
			const host = hostCallback(deps, { repo: "user-asbuilt", commit: p.heads["user-asbuilt"]!, testUser: "soak-asbuilt" });
			const card = (await host("ask", { request: naming("researchNeedsAttestation") })) as ServedCard;
			expect(card.mode).toBe("research");
			expect(card.fork).toEqual({ repo: "user-asbuilt", ref: p.heads["user-asbuilt"], commit: p.heads["user-asbuilt"] });
			expect(p.t.fleet.securityEvents("user-asbuilt")).toEqual([]);
			expect(rotationsOf("user-asbuilt")).toEqual([]);
		},
		SLOW_MS,
	);
});

describe("the live path's reads", () => {
	it(
		"resolves the ref once for an ask on a fork with a copy, at the copy's commit and at another",
		async () => {
			await storeCopy("user-reads", 1);
			const log = vi.spyOn(p.t.artifacts.repos.get("user-reads")!.git, "log");
			await ask("user-reads", requests.administrative);
			expect(log).toHaveBeenCalledTimes(1);
			log.mockClear();
			await serveAsk(deps, { repo: "user-reads", ref: "work/next", request: requests.administrative, useModel: false, userId: "reads", fallback: false });
			expect(log).toHaveBeenCalledTimes(1);
		},
		SLOW_MS,
	);
});

describe("the live path at the HTTP layer", () => {
	/** A response as a client sees it, without its request id, which differs per request. */
	async function seen(response: Response) {
		const { requestId, ...body } = (await response.json()) as Record<string, unknown>;
		return { status: response.status, headers: [...response.headers.entries()].filter(([name]) => name !== "x-request-id").sort(), body, requestId: typeof requestId };
	}

	it(
		"answers an original name, a made-up renamed name, and another fork's real renamed name with the same status, headers, and body",
		async () => {
			const own = await storeCopy("user-http", 5);
			const other = await storeCopy("user-other", 2);
			const othersName = (await variantNames(await deriveSeed(POLYMORPH_TEST_SECRET, "user-other", other.sha, 2), LISTED)).get("researchNeedsAttestation")!;
			const cookie = await cookieFor({ userId: "http" });
			const responses = [];
			for (const key of ["researchNeedsAttestation", await foreignName("user-http", 5), othersName]) {
				responses.push(await seen(await worker.fetch(post("/api/ask", { cookie }, { question: requests.research.question, context: naming(key).context, useModel: true }), p.t.env, workflows.ctx)));
			}
			expect(responses[0]).toEqual({ status: 403, headers: expect.any(Array), body: { error: TRIPWIRE_REFUSAL }, requestId: "string" });
			expect(responses[1]).toEqual(responses[0]);
			expect(responses[2]).toEqual(responses[0]);
			expect(JSON.stringify(responses)).not.toContain(own.fingerprint);
			expect(await ledgerOf("user-http")).toEqual([]);
		},
		SLOW_MS,
	);

	it(
		"starts one rotation for a copy that 40 requests trip at once",
		async () => {
			await storeCopy("user-crowd", 7);
			vi.spyOn(Date, "now").mockReturnValue(t0);
			const foreign = await foreignName("user-crowd", 7);
			const settled = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => ask("user-crowd", naming(i % 2 ? foreign : "researchNeedsAttestation"), { useModel: i % 3 === 0 })));
			expect(new Set(settled.map((outcome) => (outcome.status === "rejected" && outcome.reason instanceof HttpError ? outcome.reason.status : outcome.status)))).toEqual(new Set([403]));
			const id = rotationId("user-crowd", tripKey(t0));
			expect(rotationsOf("user-crowd")).toEqual([{ workflow: "RotateWorkflow", id, params: { repo: "user-crowd", reason: "tripwire", runId: `run_${id}` } }]);
			expect(p.t.fleet.securityEvents("user-crowd")).toHaveLength(40);
		},
		SLOW_MS,
	);

	it(
		"answers from the copy with the model off when the request body asks for the model",
		async () => {
			const state = await storeCopy("user-http-model", 1);
			const calls = modelCalls.length;
			const response = await worker.fetch(post("/api/ask", { cookie: await cookieFor({ userId: "http-model" }) }, { ...requests.administrative, useModel: true }), p.t.env, workflows.ctx);
			expect(response.status).toBe(200);
			const served = (await response.json()) as ServedCard;
			expect(served.fork).toMatchObject({ variant: state.fingerprint });
			expect(served.signals).not.toContain(MODEL_WORDING);
			expect(modelCalls.length).toBe(calls);
			expect(p.loader.built.filter((id) => id.startsWith("user-http-model:") && id.endsWith(":llm"))).toEqual([]);
		},
		SLOW_MS,
	);
});

describe("onCopyFailure", () => {
	it.each([
		["transient", "retry"],
		["mismatch", "rotate"],
		["unavailable", "rotate"],
		["none", "plain"],
	] as const)("answers a stored copy that did not load for a %s reason with %s", (kind, action) => {
		expect(onCopyFailure(kind)).toBe(action);
	});
});

describe("serveAsk when the stored copy does not load, asked at another commit", () => {
	it(
		"refuses as retryable when Artifacts fails to read what the copy needs, and lets the plain fork answer once it reads again",
		async () => {
			vi.spyOn(console, "warn").mockImplementation(() => undefined);
			await storeCopy("user-m1", 1);
			const git = p.t.artifacts.repos.get("user-m1")!.git;
			const read = git.readFile.bind(git);
			let failures = 0;
			vi.spyOn(git, "readFile").mockImplementation(async (args: { ref: string; path: string }) => {
				if (args.path === "tests/user/manifest.json" && failures++ === 0) throw new Error("Artifacts: 503 service unavailable");
				return read(args);
			});
			const onNext = () => serveAsk(deps, { repo: "user-m1", ref: "work/next", request: requests.administrative, useModel: false, userId: "m1", fallback: false });
			expect(await refusal(onNext())).toEqual({ status: 503, message: COPY_RETRY, extra: {}, headers: { "retry-after": "10" } });
			expect(rotationsOf("user-m1")).toEqual([]);
			expect(await ledgerOf("user-m1")).toEqual([]);
			expect((await onNext()).fork).toEqual({ repo: "user-m1", ref: "work/next", commit: nextOf["user-m1"] });
		},
		SLOW_MS,
	);

	it(
		"lets the plain fork answer, model and all, and starts one rotation, when the stored copy is stale",
		async () => {
			vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const stale = { ...(await storeCopy("user-m2", 1)), fingerprint: "00000000" };
			p.t.fleet.setMorph("user-m2", stale, { from: 1 }, t0);
			vi.spyOn(Date, "now").mockReturnValue(t0);
			const served = await serveAsk(deps, { repo: "user-m2", ref: "work/next", request: requests.administrative, useModel: true, userId: "m2", fallback: false });
			expect(served.fork).toEqual({ repo: "user-m2", ref: "work/next", commit: nextOf["user-m2"] });
			expect(served.signals).toContain(MODEL_WORDING);
			const id = rotationId("user-m2", copyKey(stale, t0));
			expect(rotationsOf("user-m2")).toEqual([{ workflow: "RotateWorkflow", id, params: { repo: "user-m2", reason: "mismatch", runId: `run_${id}` } }]);
			// The stale copy's names still guard the other commit.
			const named = serveAsk(deps, { repo: "user-m2", ref: "work/next", request: naming("researchNeedsAttestation"), useModel: false, userId: "m2", fallback: false });
			expect((await refusal(named)).status).toBe(403);
		},
		SLOW_MS,
	);
});

describe("serveAsk's clinical dose backstop with a copy", () => {
	it(
		"serves stock's answer, which names no copy, when the copy's card computes a clinical dose",
		async () => {
			vi.spyOn(console, "error").mockImplementation(() => undefined);
			await storeCopy("user-dosing", 1);
			const served = await ask("user-dosing", requests.clinical);
			expect(served.fork).toMatchObject({ repo: "user-dosing", servedBy: { repo: "stock", ref: TAG } });
			expect(served.fork).not.toHaveProperty("variant");
			expect(served.computed_dose).toBeNull();
			expect((await ledgerOf("user-dosing")).map((record) => "variant" in record)).toEqual([false]);
		},
		SLOW_MS,
	);
});

describe("serveAsk's guard", () => {
	it(
		"has no input that switches it off: an asBuilt field, as the soak's own entry point once took, changes nothing",
		async () => {
			await storeCopy("user-flag", 1);
			const flagged = { repo: "user-flag", ref: "main", request: naming("researchNeedsAttestation"), useModel: false, userId: "flag", fallback: true, asBuilt: true } as ServeAskInput;
			expect((await refusal(serveAsk(deps, flagged))).status).toBe(403);
		},
		SLOW_MS,
	);

	it(
		"fails loudly, rather than refuse quietly with nothing rotating, when the rotate workflow binding is missing",
		async () => {
			await storeCopy("user-unbound", 1);
			const unbound = { env: p.t.env, exports: { LlmHost: MODEL.LlmHost } } as never;
			const failure = await serveAsk(unbound, { repo: "user-unbound", ref: "main", request: naming("researchNeedsAttestation"), useModel: false, userId: "unbound", fallback: true }).catch((error: unknown) => error);
			expect(failure).not.toBeInstanceOf(HttpError);
			expect((failure as Error).message).toMatch(/no RotateWorkflow binding/);
		},
		SLOW_MS,
	);
});

describe("a stored copy that no longer builds", () => {
	it(
		"is cleared by the one rotation it starts, and the fork then answers as one with no copy: plain, model and all, starting nothing",
		async () => {
			vi.spyOn(console, "warn").mockImplementation(() => undefined);
			await storeCopy("user-gone", 1);
			const now = vi.spyOn(Date, "now").mockReturnValue(t0);
			const first = await ask("user-gone", requests.administrative, { useModel: true });
			expect(first.signals).not.toContain(MODEL_WORDING);
			const [rotation] = rotationsOf("user-gone");
			expect(rotation?.params).toMatchObject({ reason: "mismatch" });
			expect(await rotateFork(p.deps, "user-gone", "mismatch")).toMatchObject({ outcome: "skipped", cleared: true });
			now.mockReturnValue(t0 + 60 * 60_000);
			const after = await ask("user-gone", requests.administrative, { useModel: true });
			expect(after.signals).toContain(MODEL_WORDING);
			expect(after.fork).toEqual({ repo: "user-gone", ref: "main", commit: p.heads["user-gone"] });
			expect((await ask("user-gone", naming("researchNeedsAttestation"))).mode).toBe("research");
			expect(rotationsOf("user-gone")).toHaveLength(1);
		},
		SLOW_MS,
	);
});

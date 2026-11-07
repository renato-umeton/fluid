// The polymorphic installation experiment (issue #1, "The proof of concept" in
// docs/plans/2026-11-06-polymorphic-installation-design.md): a fleet of forks
// on a stock release with two planted bugs (fixtures/zero-day.ts), each
// installed as its own renamed copy, then attacked through the platform's own
// code (rotateFork, runGate, loadForkRuntime, askLoaded, serveAsk) on
// in-memory repos and a fake Worker Loader. Every attack starts from the
// installed copies and is measured four ways: on the plain fleet (askLoaded
// alone), checked request by request against the platform with polymorphic
// installation off (serveAsk with no secret); on the renamed copies with
// nothing scanning the request (askLoaded alone, as if the platform's scan
// were bypassed); and through the platform (serveAsk), which refuses a request
// that trips a copy's wires and starts one rotation of that copy. Each
// rotation started then runs, as the rotate workflow would.
//
// POLYMORPH_FLEET sets the number of forks (default 4, at least 4).
// POLYMORPH_DEMO=1 prints the scoreboard, and POLYMORPH_DEMO_RECORD=<path>
// writes the recording the Polymorph view replays, checked with the view's own
// validateDemo (package.json: polymorph:demo, polymorph:record). The platform
// secret and the seed of the blind guesses are fixed, so every run makes the
// same copies and sends the same requests; POLYMORPH_TEST_SECRET and
// POLYMORPH_GUESS_SEED replace them.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { serveAsk, TRIPWIRE_REFUSAL, type AskDeps } from "../src/api/ask.ts";
import { HttpError } from "../src/api/http.ts";
import type { MorphState } from "../src/durable/fleet.ts";
import { runGate } from "../src/gate/run.ts";
import { forkRepoName, userIdFromForkRepo } from "../src/lib/names.ts";
import { POLYMORPH_LIST_PATH, parsePolymorphList } from "../src/polymorph/list.ts";
import { rotateFork, type RotationResult } from "../src/polymorph/rotate.ts";
import { askLoaded, clearRuntimeCache, loadForkRuntime, storedCopy, type AnswerCardLike, type LoadedFork } from "../src/runtime/loader.ts";
import { ledgerStub } from "../src/stubs.ts";
import type { RotateParams } from "../src/workflows/common.ts";
// @ts-expect-error plain ES module from the static UI
import { afterRotationLine, equivalenceLine, validateDemo } from "../public/js/polymorph-replay.js";
import { zeroDayRelease } from "./fixtures/zero-day.ts";
import { POLYMORPH_TEST_SECRET, PUBLISHED, TAG, polymorphPlatform, type PolymorphPlatform } from "./helpers/polymorph-platform.ts";
import { fakeWorkflows } from "./helpers/workflows.ts";

const FLEET = Number(process.env.POLYMORPH_FLEET ?? 4);
if (!Number.isInteger(FLEET) || FLEET < 4) {
	throw new Error(`POLYMORPH_FLEET must be a whole number of at least 4 (attack A2 leaks the 4th fork's copy), got ${JSON.stringify(process.env.POLYMORPH_FLEET)}`);
}
const DEMO = process.env.POLYMORPH_DEMO === "1";
const RECORD_PATH = process.env.POLYMORPH_DEMO_RECORD;
/** A run takes under a second per fork on a quiet machine (about 15 seconds for 20 forks); this leaves room for a loaded one. */
const EXPERIMENT_MS = FLEET * 30_000;
/** The platform secret that seeds every copy. */
const SECRET = process.env.POLYMORPH_TEST_SECRET ?? POLYMORPH_TEST_SECRET;
if (SECRET.length < 16) throw new Error("POLYMORPH_TEST_SECRET must have at least 16 characters: the platform treats a shorter secret as none");
const GUESSES = 1000;
/** Seeds the blind guesses. */
const GUESS_SEED = Number(process.env.POLYMORPH_GUESS_SEED ?? 20_261_106);
if (!Number.isSafeInteger(GUESS_SEED)) throw new Error(`POLYMORPH_GUESS_SEED must be a whole number, got ${JSON.stringify(process.env.POLYMORPH_GUESS_SEED)}`);
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

const [MAJOR, MINOR] = TAG.slice(1).split(".").map(Number);
/** The fixture release: the next minor release after the stock release the platform bundles. */
const ZERO_DAY_TAG = `v${MAJOR}.${MINOR! + 1}.0`;
const RELEASE = zeroDayRelease(PUBLISHED, ZERO_DAY_TAG);
/** How the recording and the scoreboard name the fixture release, so nobody takes it for a stock release. */
const RELEASE_LABEL = `${ZERO_DAY_TAG}, a test fixture with two planted bugs`;
/** Upstream's list at the fixture release. */
const LIST = parsePolymorphList(RELEASE[POLYMORPH_LIST_PATH]!);
/** The internal flag that bug A lets a request set, by its name in upstream's source. */
const FLAG = "researchNeedsAttestation";
/** user-01, user-02, ...: a fork's repo is named after its user (src/lib/names.ts). */
const REPOS = Array.from({ length: FLEET }, (_, i) => forkRepoName(String(i + 1).padStart(Math.max(2, String(FLEET).length), "0")));

/**
 * A research dosing question with an identified patient's chart open and no
 * attestation: stock holds the answer (invariant
 * inv-attestation-required-with-identified-patient) and, with attestation,
 * computes the dose (inv-attestation-recorded), so a skipped hold shows as a
 * computed dose.
 */
const HELD = frozen({
	question: "What is the right dose of Morphinex for a patient of 70 kg and 45 years?",
	context: { chartOpen: { patientId: "synthetic_patient_117", identified: true } },
	explicitMode: "research",
});
/** HELD with display options, which the planted code reads from context.display. */
const withDisplay = (display: Record<string, unknown>) => ({ ...HELD, context: { ...HELD.context, display } });

type AttackId = "A" | "A2" | "A3" | "B";

/** One fork of the fleet: its installed copy, what its equivalence check counted, and its copy after one rotation. */
interface Fork {
	repo: string;
	installed: Omit<MorphState, "at">;
	/** Probe requests sent to both the plain fork and the copy, and how many the two answered differently. */
	compared: number;
	mismatches: number;
	/** Listed names the copy left as they are. */
	skipped: number;
	after: { epoch: number; fingerprint: string } | null;
}

/** A research answer held for attestation, or released with a computed dose: the exploit worked. */
type ResearchAnswer = "held" | "released";

/**
 * What one request did: on the plain fork asked directly, through the
 * platform with polymorphic installation off, on the fork's copy asked
 * directly with nothing scanning the request, and through the platform.
 */
interface Outcome {
	repo: string;
	plain: ResearchAnswer;
	off: ResearchAnswer;
	direct: ResearchAnswer;
	platform: ResearchAnswer | "refused";
	/** For a refused request, the wire it tripped as Fleet recorded it: an original name (decoy) or another copy's (foreign). */
	hit: string | null;
}

interface Send {
	repo: string;
	request: Record<string, unknown>;
}

interface Attack {
	id: AttackId;
	/** Plain words; the view puts the id in front. */
	label: string;
	/** One plain sentence. */
	detail: string;
	sends: Send[];
}

/** One attack as the Polymorph view's recording holds it (public/js/polymorph-replay.js, validateDemo). */
interface RecordedAttack {
	id: AttackId;
	label: string;
	detail: string;
	tries: number;
	targets: string[];
	plain: { compromised: string[] };
	direct: { compromised: string[] };
	platform: { compromised: string[]; refused: string[]; rotated: string[] };
}

interface AttackRun {
	outcomes: Outcome[];
	recorded: RecordedAttack;
}

/** The leaked copy's names replayed on its own fork after the fork moved to its next copy. */
interface AfterRotation {
	attack: "A2";
	compromised: string[];
	refused: string[];
}

let platform: PolymorphPlatform;

beforeAll(() => {
	platform = polymorphPlatform(Object.fromEntries(REPOS.map((repo) => [repo, RELEASE])));
	Object.assign(platform.t.env, { POLYMORPH_SECRET: SECRET });
	// Upstream publishes the fixture release after the one the platform bundles, and every fork is a fresh fork of it.
	platform.t.artifacts.seed("stock", { commits: [PUBLISHED, RELEASE], tags: { [TAG]: 0, [ZERO_DAY_TAG]: 1 } });
	for (const repo of REPOS) platform.t.fleet.register({ repo, userId: userIdFromForkRepo(repo)!, persona: "p", pinnedTag: ZERO_DAY_TAG, status: "pinned" });
});

afterAll(() => platform?.cleanup());

/** Freezes a value and every object in it, so no code path can change a request that a later path or request receives. */
function frozen<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const inner of Object.values(value)) frozen(inner);
	}
	return value;
}

/**
 * What the research answer (the card, or its research alternative) did:
 * held for attestation with no dose, or released with a computed dose.
 * Throws for anything else, such as no research answer or a dose withheld
 * for another reason: a missing dose would then say nothing about the hold.
 */
function researchAnswer(card: AnswerCardLike, where: string): ResearchAnswer {
	const research = card.mode === "research" ? card : ((card.alternatives ?? []) as AnswerCardLike[]).find((alternative) => alternative.mode === "research");
	const dose = research?.computed_dose ?? null;
	const held = research?.requires_attestation === true;
	if (research !== undefined && held && dose === null) return "held";
	if (research !== undefined && !held && dose !== null) return "released";
	throw new Error(`${where}: the research answer is neither held nor released: ${JSON.stringify({ mode: card.mode, research: research?.mode ?? null, computed_dose: dose, requires_attestation: research?.requires_attestation ?? null })}`);
}

/** Own properties, names and symbols, as their descriptors, by object: "globalThis", a global's name, or "<name>.prototype". */
type BuiltIns = Record<string, Map<PropertyKey, PropertyDescriptor>>;

const ownProperties = (target: object) => new Map(Reflect.ownKeys(target).map((key) => [key, Object.getOwnPropertyDescriptor(target, key)!]));
const isObject = (value: unknown): value is object => (typeof value === "object" || typeof value === "function") && value !== null;

/**
 * The own properties of the global object; of each object or function a
 * global data property holds (Object, JSON, Math, String, ...); and of that
 * value's prototype property (Object.prototype, Array.prototype,
 * String.prototype, ...). Every fake isolate shares them with the platform
 * and the test (helpers/fake-loader.ts), so an attack that added, removed, or
 * replaced one could have reached forks it never asked, and the counts would
 * not hold. Accessor globals (process, crypto, ...) are compared as their
 * getters and setters and never read, so taking a snapshot changes nothing.
 */
function builtInsSnapshot(): BuiltIns {
	const snapshot: BuiltIns = { globalThis: ownProperties(globalThis) };
	for (const [key, descriptor] of snapshot.globalThis!) {
		if (!("value" in descriptor) || !isObject(descriptor.value)) continue;
		snapshot[String(key)] = ownProperties(descriptor.value);
		const prototype = Object.getOwnPropertyDescriptor(descriptor.value, "prototype");
		if (prototype !== undefined && "value" in prototype && isObject(prototype.value)) snapshot[`${String(key)}.prototype`] = ownProperties(prototype.value);
	}
	return snapshot;
}

const DESCRIPTOR_FIELDS = ["value", "get", "set", "writable", "enumerable", "configurable"] as const;

/**
 * The own properties added, removed, or changed since `before`, on the
 * objects `before` holds: a value, getter, or setter that is another object
 * (compared by identity, so a look-alike replacement counts), or other
 * attributes.
 */
function builtInsChangedSince(before: BuiltIns): string[] {
	const after = builtInsSnapshot();
	const changes: string[] = [];
	for (const [builtIn, properties] of Object.entries(before)) {
		const now = after[builtIn] ?? new Map<PropertyKey, PropertyDescriptor>();
		for (const key of new Set([...properties.keys(), ...now.keys()])) {
			const was = properties.get(key);
			const is = now.get(key);
			if (was === undefined || is === undefined || DESCRIPTOR_FIELDS.some((field) => !Object.is(was[field], is[field]))) changes.push(`${builtIn}[${String(key)}]`);
		}
	}
	return changes;
}

/** The fork's stored copy, loaded as the live path loads it. */
async function loadCopy(repo: string): Promise<LoadedFork> {
	const state = platform.t.fleet.morphState(repo);
	if (state === null) throw new Error(`${repo} has no stored copy`);
	const loaded = await loadForkRuntime(platform.deps, repo, "main", { morph: storedCopy(state) });
	if (loaded.morph?.fingerprint !== state.fingerprint) throw new Error(`${repo}: the stored copy ${state.fingerprint} did not load: ${loaded.plain?.reason}`);
	return loaded;
}

/** The names of the copy a fork was installed with, original to renamed: what a disclosure of that copy would reveal. */
async function installedNames(fork: Fork): Promise<ReadonlyMap<string, string>> {
	const loaded = await loadForkRuntime(platform.deps, fork.repo, "main", { morph: storedCopy(fork.installed) });
	if (loaded.morph?.fingerprint !== fork.installed.fingerprint) throw new Error(`${fork.repo}: the installed copy did not load: ${loaded.plain?.reason}`);
	return loaded.morph.names;
}

/** The most rows UserLedger.list returns: a count that reaches it only says "at least this many". */
const LEDGER_LIST_MAX = 1000;

/** The rows in the ledger of a fork's user. Throws rather than give a count that list cut short. */
async function ledgerRows(repo: string): Promise<number> {
	const rows = (await ledgerStub(platform.t.env, userIdFromForkRepo(repo)!).list(LEDGER_LIST_MAX)).length;
	if (rows >= LEDGER_LIST_MAX) throw new Error(`${repo}: the ledger holds at least ${LEDGER_LIST_MAX} rows, as many as UserLedger.list returns, so the rows written by these requests cannot be counted`);
	return rows;
}

/** The wire a refused request tripped, from Fleet's newest security event for the fork when that event names a display option the request sent; otherwise null. */
function trippedWire(repo: string, request: Record<string, unknown>): string | null {
	const event = platform.t.fleet.securityEvents(repo, 1)[0];
	const display = (request.context as { display?: Record<string, unknown> }).display ?? {};
	const sent = Object.keys(display).map((key) => `context.display.${key}`);
	return event?.kind === "tripwire" && sent.includes(String(event.detail?.path)) ? String(event.detail?.hit) : null;
}

const forkOf = (forks: Fork[], repo: string) => forks.find((fork) => fork.repo === repo)!;
const reposWhere = (outcomes: Outcome[], test: (outcome: Outcome) => boolean) => [...new Set(outcomes.filter(test).map((outcome) => outcome.repo))];

/** Rotates every fork once, as installing a new fork does, and counts what each copy's equivalence check compared. */
async function install(): Promise<Fork[]> {
	const forks: Fork[] = [];
	for (const repo of REPOS) {
		const installed = await rotateFork(platform.deps, repo, "install");
		if (installed.outcome !== "rotated") throw new Error(`${repo} was not installed as a renamed copy: ${JSON.stringify(installed)}`);
		// rotateFork names the copy its gate verified but not the gate's counts: a check mode gate of the same epoch checks that copy again, and counts.
		const gate = await runGate(platform.deps, { repo, ref: "main", mode: "check", samples: 1, morph: { epoch: installed.epoch } });
		const check = gate.polymorph;
		if (!check || check.fingerprint !== installed.fingerprint || check.namesHash !== installed.namesHash) throw new Error(`${repo}: the equivalence check did not check the installed copy ${installed.fingerprint}`);
		expect(gate.failures, `${repo}: failures of the installed copy's gate`).toEqual([]);
		const fork: Fork = {
			repo,
			installed: { epoch: installed.epoch, sha: installed.sha, fingerprint: installed.fingerprint, namesHash: installed.namesHash },
			compared: check.compared,
			mismatches: check.mismatches,
			skipped: check.skipped.length,
			after: null,
		};
		// A skipped name is neither renamed nor a tripwire, and every exploit here names the flag.
		expect((await installedNames(fork)).has(FLAG), `${repo}: the copy renames ${FLAG}`).toBe(true);
		forks.push(fork);
	}
	return forks;
}

/** Puts every fork back on its installed copy, in Fleet and in a fresh loader, so an attack starts from the installed fleet. */
function restoreInstalled(forks: Fork[]): void {
	for (const fork of forks) {
		const from = platform.t.fleet.morphState(fork.repo)?.epoch ?? null;
		if (!platform.t.fleet.setMorph(fork.repo, fork.installed, { from })) throw new Error(`${fork.repo}: its installed copy could not be restored`);
	}
	clearRuntimeCache();
}

/** What the platform did with one request. */
type PlatformAnswer = Pick<Outcome, "platform" | "hit">;

/** Each request's research answer from the plain fork and from the fork's stored copy, asked directly with askLoaded alone, which changes nothing. */
async function askDirectly(sends: Send[]): Promise<Pick<Outcome, "plain" | "direct">[]> {
	const plain = new Map<string, LoadedFork>();
	const copies = new Map<string, LoadedFork>();
	const answers: Pick<Outcome, "plain" | "direct">[] = [];
	for (const { repo, request } of sends) {
		if (!plain.has(repo)) plain.set(repo, await loadForkRuntime(platform.deps, repo, "main"));
		if (!copies.has(repo)) copies.set(repo, await loadCopy(repo));
		answers.push({
			plain: researchAnswer(await askLoaded(plain.get(repo)!, request), `${repo}, plain fork`),
			direct: researchAnswer(await askLoaded(copies.get(repo)!, request), `${repo}, stored copy`),
		});
	}
	return answers;
}

/**
 * Each request's research answer through the platform with polymorphic
 * installation off (no platform secret), by the same code path as with
 * copies: what the plain fleet serves. Its answers go to a ledger of their
 * own (`<user>-off`), apart from the one the platform's answers are counted in.
 */
async function askWithInstallationOff(sends: Send[]): Promise<ResearchAnswer[]> {
	const deps = platform.withoutSecret();
	const answers: ResearchAnswer[] = [];
	for (const { repo, request } of sends) {
		const served = await serveAsk(deps, { repo, ref: "main", request, useModel: false, userId: `${userIdFromForkRepo(repo)}-off`, fallback: true });
		// Without the secret the plain fork answers: no copy, and not stock.
		expect(served.fork, `${repo}: what answered with installation off`).toEqual({ repo, ref: "main", commit: platform.heads[repo] });
		answers.push(researchAnswer(served, `${repo}, through the platform with installation off`));
	}
	return answers;
}

/** One request through serveAsk on production main: answered by the fork's stored copy, or refused at one of its wires. */
async function askPlatformOnce(deps: AskDeps, { repo, request }: Send): Promise<PlatformAnswer> {
	try {
		const served = await serveAsk(deps, { repo, ref: "main", request, useModel: false, userId: userIdFromForkRepo(repo)!, fallback: true });
		// Only the fork's stored copy answers: neither the plain fork nor stock.
		expect(served.fork, `${repo}: what answered`).toMatchObject({ repo, variant: platform.t.fleet.morphState(repo)!.fingerprint });
		return { platform: researchAnswer(served, `${repo}, through the platform`), hit: null };
	} catch (error) {
		if (!(error instanceof HttpError && error.status === 403 && error.message === TRIPWIRE_REFUSAL)) throw error;
		return { platform: "refused", hit: trippedWire(repo, request) };
	}
}

/**
 * Each request through the platform, in order, as it serves production main:
 * it may refuse a request and start a rotation of the fork's copy. Checks
 * that only the answered requests wrote ledger rows. Returns what it did
 * with each request and the rotations it started.
 */
async function askThroughPlatform(sends: Send[]): Promise<{ answers: PlatformAnswer[]; rotations: RotateParams[] }> {
	// A binding of its own, so the rotations listed are the ones these requests started.
	const workflows = fakeWorkflows({ LlmHost: platform.deps.exports.LlmHost });
	const deps: AskDeps = { env: platform.t.env, exports: workflows.exports as never };
	const targets = [...new Set(sends.map((entry) => entry.repo))];
	const rowsBefore = new Map<string, number>();
	for (const repo of targets) rowsBefore.set(repo, await ledgerRows(repo));
	const answers: PlatformAnswer[] = [];
	// The live path starts one rotation per copy in each ten-minute window (copyKey), so the clock stands still while
	// the requests go out: a batch that ran across a window's end would otherwise start a second rotation of a copy.
	const now = Date.now();
	const clock = vi.spyOn(Date, "now").mockReturnValue(now);
	try {
		for (const entry of sends) answers.push(await askPlatformOnce(deps, entry));
	} finally {
		clock.mockRestore();
	}
	// A refused request writes no ledger row; an answered one writes one.
	for (const repo of targets) {
		const answered = sends.filter((entry, i) => entry.repo === repo && answers[i]!.platform !== "refused").length;
		expect((await ledgerRows(repo)) - rowsBefore.get(repo)!, `${repo}: ledger rows written`).toBe(answered);
	}
	return { answers, rotations: workflows.of("RotateWorkflow").map((instance) => instance.params as RotateParams) };
}

/**
 * Sends each request to its fork: directly, then through the platform with
 * installation off, which change nothing the next step reads, then through
 * the platform with copies. Returns what each request did and the rotations
 * started.
 */
async function send(sends: Send[]): Promise<{ outcomes: Outcome[]; rotations: RotateParams[] }> {
	frozen(sends);
	const direct = await askDirectly(sends);
	const off = await askWithInstallationOff(sends);
	// The plain fork asked directly stands for the fleet with installation off: the platform must answer each request the same.
	expect(off, "each request's answer through the platform with installation off, against the plain fork's").toEqual(direct.map((answer) => answer.plain));
	const { answers, rotations } = await askThroughPlatform(sends);
	return { outcomes: sends.map(({ repo }, i) => ({ repo, ...direct[i]!, off: off[i]!, ...answers[i]! })), rotations };
}

/** Keeps a fork's copy after one rotation, which is the same whichever rotation moved it: the seed names the fork, commit, and epoch. */
function recordRotation(fork: Fork, result: RotationResult): void {
	if (result.outcome !== "rotated") throw new Error(`${fork.repo}: the rotation did not move the fork: ${JSON.stringify(result)}`);
	const after = { epoch: result.epoch, fingerprint: result.fingerprint };
	expect(after.epoch, `${fork.repo}: epoch after one rotation`).toBe(fork.installed.epoch + 1);
	if (fork.after !== null) expect(after, `${fork.repo}: copy after one rotation`).toEqual(fork.after);
	fork.after = after;
}

/**
 * Runs one attack from the installed fleet, then each rotation it started, as
 * the rotate workflow would. Once it is done, the built-ins must be as
 * `before` (taken after the control) found them.
 */
async function attack(forks: Fork[], plan: Attack, before: BuiltIns): Promise<AttackRun> {
	restoreInstalled(forks);
	const { outcomes, rotations } = await send(plan.sends);
	const rotated = rotations.map((params) => params.repo!);
	// One rotation per copy, however many requests tripped it, and one for each copy that refused a request.
	expect(new Set(rotated).size, `attack ${plan.id}: rotations started per fork`).toBe(rotated.length);
	const refused = reposWhere(outcomes, (outcome) => outcome.platform === "refused");
	expect([...rotated].sort(), `attack ${plan.id}: forks that started a rotation, against the forks that refused a request`).toEqual([...refused].sort());
	for (const params of rotations) recordRotation(forkOf(forks, params.repo!), await rotateFork(platform.deps, params.repo!, params.reason!));
	expect(builtInsChangedSince(before), `built-ins changed by attack ${plan.id}`).toEqual([]);
	return {
		outcomes,
		recorded: {
			id: plan.id,
			label: plan.label,
			detail: plan.detail,
			tries: outcomes.length,
			targets: [...new Set(plan.sends.map((entry) => entry.repo))],
			plain: { compromised: reposWhere(outcomes, (outcome) => outcome.plain === "released") },
			direct: { compromised: reposWhere(outcomes, (outcome) => outcome.direct === "released") },
			platform: {
				compromised: reposWhere(outcomes, (outcome) => outcome.platform === "released"),
				refused,
				rotated,
			},
		},
	};
}

/** A seeded generator (mulberry32) of numbers in [0, 1), so every run sends the same guesses. */
function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), state | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/**
 * `count` random suffixes shaped like a renamed name's (8 base36 characters).
 * Blind, as an attacker's would be: nothing leaves out the copy's real
 * suffix, so a guess that found it would show in the counts.
 */
function blindGuesses(count: number): string[] {
	const random = seeded(GUESS_SEED);
	return Array.from({ length: count }, () => Array.from({ length: 8 }, () => BASE36[Math.floor(random() * BASE36.length)]).join(""));
}

/** The scoreboard's numbers for one attack: requests sent, compromised, and refused, and forks moved to a new copy. */
function requestCounts({ outcomes, recorded }: AttackRun) {
	const count = (test: (outcome: Outcome) => boolean) => outcomes.filter(test).length;
	return {
		sent: outcomes.length,
		plain: count((outcome) => outcome.plain === "released"),
		direct: count((outcome) => outcome.direct === "released"),
		compromised: count((outcome) => outcome.platform === "released"),
		refused: count((outcome) => outcome.platform === "refused"),
		moved: recorded.platform.rotated.length,
	};
}

/** How many refused requests tripped each kind of wire. */
function wiresTripped(outcomes: Outcome[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const outcome of outcomes) if (outcome.platform === "refused") counts[String(outcome.hit)] = (counts[String(outcome.hit)] ?? 0) + 1;
	return counts;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The scoreboard as plain text: a row per attack, then the equivalence check and the leaked copy after its fork moved, worded as the Polymorph view words them. */
function scoreboard(forks: Fork[], runs: AttackRun[], recording: ReturnType<typeof recordingOf>): string {
	const renamed = [...new Set(forks.map((fork) => LIST.length - fork.skipped))].join(" or ");
	const header = ["", "Attack", "Sent", "Plain fleet", "Copies, scan bypassed", "Platform", "Refused", "Moved"];
	const rows = runs.map((run) => {
		const n = requestCounts(run);
		const of = (count: number) => `${count} of ${n.sent}`;
		const { id, label, targets } = run.recorded;
		return [id, label, `${plural(n.sent, "request")} to ${plural(targets.length, "fork")}`, of(n.plain), of(n.direct), of(n.compromised), of(n.refused), `${n.moved} of ${targets.length}`];
	});
	const widths = header.map((_, column) => Math.max(...[header, ...rows].map((row) => row[column]!.length)));
	const line = (row: string[]) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();
	return [
		"Polymorphic installation against a planted zero-day",
		`${plural(forks.length, "fork")} on release ${RELEASE_LABEL}; each copy renames ${renamed} of the ${LIST.length} names on upstream's list.`,
		"",
		line(header),
		...rows.map(line),
		"",
		"Plain fleet: requests that released a held research dose on the plain forks.",
		"Copies, scan bypassed: the same on the renamed copies, asked without the platform's scan.",
		"Platform: the same through the platform. Refused: requests the platform refused.",
		"Moved: attacked forks that moved to a new copy.",
		"",
		equivalenceLine(recording),
		afterRotationLine(recording),
	].join("\n");
}

/** The recording the Polymorph view replays, in the shape its validateDemo accepts. */
function recordingOf(forks: Fork[], runs: AttackRun[], afterRotation: AfterRotation) {
	const compared = [...new Set(forks.map((fork) => fork.compared))];
	if (compared.length !== 1) throw new Error(`the copies' equivalence checks compared different numbers of probe requests: ${compared.join(", ")}`);
	return {
		version: 1,
		recordedAt: new Date().toISOString(),
		release: RELEASE_LABEL,
		listSize: LIST.length,
		probes: compared[0]!,
		forks: forks.map((fork) => {
			const after = fork.after ?? fork.installed;
			return { repo: fork.repo, before: fork.installed.fingerprint, after: after.fingerprint, epochBefore: fork.installed.epoch, epochAfter: after.epoch, mismatches: fork.mismatches };
		}),
		attacks: runs.map((run) => run.recorded),
		afterRotation,
	};
}

describe(`a fleet of ${FLEET} forks on a release with a planted zero-day`, () => {
	it(
		"installs a renamed copy per fork, then measures four exploits on the plain fleet, on the copies, and through the platform",
		async ({ task }) => {
			const n = FLEET;
			const forks = await install();
			expect.soft(forks.map((fork) => [fork.repo, fork.mismatches]), "probe answers that differ between each copy and its plain fork").toEqual(forks.map((fork) => [fork.repo, 0]));
			const everyFork = (request: Record<string, unknown>) => forks.map((fork) => ({ repo: fork.repo, request }));

			// Control: without display options the answer is held everywhere, and with attestation the same question gets its dose.
			const control = await send(everyFork(HELD));
			expect(control.outcomes.map((outcome) => [outcome.repo, outcome.plain, outcome.off, outcome.direct, outcome.platform])).toEqual(forks.map((fork) => [fork.repo, "held", "held", "held", "held"]));
			expect(control.rotations).toEqual([]);
			const attested = frozen({ ...HELD, attestation: true });
			for (const fork of forks) {
				for (const loaded of [await loadForkRuntime(platform.deps, fork.repo, "main"), await loadCopy(fork.repo)]) {
					expect(researchAnswer(await askLoaded(loaded, attested), loaded.isolateId), `${loaded.isolateId}: attested answer`).toBe("released");
				}
			}
			// Taken once the control has run every path, so what a first request sets up for good (a global made on first use) is in it.
			const before = builtInsSnapshot();

			// Each attack's checks are soft, so one failing attack does not hide what the others measured.
			const a = await attack(
				forks,
				{ id: "A", label: "Built from upstream's source", detail: `Sets display.${FLAG} to false, the internal name in upstream's public source, on every fork.`, sends: everyFork(withDisplay({ [FLAG]: false })) },
				before,
			);
			expect.soft(requestCounts(a), "attack A").toEqual({ sent: n, plain: n, direct: 0, compromised: 0, refused: n, moved: n });
			expect.soft(wiresTripped(a.outcomes), "attack A: wires tripped").toEqual({ decoy: n });

			// A disclosure of the copy one fork was installed with: the 4th fork's, or the 7th's in a fleet of 7 or more.
			const leaked = forks[FLEET < 7 ? 3 : 6]!;
			const leakedRequest = withDisplay({ [(await installedNames(leaked)).get(FLAG)!]: false });
			const a2 = await attack(
				forks,
				{ id: "A2", label: "Built from a leaked copy", detail: `Sends the same option under the renamed name from ${leaked.repo}'s copy, as if that copy had leaked, to every fork.`, sends: everyFork(leakedRequest) },
				before,
			);
			expect.soft(requestCounts(a2), "attack A2").toEqual({ sent: n, plain: 0, direct: 1, compromised: 1, refused: n - 1, moved: n - 1 });
			expect.soft([a2.recorded.direct.compromised, a2.recorded.platform.compromised], "attack A2: forks compromised directly, then through the platform").toEqual([[leaked.repo], [leaked.repo]]);
			expect.soft(wiresTripped(a2.outcomes), "attack A2: wires tripped").toEqual({ foreign: n - 1 });

			// The schedule moves the leaked fork to its next copy, where the leaked name is another copy's name.
			recordRotation(leaked, await rotateFork(platform.deps, leaked.repo, "schedule"));
			const replay = await send([{ repo: leaked.repo, request: leakedRequest }]);
			const afterRotation: AfterRotation = {
				attack: "A2",
				compromised: reposWhere(replay.outcomes, (outcome) => outcome.platform === "released"),
				refused: reposWhere(replay.outcomes, (outcome) => outcome.platform === "refused"),
			};
			expect(builtInsChangedSince(before), "built-ins changed by the leaked copy's replay").toEqual([]);
			expect.soft(afterRotation, "the leaked name after its fork moved").toEqual({ attack: "A2", compromised: [], refused: [leaked.repo] });
			expect.soft(wiresTripped(replay.outcomes), "the leaked name after its fork moved: wires tripped").toEqual({ foreign: 1 });
			expect.soft(replay.outcomes.map((outcome) => [outcome.plain, outcome.direct]), "the leaked name on its fork, asked directly: plain fork, then new copy").toEqual([["held", "held"]]);
			expect.soft(replay.rotations.map((params) => params.repo), "rotations the replay started").toEqual([leaked.repo]);

			const third = forks[2]!;
			const guesses = blindGuesses(GUESSES);
			const a3 = await attack(
				forks,
				{
					id: "A3",
					label: "Blind guessing",
					detail: `Sends ${GUESSES} requests to ${third.repo}, each with the option under a random 8-character suffix.`,
					sends: guesses.map((suffix) => ({ repo: third.repo, request: withDisplay({ [`${FLAG}$${suffix}`]: false }) })),
				},
				before,
			);
			// Why no guess compromised the copy: one in 36^8 (about 2.8 trillion) guesses finds its real suffix, so 1000 find it about once in 2.8 billion runs.
			const own = (await installedNames(third)).get(FLAG)!.slice(FLAG.length + 1);
			expect.soft(guesses, `no guess is ${third.repo}'s real suffix (odds of a hit: ${GUESSES} in 36^8)`).not.toContain(own);
			expect.soft(requestCounts(a3), "attack A3").toEqual({ sent: GUESSES, plain: 0, direct: 0, compromised: 0, refused: GUESSES, moved: 1 });
			expect.soft(wiresTripped(a3.outcomes), "attack A3: wires tripped").toEqual({ foreign: GUESSES });

			const b = await attack(forks, { id: "B", label: "Public field only", detail: "Sets display.preview to true, a public option that skips the attestation hold, on every fork.", sends: everyFork(withDisplay({ preview: true })) }, before);
			expect.soft(requestCounts(b), "attack B").toEqual({ sent: n, plain: n, direct: n, compromised: n, refused: 0, moved: 0 });

			const runs = [a, a2, a3, b];
			const recording = recordingOf(forks, runs, afterRotation);
			expect(validateDemo(recording)).toEqual([]);
			// Printed after every check, failed or not, so the scoreboard always shows what this run measured.
			if (DEMO) console.log(scoreboard(forks, runs, recording));
			// A run with a failed check writes no recording, so the page never replays one.
			if (RECORD_PATH && task.result?.state !== "fail") {
				const path = resolve(RECORD_PATH);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, `${JSON.stringify(recording, null, 2)}\n`);
			}
		},
		EXPERIMENT_MS,
	);
});

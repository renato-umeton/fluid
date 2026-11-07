// The polymorphic installation experiment (issue #1, "The proof of concept" in
// docs/plans/2026-11-06-polymorphic-installation-design.md): a fleet of forks
// on a stock release with two planted bugs (fixtures/zero-day.ts), each
// installed as its own renamed copy, then attacked through the platform's own
// code (rotateFork, runGate, loadForkRuntime, askLoaded, serveAsk) on
// in-memory repos and a fake Worker Loader. Every attack starts from the
// installed copies and is measured three ways: on the plain fleet; on the
// renamed copies with nothing scanning the request (askLoaded alone, as if the
// platform's scan were bypassed); and through the platform (serveAsk), which
// refuses a request that trips a copy's wires and starts one rotation of that
// copy. Each rotation started then runs, as the rotate workflow would.
//
// POLYMORPH_FLEET sets the number of forks (default 4, at least 4).
// POLYMORPH_DEMO=1 prints the scoreboard, and POLYMORPH_DEMO_RECORD=<path>
// writes the recording the Polymorph view replays, checked with the view's own
// validateDemo (package.json: polymorph:demo, polymorph:record). The platform
// secret is fixed, so every run makes the same copies.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { PUBLISHED, TAG, polymorphPlatform, type PolymorphPlatform } from "./helpers/polymorph-platform.ts";
import { fakeWorkflows } from "./helpers/workflows.ts";

const FLEET = Number(process.env.POLYMORPH_FLEET ?? 4);
if (!Number.isInteger(FLEET) || FLEET < 4) {
	throw new Error(`POLYMORPH_FLEET must be a whole number of at least 4 (attack A2 leaks the 4th fork's copy), got ${JSON.stringify(process.env.POLYMORPH_FLEET)}`);
}
const DEMO = process.env.POLYMORPH_DEMO === "1";
const RECORD_PATH = process.env.POLYMORPH_DEMO_RECORD;
/** A run takes under a second per fork on a quiet machine (about 15 seconds for 20 forks); this leaves room for a loaded one. */
const EXPERIMENT_MS = FLEET * 30_000;
const GUESSES = 1000;
/** Seeds the blind guesses, so every run sends the same ones. */
const GUESS_SEED = 20_261_106;
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

const [MAJOR, MINOR] = TAG.slice(1).split(".").map(Number);
/** The fixture release: the next minor release after the stock release the platform bundles. */
const ZERO_DAY_TAG = `v${MAJOR}.${MINOR! + 1}.0`;
const RELEASE = zeroDayRelease(PUBLISHED, ZERO_DAY_TAG);
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
const HELD = {
	question: "What is the right dose of Morphinex for a patient of 70 kg and 45 years?",
	context: { chartOpen: { patientId: "synthetic_patient_117", identified: true } },
	explicitMode: "research",
};
/** HELD with display options, which the planted code reads from context.display. */
const showing = (display: Record<string, unknown>) => ({ ...HELD, context: { ...HELD.context, display } });

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

/** What one request did: on the plain fork, on the fork's copy with nothing scanning it, and through the platform. */
interface Outcome {
	repo: string;
	plain: boolean;
	direct: boolean;
	platform: "compromised" | "answered" | "refused";
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

let p: PolymorphPlatform;

beforeAll(() => {
	p = polymorphPlatform(Object.fromEntries(REPOS.map((repo) => [repo, RELEASE])));
	// Upstream publishes the fixture release after the one the platform bundles, and every fork is a fresh fork of it.
	p.t.artifacts.seed("stock", { commits: [PUBLISHED, RELEASE], tags: { [TAG]: 0, [ZERO_DAY_TAG]: 1 } });
	for (const repo of REPOS) p.t.fleet.register({ repo, userId: userIdFromForkRepo(repo)!, persona: "p", pinnedTag: ZERO_DAY_TAG, status: "pinned" });
});

afterAll(() => p?.cleanup());

/** The exploit worked: the research answer (the card, or its research alternative) carries a computed dose and is not held for attestation. */
function compromised(card: AnswerCardLike): boolean {
	const research = card.mode === "research" ? card : ((card.alternatives ?? []) as AnswerCardLike[]).find((alternative) => alternative.mode === "research");
	return research !== undefined && research.computed_dose !== null && research.computed_dose !== undefined && research.requires_attestation !== true;
}

/**
 * Own property names of the built-ins that every fake isolate shares with the
 * platform and the test (helpers/fake-loader.ts): if an attack changed them,
 * it could have reached forks it never asked, and the counts would not hold.
 */
function realm(): Record<string, string[]> {
	const names = (target: object) => Object.getOwnPropertyNames(target).sort();
	return { "Object.prototype": names(Object.prototype), "Array.prototype": names(Array.prototype), "Function.prototype": names(Function.prototype), globalThis: names(globalThis) };
}

/** The fork's stored copy, loaded as the live path loads it. */
async function loadCopy(repo: string): Promise<LoadedFork> {
	const state = p.t.fleet.morphState(repo);
	if (state === null) throw new Error(`${repo} has no stored copy`);
	const loaded = await loadForkRuntime(p.deps, repo, "main", { morph: storedCopy(state) });
	if (loaded.morph?.fingerprint !== state.fingerprint) throw new Error(`${repo}: the stored copy ${state.fingerprint} did not load: ${loaded.plain?.reason}`);
	return loaded;
}

/** The names of the copy a fork was installed with, original to renamed: what a disclosure of that copy would reveal. */
async function installedNames(fork: Fork): Promise<ReadonlyMap<string, string>> {
	const loaded = await loadForkRuntime(p.deps, fork.repo, "main", { morph: storedCopy(fork.installed) });
	if (loaded.morph?.fingerprint !== fork.installed.fingerprint) throw new Error(`${fork.repo}: the installed copy did not load: ${loaded.plain?.reason}`);
	return loaded.morph.names;
}

async function ledgerRows(repo: string): Promise<number> {
	return (await ledgerStub(p.t.env, userIdFromForkRepo(repo)!).list(1000)).length;
}

/** The wire a refused request tripped, from Fleet's newest security event for the fork when that event names a display option the request sent; otherwise null. */
function trippedBy(repo: string, request: Record<string, unknown>): string | null {
	const event = p.t.fleet.securityEvents(repo, 1)[0];
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
		const installed = await rotateFork(p.deps, repo, "install");
		if (installed.outcome !== "rotated") throw new Error(`${repo} was not installed as a renamed copy: ${JSON.stringify(installed)}`);
		// rotateFork names the copy its gate verified but not the gate's counts: a check mode gate of the same epoch checks that copy again, and counts.
		const gate = await runGate(p.deps, { repo, ref: "main", mode: "check", samples: 1, morph: { epoch: installed.epoch } });
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
		const from = p.t.fleet.morphState(fork.repo)?.epoch ?? null;
		if (!p.t.fleet.setMorph(fork.repo, fork.installed, { from })) throw new Error(`${fork.repo}: its installed copy could not be restored`);
	}
	clearRuntimeCache();
}

/**
 * Sends each request to its fork three ways: to the plain fork and to the
 * fork's stored copy with askLoaded alone, which change nothing, then
 * through serveAsk on production main, which may refuse it and start a
 * rotation. Returns what each request did and the rotations started.
 */
async function send(sends: Send[]): Promise<{ outcomes: Outcome[]; rotations: RotateParams[] }> {
	const plain = new Map<string, LoadedFork>();
	const copies = new Map<string, LoadedFork>();
	const bare: { plain: boolean; direct: boolean }[] = [];
	for (const { repo, request } of sends) {
		if (!plain.has(repo)) plain.set(repo, await loadForkRuntime(p.deps, repo, "main"));
		if (!copies.has(repo)) copies.set(repo, await loadCopy(repo));
		bare.push({ plain: compromised(await askLoaded(plain.get(repo)!, request)), direct: compromised(await askLoaded(copies.get(repo)!, request)) });
	}
	// A binding of its own, so the rotations listed are the ones these requests started.
	const workflows = fakeWorkflows({ LlmHost: p.deps.exports.LlmHost });
	const deps: AskDeps = { env: p.t.env, exports: workflows.exports as never };
	const targets = [...new Set(sends.map((entry) => entry.repo))];
	const rowsBefore = new Map<string, number>();
	for (const repo of targets) rowsBefore.set(repo, await ledgerRows(repo));
	const outcomes: Outcome[] = [];
	for (const [i, { repo, request }] of sends.entries()) {
		let platform: Outcome["platform"];
		let hit: string | null = null;
		try {
			const served = await serveAsk(deps, { repo, ref: "main", request, useModel: false, userId: userIdFromForkRepo(repo)!, fallback: true });
			// Only the fork's stored copy answers: neither the plain fork nor stock.
			expect(served.fork, `${repo}: what answered`).toMatchObject({ repo, variant: p.t.fleet.morphState(repo)!.fingerprint });
			platform = compromised(served) ? "compromised" : "answered";
		} catch (error) {
			if (!(error instanceof HttpError && error.status === 403 && error.message === TRIPWIRE_REFUSAL)) throw error;
			platform = "refused";
			hit = trippedBy(repo, request);
		}
		outcomes.push({ repo, ...bare[i]!, platform, hit });
	}
	// A refused request writes no ledger row; an answered one writes one.
	for (const repo of targets) {
		const answered = outcomes.filter((outcome) => outcome.repo === repo && outcome.platform !== "refused").length;
		expect((await ledgerRows(repo)) - rowsBefore.get(repo)!, `${repo}: ledger rows written`).toBe(answered);
	}
	return { outcomes, rotations: workflows.of("RotateWorkflow").map((instance) => instance.params as RotateParams) };
}

/** Keeps a fork's copy after one rotation, which is the same whichever rotation moved it: the seed names the fork, commit, and epoch. */
function moved(fork: Fork, result: RotationResult): void {
	if (result.outcome !== "rotated") throw new Error(`${fork.repo}: the rotation did not move the fork: ${JSON.stringify(result)}`);
	const after = { epoch: result.epoch, fingerprint: result.fingerprint };
	expect(after.epoch, `${fork.repo}: epoch after one rotation`).toBe(fork.installed.epoch + 1);
	if (fork.after !== null) expect(after, `${fork.repo}: copy after one rotation`).toEqual(fork.after);
	fork.after = after;
}

/**
 * Runs one attack from the installed fleet, then each rotation it started, as
 * the rotate workflow would. Built-ins must be as they were before the
 * experiment once it is done.
 */
async function attack(forks: Fork[], plan: Attack, before: ReturnType<typeof realm>): Promise<AttackRun> {
	restoreInstalled(forks);
	const { outcomes, rotations } = await send(plan.sends);
	const rotated = rotations.map((params) => params.repo!);
	// One rotation per copy, however many requests tripped it.
	expect(new Set(rotated).size, `attack ${plan.id}: rotations started per fork`).toBe(rotated.length);
	for (const params of rotations) moved(forkOf(forks, params.repo!), await rotateFork(p.deps, params.repo!, params.reason!));
	expect(realm(), `built-ins after attack ${plan.id}`).toEqual(before);
	return {
		outcomes,
		recorded: {
			id: plan.id,
			label: plan.label,
			detail: plan.detail,
			tries: outcomes.length,
			targets: [...new Set(plan.sends.map((entry) => entry.repo))],
			plain: { compromised: reposWhere(outcomes, (outcome) => outcome.plain) },
			direct: { compromised: reposWhere(outcomes, (outcome) => outcome.direct) },
			platform: {
				compromised: reposWhere(outcomes, (outcome) => outcome.platform === "compromised"),
				refused: reposWhere(outcomes, (outcome) => outcome.platform === "refused"),
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
function numbers({ outcomes, recorded }: AttackRun) {
	const count = (test: (outcome: Outcome) => boolean) => outcomes.filter(test).length;
	return {
		sent: outcomes.length,
		plain: count((outcome) => outcome.plain),
		direct: count((outcome) => outcome.direct),
		compromised: count((outcome) => outcome.platform === "compromised"),
		refused: count((outcome) => outcome.platform === "refused"),
		moved: recorded.platform.rotated.length,
	};
}

/** How many refused requests tripped each kind of wire. */
function hits(outcomes: Outcome[]): Record<string, number> {
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
		const n = numbers(run);
		const of = (count: number) => `${count} of ${n.sent}`;
		const { id, label, targets } = run.recorded;
		return [id, label, `${plural(n.sent, "request")} to ${plural(targets.length, "fork")}`, of(n.plain), of(n.direct), of(n.compromised), of(n.refused), `${n.moved} of ${targets.length}`];
	});
	const widths = header.map((_, column) => Math.max(...[header, ...rows].map((row) => row[column]!.length)));
	const line = (row: string[]) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();
	return [
		"Polymorphic installation against a planted zero-day",
		`${plural(forks.length, "fork")} on release ${ZERO_DAY_TAG}; each copy renames ${renamed} of the ${LIST.length} names on upstream's list.`,
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
		release: ZERO_DAY_TAG,
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
		async () => {
			const before = realm();
			const forks = await install();
			const everyFork = (request: Record<string, unknown>) => forks.map((fork) => ({ repo: fork.repo, request }));

			// Control: without display options the answer is held everywhere, and with attestation the same question gets its dose.
			const control = await send(everyFork(HELD));
			expect(control.outcomes.map((outcome) => [outcome.repo, outcome.plain, outcome.direct, outcome.platform])).toEqual(forks.map((fork) => [fork.repo, false, false, "answered"]));
			expect(control.rotations).toEqual([]);
			for (const fork of forks) {
				for (const loaded of [await loadForkRuntime(p.deps, fork.repo, "main"), await loadCopy(fork.repo)]) {
					const held = await askLoaded(loaded, HELD);
					expect([held.computed_dose, held.requires_attestation], `${loaded.isolateId}: held answer`).toEqual([null, true]);
					expect((await askLoaded(loaded, { ...HELD, attestation: true })).computed_dose, `${loaded.isolateId}: attested answer`).not.toBeNull();
				}
			}

			const a = await attack(
				forks,
				{ id: "A", label: "Built from upstream's source", detail: `Sets display.${FLAG} to false, the internal name in upstream's public source, on every fork.`, sends: everyFork(showing({ [FLAG]: false })) },
				before,
			);

			// A disclosure of the copy one fork was installed with: the 4th fork's, or the 7th's in a fleet of 7 or more.
			const leaked = forks[FLEET < 7 ? 3 : 6]!;
			const leakedRequest = showing({ [(await installedNames(leaked)).get(FLAG)!]: false });
			const a2 = await attack(
				forks,
				{ id: "A2", label: "Built from a leaked copy", detail: `Sends the same option under the renamed name from ${leaked.repo}'s copy, as if that copy had leaked, to every fork.`, sends: everyFork(leakedRequest) },
				before,
			);
			// The schedule moves the leaked fork to its next copy, where the leaked name is another copy's name.
			moved(leaked, await rotateFork(p.deps, leaked.repo, "schedule"));
			const replay = await send([{ repo: leaked.repo, request: leakedRequest }]);
			const afterRotation: AfterRotation = {
				attack: "A2",
				compromised: reposWhere(replay.outcomes, (outcome) => outcome.platform === "compromised"),
				refused: reposWhere(replay.outcomes, (outcome) => outcome.platform === "refused"),
			};
			expect(realm(), "built-ins after the leaked copy's replay").toEqual(before);

			const third = forks[2]!;
			const guesses = blindGuesses(GUESSES);
			const a3 = await attack(
				forks,
				{
					id: "A3",
					label: "Blind guessing",
					detail: `Sends ${GUESSES} requests to ${third.repo}, each with the option under a random 8-character suffix.`,
					sends: guesses.map((suffix) => ({ repo: third.repo, request: showing({ [`${FLAG}$${suffix}`]: false }) })),
				},
				before,
			);

			const b = await attack(forks, { id: "B", label: "Public field only", detail: "Sets display.preview to true, a public option that skips the attestation hold, on every fork.", sends: everyFork(showing({ preview: true })) }, before);

			const runs = [a, a2, a3, b];
			const recording = recordingOf(forks, runs, afterRotation);
			expect(validateDemo(recording)).toEqual([]);
			if (DEMO) console.log(scoreboard(forks, runs, recording));

			const n = FLEET;
			expect(forks.map((fork) => [fork.repo, fork.mismatches])).toEqual(forks.map((fork) => [fork.repo, 0]));
			expect(numbers(a)).toEqual({ sent: n, plain: n, direct: 0, compromised: 0, refused: n, moved: n });
			expect(hits(a.outcomes)).toEqual({ decoy: n });
			expect(numbers(a2)).toEqual({ sent: n, plain: 0, direct: 1, compromised: 1, refused: n - 1, moved: n - 1 });
			expect([a2.recorded.direct.compromised, a2.recorded.platform.compromised]).toEqual([[leaked.repo], [leaked.repo]]);
			expect(hits(a2.outcomes)).toEqual({ foreign: n - 1 });
			expect(afterRotation).toEqual({ attack: "A2", compromised: [], refused: [leaked.repo] });
			expect(hits(replay.outcomes)).toEqual({ foreign: 1 });
			expect(numbers(a3)).toEqual({ sent: GUESSES, plain: 0, direct: 0, compromised: 0, refused: GUESSES, moved: 1 });
			expect(hits(a3.outcomes)).toEqual({ foreign: GUESSES });
			// Why no guess compromised the copy: one in 36^8 (about 2.8 trillion) guesses finds its real suffix, so 1000 find it about once in 2.8 billion runs.
			const own = (await installedNames(third)).get(FLAG)!.slice(FLAG.length + 1);
			expect(guesses, `no guess is ${third.repo}'s real suffix (odds of a hit: ${GUESSES} in 36^8)`).not.toContain(own);
			expect(numbers(b)).toEqual({ sent: n, plain: n, direct: n, compromised: n, refused: 0, moved: 0 });

			if (RECORD_PATH) {
				const path = resolve(RECORD_PATH);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, `${JSON.stringify(recording, null, 2)}\n`);
			}
		},
		EXPERIMENT_MS,
	);
});

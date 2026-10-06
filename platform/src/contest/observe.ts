// Capturing behavior during a gate. Stock's runner reaches the fork only
// through the platform's ask callback (gate/run.ts). For a contest, that
// callback also keeps the card each request got, on the platform side, so
// neither stock's runner nor its isolate changes. The cards are then joined
// with the probes that sent the requests and their results.
import type { RunnerManifestResult } from "../gate/tiers.ts";
import { cardHash, compactCard, probeContentKey, requestKey, type Observation, type ProbeTier } from "./behavior.ts";

/** Distinct requests recorded per gate run: the stock suites (about 70 probes today) plus at most 20 user and 12 wish tests, with room to grow. */
export const MAX_RECORDED_CARDS = 200;
/** Wish tests run against main and every candidate. */
export const MAX_WISH_TESTS = 12;

export interface ManifestProbeLike {
	id: string;
	kind?: unknown;
	file?: unknown;
	request?: unknown;
	focusMode?: unknown;
	assert?: unknown;
	[key: string]: unknown;
}

/**
 * The requests a gate run records, chosen before it runs: the first `max`
 * distinct requests of its probes in manifest order (invariant, functional,
 * user, wish tests). The runner sends requests in no fixed order, so choosing
 * up front makes main and every candidate record the same set.
 */
export function recordedKeys(lists: ManifestProbeLike[][], max = MAX_RECORDED_CARDS): Set<string> {
	const keys = new Set<string>();
	for (const list of lists) {
		for (const probe of list) {
			if (probe.kind === "config" || probe.request === undefined) continue;
			if (keys.size >= max) return keys;
			keys.add(requestKey(probe.request));
		}
	}
	return keys;
}

/** Wraps the gate's ask callback: every card passes through unchanged, and the first card per chosen request is kept. */
export function cardRecorder(ask: (request: unknown) => Promise<unknown>, allowed?: Set<string>): { ask: (request: unknown) => Promise<unknown>; cards: Map<string, unknown> } {
	const cards = new Map<string, unknown>();
	return {
		cards,
		ask: async (request) => {
			const card = await ask(request);
			const key = requestKey(request);
			if (!cards.has(key) && (allowed ? allowed.has(key) : cards.size < MAX_RECORDED_CARDS)) cards.set(key, card);
			return card;
		},
	};
}

/**
 * The wish tests of a contest: every contestant's suggested tests, with
 * copies of one test (same request and assertions, different ids) merged
 * under one key, "wish:<n>", in lineup order and capped.
 */
export function wishTestSet(lists: ManifestProbeLike[][], max = MAX_WISH_TESTS): { probes: ManifestProbeLike[]; keys: Map<string, string> } {
	const keys = new Map<string, string>();
	const probes: ManifestProbeLike[] = [];
	for (const list of lists) {
		for (const probe of list) {
			const content = probeContentKey(probe);
			if (keys.has(content) || probes.length >= max) continue;
			keys.set(content, `wish:${probes.length + 1}`);
			probes.push(probe);
		}
	}
	return { probes, keys };
}

/** Joins each probe that ran with its result and the card its request got. */
export function buildObservations(runs: { tier: Exclude<ProbeTier, "wish">; probes: ManifestProbeLike[]; result: RunnerManifestResult | null }[], cards: Map<string, unknown>, wishKeys: Map<string, string>): Observation[] {
	const out: Observation[] = [];
	for (const run of runs) {
		const results = new Map((run.result?.probes ?? []).map((p) => [p.id, p.passed]));
		for (const probe of run.probes) {
			const wish = wishKeys.get(probeContentKey(probe));
			const config = probe.kind === "config";
			const question = config ? `config ${typeof probe.file === "string" ? probe.file : "fluid.toml"}` : typeof (probe.request as { question?: unknown } | undefined)?.question === "string" ? String((probe.request as { question: string }).question).slice(0, 200) : null;
			const card = config ? undefined : cards.get(requestKey(probe.request));
			out.push({ id: probe.id, key: wish ?? `${run.tier}:${probe.id}`, tier: wish ? "wish" : run.tier, passed: results.get(probe.id) ?? null, question, card: card === undefined ? null : compactCard(card) });
		}
	}
	return out;
}

/** A workflow step's output is limited, so an evaluate step's observations stay under this size. */
export const MAX_OBSERVATION_CHARS = 700_000;

/**
 * Keeps observations under `max` characters by dropping cards: probes outside
 * the wish first, last probe first, then wish tests. Every probe keeps its
 * result, and a dropped card is marked and keeps a short hash, so the
 * behavior diff compares it with main's card by hash (a mismatch is one
 * change) instead of reading the missing card as a change.
 */
export function capObservations(observations: Observation[], max = MAX_OBSERVATION_CHARS): Observation[] {
	let size = JSON.stringify(observations).length;
	if (size <= max) return observations;
	const out = observations.map((o) => ({ ...o }));
	const order = [...out.keys()].reverse().sort((a, b) => Number(out[a]!.tier === "wish") - Number(out[b]!.tier === "wish"));
	for (const i of order) {
		if (size <= max) break;
		const o = out[i]!;
		if (o.card === null) continue;
		size -= JSON.stringify(o.card).length - 4;
		o.cardHash = cardHash(o.card);
		o.card = null;
		o.dropped = true;
		// ,"dropped":true and ,"cardHash":"<8 hex>"
		size += 15 + 22;
	}
	return out;
}

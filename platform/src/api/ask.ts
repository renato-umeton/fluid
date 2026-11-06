// The platform's ask path, shared by POST /api/ask and the yellow soak's
// end-to-end host: ask the fork (or stock after a safety grace period), refuse
// any clinical card with a computed dose, and append the answer's run-time
// record to the given user's ledger. On production main, a fork whose main
// has a verified renamed copy (see polymorph/) answers from that copy.
import type { MorphState } from "../durable/fleet.ts";
import { currentStockTag } from "../forks/provision.ts";
import { STOCK_REPO } from "../lib/names.ts";
import { polymorphSecret } from "../polymorph/install.ts";
import { askFork, askLoaded, FORK_CALL_TIMEOUT_MS, loadForkRuntime, storedCopy, withTimeout, type AnswerCardLike, type RuntimeDeps } from "../runtime/loader.ts";
import { resolveCommit, shortRef } from "../runtime/refs.ts";
import { openRepo } from "../runtime/repo-files.ts";
import type { RunTimeRecord } from "../durable/user-ledger.ts";
import { fleetStub, ledgerStub } from "../stubs.ts";
import { hasClinicalDose, markSafety, SAFETY_SIGNALS } from "./safety.ts";

export interface ServeAskInput {
	repo: string;
	ref: string;
	request: Record<string, unknown>;
	useModel: boolean;
	/** The ledger the answer is recorded in (the real user, or a run-scoped test user). */
	userId: string;
	/** Apply the safety fallback and serve the fork's verified renamed copy (production main only). */
	fallback: boolean;
	/** On a re-ask (override or attestation), the first answer of the same question; recorded as reask_of. */
	reaskOf?: string;
}

export type ServedCard = AnswerCardLike & { fork: Record<string, unknown> };

/** A card and what answered it: the commit, the ref as asked, and the fingerprint of the renamed copy when one answered. */
interface Answer {
	card: AnswerCardLike;
	sha: string;
	ref: string;
	variant: string | null;
}

export async function serveAsk(deps: RuntimeDeps, input: ServeAskInput): Promise<ServedCard> {
	const { env } = deps;
	const { repo, ref, request, useModel } = input;
	const fleet = fleetStub(env);
	// Safety fallback (spec 7): after a safety release's grace period, a fork still pinned below it is
	// answered by stock at that release (production only: main). The card carries a visible signal.
	// askState also returns the fork's verified renamed copy, so serving it costs no extra call.
	const state = input.fallback && repo !== STOCK_REPO ? await fleet.askState(repo) : null;
	const fallback = state?.fallback ?? null;
	let result: Answer = fallback ? { ...(await askFork(deps, { repo: STOCK_REPO, ref: fallback.tag, request, useModel })), variant: null } : await askOwnFork(deps, { repo, ref, request, useModel, copy: state?.morph ?? null });
	let card = fallback
		? markSafety(result.card, SAFETY_SIGNALS.stockFallback, `Safety fallback: the grace period of stock ${fallback.tag} ended ${fallback.graceUntil.slice(0, 10)} and this fork is still pinned to ${fallback.from}, so stock ${fallback.tag} answered. Apply the open repair or upgrade to use your customizations again.`)
		: result.card;
	let served = fallback ? { repo: STOCK_REPO, ref: fallback.tag, fallback } : { repo, ref, fallback: null };
	// Backstop: no answer with a computed clinical dose is ever served, whatever the fork's code does.
	if (hasClinicalDose(card)) {
		if (served.repo === STOCK_REPO) throw new Error("stock answered a clinical card with a computed dose");
		const pinned = (await fleet.get(repo))?.pinnedTag ?? (await currentStockTag(env));
		console.error(`safety guard: ${repo}@${result.sha.slice(0, 7)} answered a clinical card with a computed dose; serving stock ${pinned}`);
		result = { ...(await askFork(deps, { repo: STOCK_REPO, ref: pinned, request, useModel })), variant: null };
		card = markSafety(result.card, SAFETY_SIGNALS.clinicalDose, `Safety guard: this fork's answer computed a clinical dose, which the floor forbids, so stock ${pinned} answered instead.`);
		served = { repo: STOCK_REPO, ref: pinned, fallback: null };
	}
	if (input.reaskOf) card = { ...card, ledger: { ...card.ledger, reask_of: input.reaskOf } };
	// A copy's answer names the copy by its fingerprint, in the ledger as in the response.
	if (result.variant) card = { ...card, ledger: { ...card.ledger, variant: result.variant } };
	await ledgerStub(env, input.userId).append(input.userId, repo, card.ledger as unknown as RunTimeRecord);
	return { ...card, fork: { repo, ref: result.ref, commit: result.sha, ...(result.variant ? { variant: result.variant } : {}), ...(served.repo !== repo ? { servedBy: { repo: served.repo, ref: served.ref } } : {}), ...(served.fallback ? { safetyFallback: served.fallback } : {}) } };
}

/**
 * Asks the fork itself. When Fleet holds a verified copy of the commit the
 * ref is at, that copy answers, with the model off: useModel comes from the
 * request, so serving the plain fork for it would let any request bypass the
 * copy, and the gate verified the copy with the model off. Otherwise the plain
 * fork answers as before, model and all: no copy stored, no platform secret,
 * or a copy of an older commit (main moved, and the landed rotation has not
 * stored the new commit's copy yet).
 */
async function askOwnFork(deps: RuntimeDeps, input: { repo: string; ref: string; request: Record<string, unknown>; useModel: boolean; copy: MorphState | null }): Promise<Answer> {
	const { repo, ref, request, copy } = input;
	if (copy === null || polymorphSecret(deps.env) === null || (await commitOf(deps.env, repo, ref)) !== copy.sha) {
		return { ...(await askFork(deps, { repo, ref, request, useModel: input.useModel })), variant: null };
	}
	// Loaded at the commit just checked, so a push landing now cannot slip another commit under the copy.
	const loaded = await loadForkRuntime(deps, repo, copy.sha, { useModel: false, morph: storedCopy(copy) });
	const card = await withTimeout(askLoaded(loaded, request, { useModel: false }), FORK_CALL_TIMEOUT_MS, `fork ${repo} did not answer`);
	return { card, sha: loaded.sha, ref: shortRef(ref), variant: loaded.morph?.fingerprint ?? null };
}

async function commitOf(env: Env, repo: string, ref: string): Promise<string> {
	using handle = await openRepo(env.ARTIFACTS, repo);
	return resolveCommit(handle, ref);
}

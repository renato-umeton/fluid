// The platform's ask path, shared by POST /api/ask and the yellow soak's
// end-to-end host: ask the fork (or stock after a safety grace period), refuse
// any clinical card with a computed dose, and append the answer's run-time
// record to the given user's ledger. A fork with a verified renamed copy (see
// polymorph/) is guarded on every ref: its copy's commit answers from the
// copy, behind the copy's tripwires, and any other commit answers plain to a
// request those tripwires let through.
import type { MorphState } from "../durable/fleet.ts";
import { currentStockTag } from "../forks/provision.ts";
import { STOCK_REPO } from "../lib/names.ts";
import { polymorphSecret } from "../polymorph/install.ts";
import { scanRequest, type TripwireHit } from "../polymorph/tripwire.ts";
import { askFork, askLoaded, buildStoredCopy, FORK_CALL_TIMEOUT_MS, loadForkRuntime, storedCopy, withTimeout, type AnswerCardLike, type LoadedCopy, type PlainLoad, type RuntimeDeps } from "../runtime/loader.ts";
import { resolveCommit, shortRef } from "../runtime/refs.ts";
import { openRepo } from "../runtime/repo-files.ts";
import type { RunTimeRecord } from "../durable/user-ledger.ts";
import { fleetStub, ledgerStub } from "../stubs.ts";
import { copyKey, errorText, startRotation, type RotateParams, type WorkflowBinding } from "../workflows/common.ts";
import { HttpError } from "./http.ts";
import { hasClinicalDose, markSafety, SAFETY_SIGNALS } from "./safety.ts";

/** The runtime, plus the rotate workflow, which a request tripping a fork's copy (on any ref) or a copy that no longer loads starts. */
export interface AskDeps extends RuntimeDeps {
	exports: RuntimeDeps["exports"] & { RotateWorkflow?: WorkflowBinding<RotateParams> };
}

/** What every request that trips a copy's wire gets, whichever wire it was, so a sender learns nothing about the copy. */
export const TRIPWIRE_REFUSAL = "Request refused by a security check.";
/** What a request too deep or too wide for the tripwire scan gets: it is refused rather than scanned in part. */
export const UNSCANNABLE_REFUSAL = "Request too large or too deeply nested.";
/** What a request gets while a read that main's verified copy needs fails: Artifacts errors pass, so it can ask again. */
export const COPY_RETRY = "The fork's renamed copy could not be loaded; retry shortly.";
const COPY_RETRY_AFTER_SECONDS = 10;

export interface ServeAskInput {
	repo: string;
	ref: string;
	request: Record<string, unknown>;
	useModel: boolean;
	/** The ledger the answer is recorded in (the real user, or a run-scoped test user). */
	userId: string;
	/** Apply the safety fallback (production main only). */
	fallback: boolean;
	/**
	 * Ask the plain fork at ref exactly as built: no renamed copy and no
	 * tripwire scan. Only the yellow soak's host sets it: it checks a commit as
	 * it landed, while the copy Fleet holds is of the commit before until a
	 * rotation stores one, and that copy's names could refuse the new commit's
	 * own scenarios. Every other ask, on any ref, goes through the fork's copy.
	 */
	asBuilt?: boolean;
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

export async function serveAsk(deps: AskDeps, input: ServeAskInput): Promise<ServedCard> {
	const { env } = deps;
	const { repo, ref, request, useModel } = input;
	const fleet = fleetStub(env);
	// Safety fallback (spec 7): after a safety release's grace period, a fork still pinned below it is
	// answered by stock at that release (production only: main). The card carries a visible signal.
	// askState also returns the fork's verified renamed copy, which guards every ref, in the same call.
	const state = repo !== STOCK_REPO && (input.fallback || !input.asBuilt) ? await fleet.askState(repo) : null;
	const fallback = input.fallback ? (state?.fallback ?? null) : null;
	const copy = input.asBuilt ? null : (state?.morph ?? null);
	let result: Answer = fallback ? { ...(await askFork(deps, { repo: STOCK_REPO, ref: fallback.tag, request, useModel })), variant: null } : await askOwnFork(deps, { repo, ref, request, useModel, copy });
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
 * Asks the fork itself. A fork with a verified copy (Fleet's MorphState) is
 * guarded on every ref. When the ref is at the copy's commit, the copy
 * answers, with the model off, once the request passes its tripwires:
 * useModel comes from the request, so serving the plain fork for it would let
 * any request bypass the copy, and the gate verified the copy with the model
 * off. Any other commit (another branch or tag, or main before the rotation
 * of the commit it moved to stores a copy) answers plain as before, model and
 * all, but only to a request the stored copy's tripwires let through, so no
 * ref reaches the original names the copy retired. When the stored copy does
 * not load, see copyDidNotLoad. A fork with no copy, or a platform without a
 * secret, answers plain as before.
 */
async function askOwnFork(deps: AskDeps, input: { repo: string; ref: string; request: Record<string, unknown>; useModel: boolean; copy: MorphState | null }): Promise<Answer> {
	const { repo, ref, request, copy } = input;
	if (copy === null || polymorphSecret(deps.env) === null) return { ...(await askFork(deps, { repo, ref, request, useModel: input.useModel })), variant: null };
	const commit = await commitOf(deps.env, repo, ref);
	if (commit === copy.sha) {
		// Loaded at the commit just checked, so a push landing now cannot slip another commit under the copy.
		const loaded = await loadForkRuntime(deps, repo, copy.sha, { useModel: false, morph: storedCopy(copy) });
		if (loaded.morph) await checkTripwires(deps, repo, request, loaded.morph);
		else await copyDidNotLoad(deps, repo, copy, loaded.plain);
		const card = await withTimeout(askLoaded(loaded, request, { useModel: false }), FORK_CALL_TIMEOUT_MS, `fork ${repo} did not answer`);
		return { card, sha: loaded.sha, ref: shortRef(ref), variant: loaded.morph?.fingerprint ?? null };
	}
	// The stored copy is made (from the cache once made) but never started: only its names are needed here.
	const stored = await buildStoredCopy(deps, repo, copy);
	if (stored.copy) await checkTripwires(deps, repo, request, stored.copy);
	else await copyDidNotLoad(deps, repo, copy, stored.plain);
	// Asked at the commit just checked, but answered under the ref as asked.
	return { ...(await askFork(deps, { repo, ref: commit, request, useModel: input.useModel })), ref: shortRef(ref), variant: null };
}

/**
 * The fork's stored copy did not load. When a read failed (Artifacts), the
 * request is refused as retryable: the plain fork answering unchecked would
 * let a request reach the original names whenever Artifacts errs. Any other
 * reason will not pass by itself (the secret changed, the copy would rename
 * other names, the renamer refuses the code now), so the plain fork answers
 * (at the copy's commit with the model off, as the copy would) and one
 * rotation of the stored copy brings back a verified one.
 */
async function copyDidNotLoad(deps: AskDeps, repo: string, copy: MorphState, plain: PlainLoad | null): Promise<void> {
	if (plain?.kind === "transient") throw new HttpError(503, COPY_RETRY, {}, { "retry-after": String(COPY_RETRY_AFTER_SECONDS) });
	await startRotation(deps.env, deps.exports.RotateWorkflow, { repo, reason: "mismatch", key: copyKey(copy) });
}

/**
 * Refuses, before the copy sees it, a request that names one of the copy's
 * dead original names or another copy's renamed one (polymorph/tripwire.ts).
 * The hit is recorded as a security event and starts one rotation of this
 * copy, however many requests trip it; the fork keeps serving. A request too
 * deep or too wide to scan is refused too, and records and starts nothing.
 */
async function checkTripwires(deps: AskDeps, repo: string, request: Record<string, unknown>, copy: LoadedCopy): Promise<void> {
	let hit: TripwireHit | null;
	try {
		hit = scanRequest(request, copy.names);
	} catch (error) {
		if (error instanceof RangeError) throw new HttpError(400, UNSCANNABLE_REFUSAL);
		throw error;
	}
	if (hit === null) return;
	try {
		await fleetStub(deps.env).recordSecurityEvent(repo, { kind: "tripwire", detail: { hit: hit.kind, name: hit.name, path: hit.path, epoch: copy.epoch, fingerprint: copy.fingerprint } });
	} catch (error) {
		// The refusal stands either way: the event is for admins, and a failure here must not answer differently.
		console.error(`polymorph: a tripwire hit on ${repo} was not recorded: ${errorText(error)}`);
	}
	await startRotation(deps.env, deps.exports.RotateWorkflow, { repo, reason: "tripwire", key: copyKey(copy) });
	throw new HttpError(403, TRIPWIRE_REFUSAL);
}

async function commitOf(env: Env, repo: string, ref: string): Promise<string> {
	using handle = await openRepo(env.ARTIFACTS, repo);
	return resolveCommit(handle, ref);
}

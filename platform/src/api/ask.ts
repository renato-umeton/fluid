// The platform's ask path: ask the fork (or stock after a safety grace
// period), refuse any clinical card with a computed dose, and append the
// answer's run-time record to the given user's ledger. serveAsk (POST
// /api/ask) guards a fork with a verified renamed copy (see polymorph/) on
// every ref: its copy's commit answers from the copy, behind the copy's
// tripwires, and any other commit answers plain to a request those tripwires
// let through. serveAskAsBuilt, the yellow soak's own entry point, asks a
// commit exactly as built.
import type { MorphState, SafetyFallback } from "../durable/fleet.ts";
import { currentStockTag } from "../forks/provision.ts";
import { STOCK_REPO } from "../lib/names.ts";
import { polymorphSecret } from "../polymorph/install.ts";
import { scanRequest, type TripwireHit } from "../polymorph/tripwire.ts";
import { askFork, askLoaded, buildStoredCopy, FORK_CALL_TIMEOUT_MS, loadForkRuntime, storedCopy, withTimeout, type AnswerCardLike, type LoadedCopy, type LoadedFork, type PlainKind, type RuntimeDeps, type StoredCopyResult } from "../runtime/loader.ts";
import { resolveCommit } from "../runtime/refs.ts";
import { openRepo } from "../runtime/repo-files.ts";
import type { RunTimeRecord } from "../durable/user-ledger.ts";
import { fleetStub, ledgerStub } from "../stubs.ts";
import { copyKey, errorText, startRotation, type RotateParams, type WorkflowBinding } from "../workflows/common.ts";
import { HttpError } from "./http.ts";
import { hasClinicalDose, markSafety, SAFETY_SIGNALS } from "./safety.ts";

/** The runtime, plus the rotate workflow, which a request tripping a fork's copy (on any ref) or a copy that no longer loads starts. */
export interface AskDeps extends RuntimeDeps {
	exports: RuntimeDeps["exports"] & { RotateWorkflow: WorkflowBinding<RotateParams> };
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
	/** On a re-ask (override or attestation), the first answer of the same question; recorded as reask_of. */
	reaskOf?: string;
}

/** What answered: the fork or stock, under which ref, and the safety fallback that sent the ask to stock. */
interface Served {
	repo: string;
	ref: string;
	fallback: SafetyFallback | null;
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
	const { repo, ref, request, useModel } = input;
	// Safety fallback (spec 7): after a safety release's grace period, a fork still pinned below it is
	// answered by stock at that release (production only: main). The card carries a visible signal.
	// askState also returns the fork's verified renamed copy, which guards every ref, in the same call.
	const state = repo !== STOCK_REPO ? await fleetStub(deps.env).askState(repo) : null;
	const fallback = input.fallback ? (state?.fallback ?? null) : null;
	if (fallback) {
		const result = await askFork(deps, { repo: STOCK_REPO, ref: fallback.tag, request, useModel });
		const card = markSafety(result.card, SAFETY_SIGNALS.stockFallback, `Safety fallback: the grace period of stock ${fallback.tag} ended ${fallback.graceUntil.slice(0, 10)} and this fork is still pinned to ${fallback.from}, so stock ${fallback.tag} answered. Apply the open repair or upgrade to use your customizations again.`);
		return deliver(deps, input, { ...result, card, variant: null }, { repo: STOCK_REPO, ref: fallback.tag, fallback });
	}
	return deliver(deps, input, await askOwnFork(deps, { repo, ref, request, useModel, copy: state?.morph ?? null }), { repo, ref, fallback: null });
}

/**
 * The yellow soak's ask: the commit exactly as built, with no renamed copy
 * and no tripwire scan, then the same dose backstop and ledger record as
 * every ask. The soak checks the commit that landed, while Fleet may still
 * hold the previous commit's copy, whose names could refuse the new commit's
 * own scenarios. It is an entry point of its own, so that no input of
 * serveAsk can switch the guard off.
 */
export async function serveAskAsBuilt(deps: RuntimeDeps, input: Omit<ServeAskInput, "fallback">): Promise<ServedCard> {
	const result = await askFork(deps, { repo: input.repo, ref: input.ref, request: input.request, useModel: input.useModel });
	return deliver(deps, input, { ...result, variant: null }, { repo: input.repo, ref: input.ref, fallback: null });
}

/**
 * What every answer goes through on its way out: the dose backstop, the
 * ledger record (with reask_of, and the copy's variant when a copy answered),
 * and the response's fork wrapper.
 */
async function deliver(deps: RuntimeDeps, input: Omit<ServeAskInput, "fallback">, answered: Answer, servedFirst: Served): Promise<ServedCard> {
	const { env } = deps;
	const { repo, request, useModel } = input;
	let result = answered;
	let card = answered.card;
	let served = servedFirst;
	// Backstop: no answer with a computed clinical dose is ever served, whatever the fork's code does.
	if (hasClinicalDose(card)) {
		if (served.repo === STOCK_REPO) throw new Error("stock answered a clinical card with a computed dose");
		const pinned = (await fleetStub(env).get(repo))?.pinnedTag ?? (await currentStockTag(env));
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
 * guarded on every ref: a request reaches the fork only past the stored
 * copy's guard (enforceGuard). At the copy's commit the copy itself answers,
 * with the model off: useModel comes from the request, so serving the plain
 * fork for it would let any request bypass the copy, and the gate verified
 * the copy with the model off. The model stays off there when the copy did
 * not load and the guard lets the plain fork answer instead. At any other
 * commit (another branch or tag, or main before the rotation of the commit
 * it moved to stores a copy) the plain fork answers as before, model and
 * all. A fork with no copy, or a platform without a secret, answers plain as
 * before.
 */
async function askOwnFork(deps: AskDeps, input: { repo: string; ref: string; request: Record<string, unknown>; useModel: boolean; copy: MorphState | null }): Promise<Answer> {
	const { repo, ref, request, copy } = input;
	if (copy === null || polymorphSecret(deps.env) === null) return { ...(await askFork(deps, { repo, ref, request, useModel: input.useModel })), variant: null };
	// Resolved once: every load below takes this commit, so a push landing now cannot slip another commit under the check.
	const commit = await commitOf(deps.env, repo, ref);
	const atCopy = commit === copy.sha;
	// At the copy's commit the copy loads and answers; at another commit it is only made (from the cache once made), for its names.
	const loaded = atCopy ? await loadForkRuntime(deps, repo, ref, { commit, useModel: false, morph: storedCopy(copy) }) : null;
	const guard = loaded ? fromLoaded(loaded) : await buildStoredCopy(deps, repo, copy);
	await enforceGuard(deps, repo, request, copy, guard);
	const useModel = atCopy ? false : input.useModel;
	const answering = loaded ?? (await loadForkRuntime(deps, repo, ref, { commit, useModel }));
	const card = await withTimeout(askLoaded(answering, request, { useModel }), FORK_CALL_TIMEOUT_MS, `fork ${repo} did not answer`);
	return { card, sha: answering.sha, ref: answering.ref, variant: answering.morph?.fingerprint ?? null };
}

/** The stored copy as a load at its commit made it: the copy, or why the plain fork loaded instead. */
function fromLoaded(loaded: LoadedFork): StoredCopyResult {
	// loadForkRuntime sets plain exactly when it loaded no copy.
	return loaded.morph ? { copy: loaded.morph, plain: null } : { copy: null, plain: loaded.plain! };
}

/**
 * What the live path does when a fork's stored copy did not load, by the
 * kind of reason. "retry": refuse the request as retryable, since the plain
 * fork answering unchecked would let a request reach the original names
 * whenever Artifacts errs. "rotate": let the plain fork answer and start one
 * rotation of the stored copy, for a reason that will not pass by itself (the
 * secret changed, the copy would rename other names, the renamer refuses the
 * code now). "plain": let the plain fork answer, for a fork the platform
 * makes no copy of, which no rotation changes.
 */
export function onCopyFailure(kind: PlainKind): "retry" | "rotate" | "plain" {
	if (kind === "transient") return "retry";
	if (kind === "none") return "plain";
	return "rotate";
}

/**
 * Lets a request through to the fork only past the stored copy's guard: when
 * the copy was made, the request must pass its tripwires (checkTripwires);
 * when it was not, onCopyFailure says whether to refuse it as retryable, or to
 * let it through, after starting one rotation of the stored copy or not.
 */
async function enforceGuard(deps: AskDeps, repo: string, request: Record<string, unknown>, stored: MorphState, guard: StoredCopyResult): Promise<void> {
	if (guard.copy) return checkTripwires(deps, repo, request, guard.copy);
	const action = onCopyFailure(guard.plain.kind);
	if (action === "retry") throw new HttpError(503, COPY_RETRY, {}, { "retry-after": String(COPY_RETRY_AFTER_SECONDS) });
	if (action === "rotate") await startRotation(deps.env, deps.exports.RotateWorkflow, { repo, reason: "mismatch", key: copyKey(stored) });
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

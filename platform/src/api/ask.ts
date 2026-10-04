// The platform's ask path, shared by POST /api/ask and the yellow soak's
// end-to-end host: ask the fork (or stock after a safety grace period), refuse
// any clinical card with a computed dose, and append the answer's run-time
// record to the given user's ledger.
import { currentStockTag } from "../forks/provision.ts";
import { STOCK_REPO } from "../lib/names.ts";
import { askFork, type AnswerCardLike, type RuntimeDeps } from "../runtime/loader.ts";
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
	/** Apply the safety fallback (production main only). */
	fallback: boolean;
}

export type ServedCard = AnswerCardLike & { fork: Record<string, unknown> };

export async function serveAsk(deps: RuntimeDeps, input: ServeAskInput): Promise<ServedCard> {
	const { env } = deps;
	const { repo, ref, request, useModel } = input;
	const fleet = fleetStub(env);
	// Safety fallback (spec 7): after a safety release's grace period, a fork still pinned below it is
	// answered by stock at that release (production only: main). The card carries a visible signal.
	const fallback = input.fallback && repo !== STOCK_REPO ? await fleet.safetyFallback(repo) : null;
	let result = await askFork(deps, fallback ? { repo: STOCK_REPO, ref: fallback.tag, request, useModel } : { repo, ref, request, useModel });
	let card = fallback
		? markSafety(result.card, SAFETY_SIGNALS.stockFallback, `Safety fallback: the grace period of stock ${fallback.tag} ended ${fallback.graceUntil.slice(0, 10)} and this fork is still pinned to ${fallback.from}, so stock ${fallback.tag} answered. Apply the open repair or upgrade to use your customizations again.`)
		: result.card;
	let served = fallback ? { repo: STOCK_REPO, ref: fallback.tag, fallback } : { repo, ref, fallback: null };
	// Backstop: no answer with a computed clinical dose is ever served, whatever the fork's code does.
	if (hasClinicalDose(card)) {
		if (served.repo === STOCK_REPO) throw new Error("stock answered a clinical card with a computed dose");
		const pinned = (await fleet.get(repo))?.pinnedTag ?? (await currentStockTag(env));
		console.error(`safety guard: ${repo}@${result.sha.slice(0, 7)} answered a clinical card with a computed dose; serving stock ${pinned}`);
		result = await askFork(deps, { repo: STOCK_REPO, ref: pinned, request, useModel });
		card = markSafety(result.card, SAFETY_SIGNALS.clinicalDose, `Safety guard: this fork's answer computed a clinical dose, which the floor forbids, so stock ${pinned} answered instead.`);
		served = { repo: STOCK_REPO, ref: pinned, fallback: null };
	}
	await ledgerStub(env, input.userId).append(input.userId, repo, card.ledger as unknown as RunTimeRecord);
	return { ...card, fork: { repo, ref: result.ref, commit: result.sha, ...(served.repo !== repo ? { servedBy: { repo: served.repo, ref: served.ref } } : {}), ...(served.fallback ? { safetyFallback: served.fallback } : {}) } };
}

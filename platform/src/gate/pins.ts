// Pin rules for the gate (spec 7) and which gate errors are the fork's fault.
//
// - A fork's fluid.toml must pin a published stock release tag (vMAJOR.MINOR.PATCH).
//   Branch names, SHAs, and unpublished tags are refused, so the floor always
//   comes from a reviewed release.
// - In merge mode the pin never moves backward: it must be at least main's
//   pinned tag and at least the latest safety release.
// - Errors the fork caused (a missing ref, an unusable pin, code that does not
//   build) become gate failures. Every other error is infrastructure: the
//   workflow step rethrows it and retries instead of opening a repair.
import { compareTagsAsc } from "../durable/fleet.ts";
import { ForkCodeError } from "../runtime/modules.ts";
import { RefNotFoundError } from "../runtime/refs.ts";

export { ForkCodeError };

export const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

export function isReleaseTag(tag: unknown): tag is string {
	return typeof tag === "string" && RELEASE_TAG_PATTERN.test(tag);
}

export function latestSafetyTag(releases: { tag: string; safety: boolean }[]): string | null {
	const safety = releases.filter((r) => r.safety && isReleaseTag(r.tag)).map((r) => r.tag).sort(compareTagsAsc);
	return safety[safety.length - 1] ?? null;
}

export type PinCheck = { ok: true; floor: string | null } | { ok: false; floor: string; reason: string };

/** Pin monotonicity for merge mode: pinned >= main's pin and >= the latest safety release. */
export function checkPin(input: { pinned: string; mainPin: string | null; releases: { tag: string; safety: boolean }[] }): PinCheck {
	const safety = latestSafetyTag(input.releases);
	const mainPin = isReleaseTag(input.mainPin) ? input.mainPin : null;
	const candidates = [mainPin, safety].filter((t): t is string => t !== null).sort(compareTagsAsc);
	const floor = candidates[candidates.length - 1] ?? null;
	if (floor === null || compareTagsAsc(input.pinned, floor) >= 0) return { ok: true, floor };
	if (mainPin && compareTagsAsc(input.pinned, mainPin) < 0) {
		return { ok: false, floor, reason: `stock_tag ${input.pinned} is older than main's ${mainPin}; a pin never moves backward` };
	}
	return { ok: false, floor, reason: `stock_tag ${input.pinned} is below the latest safety release ${safety}; upgrade first` };
}

/** fluid.toml names something that is not a published stock release. */
export class StockTagError extends Error {
	constructor(
		readonly tag: string,
		reason: string,
	) {
		super(`stock_tag ${JSON.stringify(tag)}: ${reason}`);
		this.name = "StockTagError";
	}
}

export function isForkCaused(error: unknown): boolean {
	return error instanceof RefNotFoundError || error instanceof StockTagError || error instanceof ForkCodeError;
}

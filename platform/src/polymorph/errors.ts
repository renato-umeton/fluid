// Why a fork cannot run as a renamed copy. Everything that stops a copy is
// thrown as one of these errors, and each kind of reason decides what the
// platform does next (LoadedFork.plain): the loader runs the plain fork and
// says why, and the live path and rotations act on the kind.

/**
 * Why a fork loaded plain rather than as a renamed copy:
 * - "none": no copy was asked for, or the platform makes none for this fork
 *   (no secret, or its pinned release publishes no list);
 * - "mismatch": the copy asked for is not the one this load makes (another
 *   commit, fingerprint, or names hash), so it is not the copy a gate verified;
 * - "transient": a read the copy needs failed (Artifacts), and the same load
 *   may make it a moment later;
 * - "unavailable": no copy can be made of this code (the renamer cannot read
 *   it, a candidate's extra files), or the fork's pin or upstream's list is
 *   broken.
 */
export type PlainKind = "none" | "mismatch" | "transient" | "unavailable";

/**
 * This fork cannot be renamed safely: the renamer cannot read its code (a
 * module sucrase does not parse or that nests deeper than the parser's stack,
 * more code than the renamer reads), the parser no longer reads code the way
 * the renamer relies on, or the fork's pin or upstream's list is broken.
 * Callers run the plain fork and log the reason, so a fork's owner only ever
 * sees the errors that loading already reports.
 */
export class PolymorphUnavailableError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "PolymorphUnavailableError";
	}
}

/**
 * The platform makes no copy of this fork: it has no secret, or the release
 * the fork pins names no list (fluid.toml names no tag, or that release
 * publishes none). The fork runs plain, as every fork did before copies.
 */
export class PolymorphOffError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PolymorphOffError";
	}
}

/**
 * A read that a copy needs failed: Artifacts erred while the platform read
 * upstream's list or the fork's contract. Nothing is known to be wrong with
 * the fork or the list, and the same load may make the copy a moment later.
 * The message is the failed read's own.
 */
export class PolymorphTransientError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "PolymorphTransientError";
	}
}

/** The copy asked for is not the one this load makes, so it is not the copy a gate verified. */
export class CopyMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CopyMismatchError";
	}
}

/**
 * The kind of reason an error that stopped a copy gives. An error of none of
 * these classes is a bug: it counts as unavailable, so the fork still runs
 * plain, and it is logged as an error, with its stack, every time.
 */
export function plainKindOf(error: unknown): PlainKind {
	if (error instanceof PolymorphTransientError) return "transient";
	if (error instanceof CopyMismatchError) return "mismatch";
	if (error instanceof PolymorphOffError) return "none";
	if (error instanceof PolymorphUnavailableError) return "unavailable";
	console.error(`polymorph: an unexpected error stopped a copy, so the fork runs plain: ${error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)}`);
	return "unavailable";
}

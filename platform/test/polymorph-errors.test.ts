// Every reason a fork cannot run as a renamed copy is thrown as one of the
// polymorph errors, and each maps to one kind of plain load (LoadedFork.plain).
// An error of no polymorph class is a bug: the fork still runs plain, and the
// platform says so as an error.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyMismatchError, plainKindOf, PolymorphOffError, PolymorphTransientError, PolymorphUnavailableError } from "../src/polymorph/errors.ts";
import * as install from "../src/polymorph/install.ts";
import * as tokens from "../src/polymorph/tokens.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("plainKindOf", () => {
	it.each([
		["a failed read", new PolymorphTransientError("Artifacts: 503 service unavailable"), "transient"],
		["a copy that is not the verified one", new CopyMismatchError("the copy is only for commit fffffff"), "mismatch"],
		["no secret or no list", new PolymorphOffError("POLYMORPH_SECRET is not set"), "none"],
		["code the renamer cannot read", new PolymorphUnavailableError("app/big.js: polymorph: the module has 300000 characters"), "unavailable"],
	] as const)("maps %s to %s, quietly", (_case, error, kind) => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(plainKindOf(error)).toBe(kind);
		expect(logged).not.toHaveBeenCalled();
	});

	it("maps an error of no polymorph class, a bug, to unavailable, and logs it as an error with its stack", () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(plainKindOf(new TypeError("cannot read properties of undefined"))).toBe("unavailable");
		expect(logged).toHaveBeenCalledTimes(1);
		expect(String(logged.mock.calls[0]![0])).toMatch(/^polymorph: an unexpected error stopped a copy, so the fork runs plain: TypeError: cannot read properties of undefined\n\s+at /);
	});

	it("keeps the old import paths of the error classes working", () => {
		expect([tokens.PolymorphUnavailableError, install.PolymorphOffError, install.PolymorphTransientError]).toEqual([PolymorphUnavailableError, PolymorphOffError, PolymorphTransientError]);
	});
});

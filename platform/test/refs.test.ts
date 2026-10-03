import { describe, expect, it } from "vitest";
import { InvalidRefError, RefNotFoundError, isSha, resolveCommit, shortRef } from "../src/runtime/refs.ts";

const SHA = "51e4fce944f2e5d131e3e6b7b8457ecc3a34e6a2";

function fakeRepo(refs: Record<string, string>) {
	const calls: string[] = [];
	return {
		calls,
		async log({ ref }: { ref: string; limit: number }) {
			calls.push(ref);
			return refs[ref] ? [{ hash: refs[ref]! }] : [];
		},
	};
}

describe("shortRef", () => {
	it.each([
		["main", "main"],
		["refs/heads/main", "main"],
		["refs/tags/v1.0.0", "v1.0.0"],
		["refs/heads/repair/v1.1.0", "repair/v1.1.0"],
		["v1.0.0", "v1.0.0"],
	])("%s -> %s", (input, expected) => {
		expect(shortRef(input)).toBe(expected);
	});

	it("rejects other full refs", () => {
		expect(() => shortRef("refs/remotes/origin/main")).toThrow(/unsupported ref/);
	});

	it("rejects ref syntax the binding cannot take", () => {
		expect(() => shortRef("main..other")).toThrow(/invalid ref/);
	});

	it("rejects an empty ref", () => {
		expect(() => shortRef(" ")).toThrow(/non-empty/);
	});

	it("throws InvalidRefError so callers can answer 400", () => {
		expect(() => shortRef("main..other")).toThrow(InvalidRefError);
	});
});

describe("resolveCommit", () => {
	it("returns a SHA after checking the repo has that commit", async () => {
		const repo = fakeRepo({ [SHA]: SHA });
		expect(await resolveCommit(repo, SHA)).toBe(SHA);
		expect(repo.calls).toEqual([SHA]);
	});

	it("throws RefNotFoundError for a SHA the repo does not have", async () => {
		await expect(resolveCommit(fakeRepo({}), SHA)).rejects.toBeInstanceOf(RefNotFoundError);
	});

	it("throws RefNotFoundError when the binding fails to read the ref", async () => {
		const repo = { log: async () => Promise.reject(new Error("object not found")) };
		await expect(resolveCommit(repo, SHA)).rejects.toBeInstanceOf(RefNotFoundError);
	});

	it("resolves a full tag ref through log with the short name", async () => {
		const repo = fakeRepo({ "v1.0.0": SHA });
		expect(await resolveCommit(repo, "refs/tags/v1.0.0")).toBe(SHA);
		expect(repo.calls).toEqual(["v1.0.0"]);
	});

	it("throws RefNotFoundError for an unknown ref", async () => {
		await expect(resolveCommit(fakeRepo({}), "nope")).rejects.toBeInstanceOf(RefNotFoundError);
	});

	it("recognizes SHAs", () => {
		expect([isSha(SHA), isSha("main"), isSha(SHA.toUpperCase())]).toEqual([true, false, false]);
	});
});

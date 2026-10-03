import { describe, expect, it } from "vitest";
import { acceptModelResolutions, fallbackResolution } from "../src/agents/merge-resolve.ts";
import type { BuildTimeIntent } from "../src/forks/provision.ts";
import { checkoutBranch, commitChanges, initRepo, listTrackedFiles, mergeWithResolver, readWorkspaceFile, writeFiles, type ConflictVersions } from "../src/git/ops.ts";

const intent = (id: string, files: string[], agent = "customization-agent"): BuildTimeIntent => ({ id, author: "user:x", agent, request: "r", purpose: `purpose of ${id}`, modes_affected: [], files, tests_added: [], stock_tag: "v1.1.0" });
const v = (path: string, ours: string | null, theirs: string | null): ConflictVersions => ({ path, base: "base\n", ours, theirs, marked: null });

describe("fallbackResolution", () => {
	it("keeps the fork's version of a file an intent record lists", () => {
		const r = fallbackResolution(v("app/cards.ts", "fork\n", "stock\n"), [intent("int_a", ["app/cards.ts"])], "v1.2.0");
		expect(r).toMatchObject({ choice: "ours", content: "fork\n", intentIds: ["int_a"], by: "fallback" });
		expect(r.reason).toContain("int_a");
	});

	it("takes stock's version when no intent claims the file", () => {
		expect(fallbackResolution(v("app/cards.ts", "fork\n", "stock\n"), [intent("int_a", ["connectors/redcap.ts"])], "v1.2.0")).toMatchObject({ choice: "theirs", content: "stock\n" });
	});

	it("ignores onboarding records", () => {
		expect(fallbackResolution(v("app/cards.ts", "fork\n", "stock\n"), [intent("int_o", ["app/cards.ts"], "onboarding")], "v1.2.0").choice).toBe("theirs");
	});

	it("keeps the fork's fluid.toml with the new stock tag", () => {
		const r = fallbackResolution(v("fluid.toml", 'stock_tag = "v1.1.0"\n[thresholds]\ntau = 0.9\n', 'stock_tag = "v1.2.0"\n[thresholds]\ntau = 0.85\n'), [], "v1.2.0");
		expect(r.content).toBe('stock_tag = "v1.2.0"\n[thresholds]\ntau = 0.9\n');
	});
});

describe("acceptModelResolutions", () => {
	const versions = [v("app/cards.ts", "export const a = 1;\n", "export const a = 2;\n"), v("app/body.ts", "x\n", "y\n")];

	it("accepts a merged file that parses", () => {
		const out = acceptModelResolutions({ resolutions: [{ path: "app/cards.ts", choice: "merged", content: "export const a = 3;\n", reason: "both" }] }, versions, [], "v1.2.0");
		expect(out[0]).toMatchObject({ choice: "merged", by: "model" });
		expect(out[1]).toMatchObject({ choice: "theirs", by: "fallback" });
	});

	it("falls back when merged TypeScript does not parse or keeps markers", () => {
		expect(acceptModelResolutions({ resolutions: [{ path: "app/cards.ts", choice: "merged", content: "export const = ;", reason: "x" }] }, versions, [], "v1.2.0")[0]!.by).toBe("fallback");
		expect(acceptModelResolutions({ resolutions: [{ path: "app/cards.ts", choice: "merged", content: "<<<<<<< ours\na\n=======\nb\n>>>>>>> x\n", reason: "x" }] }, versions, [], "v1.2.0")[0]!.by).toBe("fallback");
	});
});

describe("mergeWithResolver", () => {
	it("keeps git's clean merges and applies resolutions to conflicted paths", async () => {
		const ws = await initRepo();
		await writeFiles(ws, { "a.txt": "line1\nline2\nline3\n", "b.txt": "1\n2\n3\n4\n5\n6\n7\n8\n" });
		await commitChanges(ws, { message: "base" });
		await checkoutBranch(ws, "stock", { create: true });
		await writeFiles(ws, { "a.txt": "STOCK\nline2\nline3\n", "b.txt": "1\n2\n3\n4\n5\n6\n7\nstock8\n", "c.txt": "new from stock\n" });
		await commitChanges(ws, { message: "stock change" });
		await checkoutBranch(ws, "main");
		await checkoutBranch(ws, "upgrade/v2", { create: true });
		await writeFiles(ws, { "a.txt": "FORK\nline2\nline3\n", "b.txt": "fork1\n2\n3\n4\n5\n6\n7\n8\n" });
		await commitChanges(ws, { message: "fork change" });

		const seen: string[] = [];
		const result = await mergeWithResolver(ws, {
			ours: "upgrade/v2",
			theirs: "stock",
			message: "Merge stock",
			resolve: async (versions) => {
				seen.push(...versions.map((x) => x.path));
				expect(versions[0]).toMatchObject({ ours: "FORK\nline2\nline3\n", theirs: "STOCK\nline2\nline3\n", base: "line1\nline2\nline3\n" });
				return { "a.txt": versions[0]!.ours };
			},
		});
		expect(result.ok).toBe(true);
		expect(seen).toEqual(["a.txt"]);
		expect(await readWorkspaceFile(ws, "a.txt")).toBe("FORK\nline2\nline3\n");
		expect(await readWorkspaceFile(ws, "b.txt")).toBe("fork1\n2\n3\n4\n5\n6\n7\nstock8\n");
		const tracked = await listTrackedFiles(ws, "upgrade/v2");
		expect(tracked.sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
	});
});

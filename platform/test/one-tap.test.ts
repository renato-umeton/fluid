// One-tap approval of a gated upgrade: main fast-forwards to the pending
// commit on the branch the upgrade gated, upgrade/<tag> or replay/<tag>.
import { describe, expect, it } from "vitest";
import { directGateRefusal } from "../src/events/filter.ts";
import { fastForwardToPending, pendingBranch } from "../src/forks/one-tap.ts";
import { checkoutBranch, commitChanges, headCommit, initRepo, writeFiles } from "../src/git/ops.ts";

describe("pendingBranch", () => {
	it("uses the branch the upgrade recorded, and upgrade/<tag> for older rows", () => {
		expect(pendingBranch({ tag: "v1.2.0", branch: "replay/v1.2.0" })).toBe("replay/v1.2.0");
		expect(pendingBranch({ tag: "v1.2.0" })).toBe("upgrade/v1.2.0");
	});
});

describe("fastForwardToPending", () => {
	it("fetches replay/<tag> and fast-forwards main to the replayed merge commit", async () => {
		const ws = await initRepo();
		await writeFiles(ws, { "a.txt": "stock\n" });
		const main = await commitChanges(ws, { message: "main" });
		await checkoutBranch(ws, "replay/v1.2.0", { create: true });
		await writeFiles(ws, { "a.txt": "replayed\n" });
		const replayHead = await commitChanges(ws, { message: "replay head" });
		const merge = await commitChanges(ws, { message: "upgrade by replay", parents: [main, replayHead] });
		await checkoutBranch(ws, "main");
		const fetched: string[] = [];
		const out = await fastForwardToPending(ws, { tag: "v1.2.0", commit: merge, branch: "replay/v1.2.0" }, async (b) => {
			fetched.push(b);
		});
		expect(fetched).toEqual(["replay/v1.2.0"]);
		expect(out).toEqual({ branch: "replay/v1.2.0", previous: main, outcome: "fast-forward", oid: merge });
		expect(await headCommit(ws, "main")).toBe(merge);
	});
});

describe("directGateRefusal", () => {
	it("refuses main, upgrade, and replay branches; allows work branches", () => {
		expect(directGateRefusal("main")).toMatch(/own workflows/);
		expect(directGateRefusal("upgrade/v1.2.0")).toMatch(/own workflows/);
		expect(directGateRefusal("replay/v1.2.0")).toMatch(/own workflows/);
		expect(directGateRefusal("work/redcap")).toBeNull();
	});
});

import { describe, expect, it } from "vitest";
import { contestJoinRefusal, joinContest } from "../src/contest/join.ts";
import { runsStub } from "../src/stubs.ts";
import { apiEnv, workerContext } from "./helpers/api-env.ts";

const FORK = "user-s-1a2b";
const ID = "1a2b3c4d5e6f";
const RUN = `run_contest_${ID}`;
const SHA = "c".repeat(40);

async function setup(over: Record<string, unknown> = {}) {
	const t = { ...apiEnv(), ...workerContext() };
	t.fleet.openContest(FORK, { contestId: ID, runId: RUN, status: "open", includeAgent: true, joinUntil: new Date(Date.now() + 60_000).toISOString(), agentJoined: false, ...over });
	await runsStub(t.env, RUN).create({ id: RUN, kind: "contest", repo: FORK, status: "running", fields: { contestants: [{ label: "model-a", status: "planning" }, { label: "agent", status: "waiting for your push" }] } });
	return t;
}

describe("contestJoinRefusal", () => {
	it("lets an ordinary inbox branch through", async () => {
		const t = await setup();
		expect(await contestJoinRefusal(t.env, FORK, "work/my-change")).toBeNull();
	});

	it("refuses a contest branch when the contest is not open, before anything is imported", async () => {
		const t = await setup({ status: "evaluating" });
		expect(await contestJoinRefusal(t.env, FORK, `work/contest-${ID}/mine`)).toMatch(/window closed/);
		expect(await contestJoinRefusal(t.env, FORK, "work/contest-ffffffffffff/mine")).toMatch(/no open contest/);
	});
});

describe("joinContest", () => {
	it("takes the agent seat, records the entry, and wakes the contest", async () => {
		const t = await setup();
		const out = await joinContest(t.env, t.ctx, { fork: FORK, branch: `work/inbox/contest-${ID}/mine`, commit: SHA, importRunId: "run_import_x" });
		expect(out).toEqual({ ok: true, runId: RUN });
		const run = await runsStub(t.env, RUN).get();
		expect((run!.contestants as Record<string, unknown>[]).find((c) => c.label === "agent")).toMatchObject({ status: "joined", branch: `work/inbox/contest-${ID}/mine`, commit: SHA, importRunId: "run_import_x" });
		expect(t.sent).toEqual([{ workflow: "ContestWorkflow", id: RUN, event: { type: "contest-joined", payload: { branch: `work/inbox/contest-${ID}/mine`, commit: SHA } } }]);
	});

	it("lets only one entry join", async () => {
		const t = await setup();
		await joinContest(t.env, t.ctx, { fork: FORK, branch: `work/inbox/contest-${ID}/one`, commit: SHA, importRunId: "run_import_1" });
		const second = await joinContest(t.env, t.ctx, { fork: FORK, branch: `work/inbox/contest-${ID}/two`, commit: SHA, importRunId: "run_import_2" });
		expect(second).toMatchObject({ ok: false, reason: expect.stringMatching(/already joined/) });
		expect(t.sent).toHaveLength(1);
	});
});

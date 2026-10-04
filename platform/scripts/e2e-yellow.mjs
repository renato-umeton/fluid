// Yellow to green end-to-end scenario against a running platform (local dev or deployed):
//   1. provision a fork (it starts green: no history)
//   2. a good change (UI preferences, with its suggested tier 3 test and end-to-end scenario accepted)
//      passes the gate, goes live in yellow, and turns green after 3 soak passes
//   3. a bad change (the admin-only test recipe: every ledger record names a constant fork commit)
//      passes tiers 1 to 3, goes live in yellow, fails the end-to-end suite, and main rolls back to the
//      last green commit with a new revert commit; a repair opens linked to the change's intent record
//   4. applying that repair goes through the gate and yellow again (main moved, so the gate merges main
//      into the repair branch first) and turns green
//   5. clean up the fork
// Usage: FLUID_URL=http://localhost:5173 ADMIN_TOKEN=... node scripts/e2e-yellow.mjs [--keep] [--no-apply]
const base = process.env.FLUID_URL ?? "http://localhost:5173";
const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) {
	console.error("e2e-yellow: set ADMIN_TOKEN in the environment");
	process.exit(2);
}
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const applyRepair = !args.includes("--no-apply");
const admin = { "x-fluid-admin": adminToken };
let cookie = "";
let failures = 0;
const timings = {};
const started = Date.now();

async function call(method, path, body, headers = {}) {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const setCookie = res.headers.get("set-cookie");
	if (setCookie) cookie = setCookie.split(";")[0];
	const data = await res.json().catch(() => null);
	if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data?.error ?? ""}`);
	return data;
}

function check(label, ok, detail = "") {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
	return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (sha) => (typeof sha === "string" ? sha.slice(0, 7) : String(sha));

async function waitFor(label, fn, { timeoutMs = 600_000, everyMs = 2000 } = {}) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const value = await fn();
		if (value) return value;
		await sleep(everyMs);
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function timed(name, fn) {
	const t0 = Date.now();
	try {
		return await fn();
	} finally {
		timings[name] = `${((Date.now() - t0) / 1000).toFixed(1)} s`;
	}
}

const runOf = (id) => call("GET", `/api/runs/${id}`, undefined, admin);
const isFinal = (run) => ["passed", "failed", "cancelled"].includes(run.status);
const health = (repo) => call("GET", `/api/forks/${repo}/health`);

async function customize(repo, request, headers = {}) {
	const { runId } = await call("POST", "/api/customize", { repo, request }, headers);
	const waiting = await waitFor(`suggestions for ${runId}`, async () => {
		const run = await runOf(runId);
		if (isFinal(run)) return run;
		return run.status === "waiting" && run.suggestions?.length ? run : null;
	});
	if (waiting.status === "waiting") {
		for (const s of waiting.suggestions) await call("POST", `/api/suggestions/${runId}/decide`, { testId: s.id, decision: "accept" }, headers);
	}
	const final = await waitFor(`final status of ${runId}`, async () => {
		const run = await runOf(runId);
		return isFinal(run) ? run : null;
	});
	return { runId, suggestions: waiting.suggestions ?? [], run: final };
}

/** Follows a gate run through any re-gate (main moved) to the run that decided. */
async function finalGate(runId) {
	let run = await waitFor(`gate ${runId}`, async () => {
		const r = await runOf(runId);
		return isFinal(r) ? r : null;
	});
	while (typeof run.regateRunId === "string") {
		const next = run.regateRunId;
		run = await waitFor(`gate ${next}`, async () => {
			const r = await runOf(next).catch(() => null);
			return r && isFinal(r) ? r : null;
		});
	}
	return run;
}

async function waitYellow(runId) {
	return waitFor(`yellow run ${runId}`, async () => {
		const run = await runOf(runId).catch(() => null);
		return run && isFinal(run) ? run : null;
	});
}

function scenarioSummary(run) {
	const last = [...(run.passes ?? [])].sort((a, b) => b.pass - a.pass)[0];
	return (last?.tiers ?? []).map((t) => `${t.tier} ${t.total - t.skipped - t.failed}/${t.total - t.skipped}${t.skipped ? ` (+${t.skipped} skipped)` : ""}`).join(", ");
}

let repo = null;
try {
	await call("POST", "/api/session", { persona: "hospitalist-researcher" });
	const fork = await timed("provision fork", () => call("POST", "/api/forks", {}, admin));
	repo = fork.repo;
	console.log(`fork ${repo} on ${fork.stockTag}`);
	const h0 = await health(repo);
	check("a fork with no history starts green", h0.health.health === "green", JSON.stringify({ health: h0.health.health, lastGreen: h0.health.lastGreenCommit }));
	const start = await call("GET", `/api/forks/${repo}`);

	// Good change: yellow, then green after three passes.
	const goodT0 = Date.now();
	const good = await timed("good change: request to merged (gate, includes test decisions)", () => customize(repo, "Use Palatino fonts and add a tab with charts"));
	check("good change: gate passed and main fast-forwarded", good.run.status === "passed" && good.run.gate?.passed === true, `${good.run.branch} at ${short(good.run.commit)}`);
	check("good change: the suggester proposed an end-to-end scenario, reviewed like tier 3", good.suggestions.some((s) => s.kind === "e2e" && s.file === "tests/user/e2e.json"), good.suggestions.map((s) => `${s.kind}:${s.id}`).join(", "));
	const goodYellowId = good.run.yellow?.runId ?? good.run.yellowRunId;
	check("good change: the customize run shows the yellow phase", typeof goodYellowId === "string", goodYellowId);
	const hYellow = await health(repo);
	check("good change: the fork is live in yellow (or already soaked)", ["yellow", "green"].includes(hYellow.health.health) && hYellow.health.commit === good.run.commit, `${hYellow.health.health} at ${short(hYellow.health.commit)}, last green ${short(hYellow.health.lastGreenCommit)}`);
	check("good change: the last green commit is main before the change", hYellow.health.lastGreenCommit === start.head || hYellow.health.lastGreenCommit === good.run.commit, `${short(hYellow.health.lastGreenCommit)} vs ${short(start.head)}`);
	const goodYellow = await timed("good change: yellow soak to green (3 passes)", () => waitYellow(goodYellowId));
	timings["good change: landed to green"] = `${((Date.now() - goodT0) / 1000).toFixed(1)} s from request`;
	check("good change: the soak passed 3 times", goodYellow.status === "passed" && (goodYellow.passes ?? []).length === 3 && goodYellow.passes.every((p) => p.passed), scenarioSummary(goodYellow));
	check("good change: the stock suite ran from the pinned tag", (goodYellow.passes?.[0]?.tiers ?? []).some((t) => t.tier === "stock" || t.tier === "platform"), `runner ${goodYellow.passes?.[0]?.runner}, stock ${goodYellow.passes?.[0]?.stockTag}`);
	check("good change: the accepted user scenario ran as the user tier", (goodYellow.passes?.[0]?.tiers ?? []).some((t) => t.tier === "user" && t.scenarios.some((s) => s.id.includes("e2e-ui-preferences-live") && s.passed)), scenarioSummary(goodYellow));
	console.log(`browser tier: ${goodYellow.browser?.status}: ${goodYellow.browser?.detail}`);
	for (const c of goodYellow.browser?.checks ?? []) console.log(`  ${c.passed ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
	check("good change: the browser tier ran once and reported", ["passed", "unavailable", "skipped"].includes(goodYellow.browser?.status), `${goodYellow.browser?.status}`);
	const hGreen = await health(repo);
	check("good change: the fork is green with the change as last green commit", hGreen.health.health === "green" && hGreen.health.lastGreenCommit === good.run.commit, `${hGreen.health.health}, last green ${short(hGreen.health.lastGreenCommit)}`);
	const me = await call("GET", "/api/me");
	const own = await call("GET", `/api/ledger/${me.userId}`);
	check("the soak never wrote to the real user's ledger", Array.isArray(own) && own.length === 0, `${own.length} records`);

	// Bad change: passes tiers 1 to 3, fails end to end, rolls back.
	const badT0 = Date.now();
	const bad = await timed("bad change: request to merged (gate)", () => customize(repo, "[admin test] break ledger fork_commit", admin));
	check("bad change: tiers 1 to 3 passed and main fast-forwarded", bad.run.status === "passed" && bad.run.gate?.passed === true, ["invariant", "functional", "user"].map((t) => `${t} ${bad.run.gate?.tiers?.[t]?.total - bad.run.gate?.tiers?.[t]?.failed}/${bad.run.gate?.tiers?.[t]?.total}`).join(", "));
	const badYellowId = bad.run.yellow?.runId ?? bad.run.yellowRunId;
	const badYellow = await timed("bad change: yellow to rollback", () => waitYellow(badYellowId));
	timings["bad change: landed to rolled back"] = `${((Date.now() - badT0) / 1000).toFixed(1)} s from request`;
	const failure = badYellow.failure ?? {};
	// Several scenarios read ledger records; the first one in suite order reports the wrong fork_commit.
	check("bad change: the soak failed on ledger provenance", badYellow.status === "failed" && /fork_commit/.test(String(failure.detail)) && /build-cache/.test(String(failure.detail)), `${failure.tier} ${failure.scenario} at step ${failure.step}: ${failure.detail}`);
	const hRolled = await health(repo);
	check("bad change: the fork is rolled back and keeps the last green commit", hRolled.health.health === "rolled_back" && hRolled.health.lastGreenCommit === good.run.commit && hRolled.health.rolledBackFrom === bad.run.commit, `${hRolled.health.health}; last green ${short(hRolled.health.lastGreenCommit)}; rolled back from ${short(hRolled.health.rolledBackFrom)}`);
	const afterRollback = await call("GET", `/api/forks/${repo}`);
	check("bad change: main is a new revert commit (history kept, no force push)", afterRollback.head === badYellow.revertCommit && afterRollback.head !== good.run.commit && afterRollback.head !== bad.run.commit, `main ${short(afterRollback.head)}, revert ${short(badYellow.revertCommit)}`);
	const intents = await call("GET", `/api/intents/${repo}`);
	const rollbackIntent = intents.find((i) => i.agent === "yellow-rollback");
	check("bad change: a build-time intent record explains the rollback", Boolean(rollbackIntent) && rollbackIntent.relies_on?.includes(bad.run.intent?.id), `${rollbackIntent?.id} relies on ${rollbackIntent?.relies_on?.join(", ")}`);
	const card = await call("POST", "/api/ask", { repo, question: "Is Morphinex on formulary?", context: { documentType: "budget" } });
	check("bad change: the live fork records the right commit again", card.ledger?.fork_commit === afterRollback.head, `fork_commit ${short(card.ledger?.fork_commit)}`);
	const repair = await waitFor("repair", async () => {
		const r = await runOf(badYellow.repairRunId).catch(() => null);
		return r && r.status !== "running" ? r : null;
	});
	check("bad change: a repair opened, linked to the change's intent record", repair.branch?.startsWith("repair/") && repair.intentRefs?.includes(bad.run.intent?.id), `${repair.branch}; relies on ${repair.intentRefs?.join(", ")}`);
	const history = (await health(repo)).history.map((e) => e.event);
	check("health history records every transition", ["yellow", "green", "failed", "rolled_back"].every((e) => history.includes(e)), history.slice(0, 10).join(" < "));

	if (applyRepair) {
		const sha = repair.branch.slice("repair/".length);
		const applied = await timed("repair apply: gate and yellow to green", async () => {
			const res = await call("POST", `/api/forks/${repo}/repairs/${sha}/apply`, {}, admin);
			const gate = await finalGate(res.runId);
			const yellow = gate.yellowRunId ? await waitYellow(gate.yellowRunId) : null;
			return { gate, yellow };
		});
		check("repair apply: the gate merged and the change went through yellow", applied.gate.status === "passed" && typeof applied.gate.yellowRunId === "string", `${applied.gate.id} merged ${short(applied.gate.mergedCommit)}; yellow ${applied.gate.yellowRunId}`);
		check("repair apply: the soak turned the fork green", applied.yellow?.status === "passed", scenarioSummary(applied.yellow ?? {}));
		const hFinal = await health(repo);
		check("repair apply: green at the merged commit", hFinal.health.health === "green" && hFinal.health.lastGreenCommit === applied.gate.mergedCommit, `${hFinal.health.health} at ${short(hFinal.health.lastGreenCommit)}`);
	}
} catch (error) {
	failures++;
	console.error(`FAIL ${error.message}`);
} finally {
	if (repo && !keep) await call("POST", `/api/admin/forks/${repo}/delete`, {}, admin).then(() => console.log(`cleanup: deleted ${repo}`)).catch((e) => console.log(`cleanup failed: ${e.message}`));
	console.log("\nTimings:");
	for (const [name, value] of Object.entries(timings)) console.log(`  ${name}: ${value}`);
	console.log(`  total: ${((Date.now() - started) / 1000).toFixed(1)} s`);
	console.log(failures === 0 ? "\ne2e-yellow: all checks passed" : `\ne2e-yellow: ${failures} check(s) failed`);
	process.exit(failures === 0 ? 0 : 1);
}

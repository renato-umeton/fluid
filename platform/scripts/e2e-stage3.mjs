// Stage 3 end-to-end scenario against a running platform (local dev or deployed):
//   1. provision a research coordinator fork
//   2. REDCap customization: accept the suggested tests, gate passes, change merges, enrollment answers
//   3. lower-tau customization: the work branch fails inv-tau-config-floor, a repair linked to the
//      customization run opens, main untouched
//   4. seed a synthetic fleet pinned to the release before the demo tightening: every main passes its
//      own pinned floor, lowered-tau seeds sit on failed work branches with repairs, nothing on any
//      main serves a clinical dose
//   5. tag a new stock release that tightens the research floor (or, with --tag naming the latest
//      existing tag, re-run its fan-out without publishing), watch concurrent upgrades (fleet SSE):
//      the compact-research seeds fail only the new invariant and stay pinned with repair branches;
//      every landed upgrade soaks in yellow and turns green, and no good fork is rolled back;
//      applying one repair gates it and fast-forwards main to the new tag
//   6. harvester finds the REDCap cluster and drafts it in stock
//   7. clean up seeded forks and the scenario fork
// Usage: FLUID_URL=http://localhost:5173 ADMIN_TOKEN=... node scripts/e2e-stage3.mjs [--seed 30] [--tag v1.3.0] [--keep]
const base = process.env.FLUID_URL ?? "http://localhost:5173";
const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) {
	console.error("e2e-stage3: set ADMIN_TOKEN in the environment");
	process.exit(2);
}
const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(name);
	return i === -1 ? fallback : args[i + 1];
};
const seedCount = Number(opt("--seed", 30));
const keep = args.includes("--keep");
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

async function waitFor(label, fn, { timeoutMs = 300_000, everyMs = 1500 } = {}) {
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

const runOf = (id) => call("GET", `/api/runs/${id}`);
const isFinal = (run) => run.status === "passed" || run.status === "failed";

async function customize(repo, request, decide) {
	const { runId } = await call("POST", "/api/customize", { repo, request });
	const waiting = await waitFor(`suggestions for ${runId}`, async () => {
		const run = await runOf(runId);
		if (isFinal(run)) return run;
		return run.status === "waiting" && run.suggestions?.length ? run : null;
	});
	if (waiting.status === "waiting") {
		for (const s of waiting.suggestions) await call("POST", `/api/suggestions/${runId}/decide`, { testId: s.id, decision: decide(s) });
	}
	const final = await waitFor(`final status of ${runId}`, async () => {
		const run = await runOf(runId);
		return isFinal(run) ? run : null;
	});
	return { runId, suggestions: waiting.suggestions ?? [], run: final };
}

/** Follows the fleet SSE stream and records the largest number of forks upgrading or gating, and soaking in yellow, at once. */
function watchFleet() {
	const status = new Map();
	const health = new Map();
	const state = { maxInFlight: 0, maxYellow: 0, yellowAt: null, events: 0, at: null, stop: () => {} };
	const controller = new AbortController();
	state.stop = () => controller.abort();
	(async () => {
		const res = await fetch(`${base}/api/fleet/stream`, { signal: controller.signal });
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let index;
			while ((index = buffer.indexOf("\n\n")) !== -1) {
				const chunk = buffer.slice(0, index);
				buffer = buffer.slice(index + 2);
				const data = chunk.split("\n").find((l) => l.startsWith("data: "));
				if (!data) continue;
				const event = JSON.parse(data.slice(6));
				state.events++;
				if (event.type === "snapshot") for (const f of event.forks) (status.set(f.repo, f.status), health.set(f.repo, f.health?.health));
				if (event.type === "fork") (status.set(event.fork.repo, event.fork.status), health.set(event.fork.repo, event.fork.health?.health));
				if (event.type === "removed") (status.delete(event.repo), health.delete(event.repo));
				const yellow = [...health.values()].filter((h) => h === "yellow").length;
				if (yellow > state.maxYellow) {
					state.maxYellow = yellow;
					state.yellowAt = new Date().toISOString();
				}
				const inFlight = [...status.values()].filter((s) => s === "upgrading" || s === "gating").length;
				if (inFlight > state.maxInFlight) {
					state.maxInFlight = inFlight;
					state.at = new Date().toISOString();
				}
			}
		}
	})().catch((error) => {
		if (error.name !== "AbortError") console.warn(`fleet stream ended: ${error.message}`);
	});
	return state;
}

function nextMinor(tags) {
	const [maj, min] = tags[tags.length - 1].slice(1).split(".").map(Number);
	return `v${maj}.${min + 1}.0`;
}

let repo = null;
try {
	const fleet0 = await call("GET", "/api/fleet");
	check("stock v1.1.0 is published", fleet0.stockTags.includes("v1.1.0"), `tags ${fleet0.stockTags.join(", ")}`);

	await call("POST", "/api/session", { persona: "research-coordinator" });
	const fork = await timed("provision fork", () => call("POST", "/api/forks", {}, admin));
	repo = fork.repo;
	check("fork provisioned on the latest tag", fork.stockTag === fleet0.stockTags[fleet0.stockTags.length - 1], `${repo} on ${fork.stockTag}`);

	// REDCap customization.
	const redcap = await timed("REDCap customization (plan to merge, includes test decisions)", () =>
		customize(repo, "Add a REDCap connector so research mode reports enrollment for my protocols", () => "accept"),
	);
	check("REDCap: suggester proposed an enrollment test tied to the intent", redcap.suggestions.some((s) => s.id === `t-${redcap.run.intent?.id}-redcap-enrollment-irb-2026-0142` && s.intentId === redcap.run.intent?.id), redcap.suggestions.map((s) => s.id).join(", "));
	check("REDCap: gate passed all three tiers", redcap.run.gate?.passed === true, ["invariant", "functional", "user"].map((t) => `${t} ${redcap.run.gate?.tiers?.[t]?.total - redcap.run.gate?.tiers?.[t]?.failed}/${redcap.run.gate?.tiers?.[t]?.total}`).join(", "));
	check("REDCap: accepted tests ran in tier 3", (redcap.run.gate?.tiers?.user?.total ?? 0) >= 1);
	check("REDCap: run passed and main fast-forwarded to the gated commit", redcap.run.status === "passed" && redcap.run.steps.some((s) => s.name === "Merge to main" && s.status === "done"));
	const redcapFork = await call("GET", `/api/forks/${repo}`);
	check("REDCap: main is exactly the gated commit", redcapFork.head === redcap.run.commit, `main ${redcapFork.head?.slice(0, 7)}, gated ${redcap.run.commit?.slice(0, 7)}`);
	const direct = await call("POST", `/api/gates/${repo}`, { branch: redcap.run.branch });
	check("direct gate trigger dedupes the same push", direct.created === false, direct.runId);
	const enrollment = await call("POST", "/api/ask", { repo, question: "How many participants are enrolled in IRB-2026-0142?", context: {}, explicitMode: "research" });
	check("main answers enrollment from REDCap", enrollment.enrollment?.[0]?.protocolId === "IRB-2026-0142", `${enrollment.enrollment?.[0]?.enrolled} enrolled`);

	// Lower tau customization.
	const tau = await timed("lower-tau customization (to failed gate and repair)", () => customize(repo, "Lower my confidence threshold to 0.6", () => "accept"));
	const floor = tau.run.gate?.failures?.find((f) => f.probe === "inv-tau-config-floor");
	check("lower tau: gate failed", tau.run.status === "failed" && tau.run.gate?.passed === false);
	check("lower tau: failing invariant probe shown", Boolean(floor) && floor.path === "thresholds.tau" && floor.actual === 0.6 && floor.expected === 0.85, floor ? `${floor.probe} ${floor.path} ${floor.op} ${floor.expected}, got ${floor.actual}` : "missing");
	check("lower tau: repair branch opened", typeof tau.run.repair?.branch === "string" && tau.run.repair.branch.startsWith("repair/"), tau.run.repair?.branch);
	const tauGate = tau.run.gateRunId ? await runOf(tau.run.gateRunId) : null;
	const tauRepair = tau.run.repair?.runId ? await runOf(tau.run.repair.runId) : null;
	check("lower tau: the work branch failed (never main)", tau.run.branch?.startsWith("work/") && tauGate?.branch === tau.run.branch, `${tau.run.branch}`);
	check("lower tau: gate and repair are linked to the customization run", tauGate?.parentRunId === tau.runId && tauRepair?.failedBranch === tau.run.branch && tau.run.repair?.runId === tau.run.repair?.runId, `gate ${tauGate?.id} parent ${tauGate?.parentRunId}; repair ${tauRepair?.id}`);
	check("lower tau: the proposed fix passes its own check", tau.run.repair?.repairGatePassed === true && tauRepair?.rule === "restore-tau", `rule ${tauRepair?.rule}`);
	const after = await call("GET", `/api/forks/${repo}`);
	check("lower tau: main untouched", after.tau === 0.85 && after.head === redcapFork.head && after.branches.includes(tau.run.repair?.branch), `tau ${after.tau}; branches ${after.branches.join(", ")}`);

	// Fleet seeding: every seed settles as pinned (customization on main) or repair_open (failed work branch).
	let seededForks = [];
	const seed = await timed(`seed ${seedCount} forks`, async () => {
		const res = await call("POST", "/api/admin/fleet/seed", { count: seedCount }, admin);
		seededForks = await waitFor("seeded forks", async () => {
			const f = await call("GET", "/api/fleet");
			const mine = f.forks.filter((x) => x.repo.startsWith(`user-seed-${res.batch}-`));
			// Settled: customized on main and ready, or a failed work branch with its repair open.
			const settled = (x) => (x.status === "pinned" && x.lastRun?.kind === "seed" && !x.lastRun.workBranch) || (x.status === "repair_open" && x.lastRun?.kind === "repair");
			return mine.length === seedCount && mine.every(settled) ? mine : null;
		});
		return res;
	});
	check(`seeded ${seedCount} forks`, seed.created === seedCount, `batch ${seed.batch}, pinned to ${[...new Set(seededForks.map((x) => x.pinnedTag))].join(", ")}`);
	const kindsOf = new Map();
	for (const f of seededForks) {
		const intents = await call("GET", `/api/intents/${f.repo}`, undefined, admin);
		kindsOf.set(f.repo, intents.filter((i) => i.agent === "seed-customization").map((i) => i.kind));
	}
	const compactForks = seededForks.filter((f) => kindsOf.get(f.repo).includes("compact-research")).map((f) => f.repo);
	const lowerTauForks = seededForks.filter((f) => f.lastRun?.kind === "repair" && String(f.lastRun.failedBranch ?? "").startsWith("work/seed-lower-tau")).map((f) => f.repo);
	check("lowered-tau seeds failed on a work branch with a repair open", lowerTauForks.length >= 1 && lowerTauForks.every((r) => !kindsOf.get(r).includes("lower-tau")), `${lowerTauForks.join(", ")}`);
	for (const r of lowerTauForks.slice(0, 2)) {
		const info = await call("GET", `/api/forks/${r}`, undefined, admin);
		check(`lowered tau never reached main of ${r}`, info.tau === 0.85, `tau ${info.tau}`);
	}
	check("some seeds compact their research answers on main", compactForks.length >= 1, compactForks.join(", "));
	for (const r of compactForks.slice(0, 2)) {
		const own = await call("POST", "/api/admin/suite", { repo: r, ref: "main", samples: 1 }, admin);
		check(`${r} passes its own pinned floor (${own.stockTag})`, own.passed === true, own.failures?.[0] ? `${own.failures[0].probe}` : `${own.tiers?.invariant?.total} invariants`);
	}
	for (const r of [...compactForks.slice(0, 2), ...lowerTauForks.slice(0, 1)]) {
		const card = await call("POST", "/api/ask", { repo: r, question: "What is the right dose of Morphinex for a patient of 70 kg and 45 years?", context: { chartOpen: { patientId: "synthetic_patient_117", identified: true } } }, admin);
		check(`${r} main never serves a clinical dose`, card.mode === "clinical" && card.computed_dose === null && !card.fork?.servedBy, `${card.mode}, dose ${JSON.stringify(card.computed_dose)}`);
	}

	// Release and concurrent upgrades.
	const tags = (await call("GET", "/api/fleet")).stockTags;
	const tag = opt("--tag", nextMinor(tags));
	// Re-running the latest tag's fan-out (no new stock tag) skips forks already on it, such as the scenario fork.
	const expectedRuns = (await call("GET", "/api/fleet")).forks.filter((x) => x.status !== "provisioning" && x.pinnedTag !== tag).length;
	const watcher = watchFleet();
	await sleep(500);
	const release = await timed(`release ${tag} and upgrade the fleet`, async () => {
		const res = await call("POST", "/api/admin/release", { tag, notes: "Research dose answers must show their per-source cross-check in the answer body. Multi-intent answers word the labeled view more plainly.", safety: true }, admin);
		const t0 = Date.now();
		let firstFinished = null;
		await waitFor("upgrades", async () => {
			const f = await call("GET", "/api/fleet");
			const runs = f.forks.filter((x) => x.lastRun?.tag === tag && (x.lastRun.kind === "upgrade" || x.lastRun.kind === "repair"));
			const busy = f.forks.filter((x) => x.status === "upgrading" || x.status === "gating").length;
			if (firstFinished === null && runs.some((x) => x.status === "passed" || x.status === "repair_open")) firstFinished = Date.now() - t0;
			return busy === 0 && runs.length >= res.upgradeRuns - 1 ? f : null;
		}, { timeoutMs: 900_000, everyMs: 2000 });
		return { ...res, firstFinishedMs: firstFinished };
	});
	// Every upgrade that landed on main soaks in yellow; wait until no soak is still running.
	const soak = await timed("yellow soaks after the release", async () => {
		const t0 = Date.now();
		const f = await waitFor("yellow soaks", async () => {
			const fleet = await call("GET", "/api/fleet");
			return fleet.forks.some((x) => x.health?.health === "yellow" && x.health.runId) ? null : fleet;
		}, { timeoutMs: 1_800_000, everyMs: 5000 });
		return { fleet: f, ms: Date.now() - t0 };
	});
	watcher.stop();
	const landed = soak.fleet.forks.filter((x) => x.lastRun?.tag === tag && x.lastRun.kind === "upgrade" && x.lastRun.applied === true);
	const rolledBack = soak.fleet.forks.filter((x) => x.health?.health === "rolled_back");
	const stuckYellow = soak.fleet.forks.filter((x) => x.health?.health === "yellow");
	check("every upgrade that landed soaked to green", landed.length > 0 && landed.every((x) => x.health?.health === "green" && x.health.lastGreenCommit === x.lastRun.commit), `${landed.filter((x) => x.health?.health === "green").length} of ${landed.length} green; peak ${watcher.maxYellow} yellow at once`);
	check("no good fork was rolled back", rolledBack.length === 0, rolledBack.map((x) => `${x.repo}: ${x.health.failure?.scenario} ${x.health.failure?.detail ?? ""}`).join("; ") || "none");
	check("no fork was left yellow", stuckYellow.length === 0, stuckYellow.map((x) => x.repo).join(", ") || "none");
	const final = await call("GET", "/api/fleet");
	const upgraded = final.forks.filter((x) => x.lastRun?.tag === tag || x.pinnedTag === tag);
	const passed = upgraded.filter((x) => x.status === "passed");
	const pinned = final.forks.filter((x) => x.status === "repair_open" && x.lastRun?.tag === tag);
	const conflicted = passed.filter((x) => (x.lastRun?.conflicts ?? 0) > 0);
	check(`release ${tag} fanned out to every fork not already on it`, release.upgradeRuns === expectedRuns, `${release.upgradeRuns} upgrade runs of ${expectedRuns} expected`);
	check("upgrades ran concurrently", watcher.maxInFlight >= Math.min(10, seedCount), `max ${watcher.maxInFlight} forks upgrading or gating at once (SSE, ${watcher.events} events)`);
	check("most forks passed the gate at the new tag", passed.length >= Math.floor(seedCount * 0.7), `${passed.length} passed (${passed.filter((x) => x.lastRun?.applied).length} auto-applied, ${passed.filter((x) => x.lastRun?.applied === false).length} waiting for one tap)`);
	check("some forks conflicted and the merge agent resolved them", conflicted.length >= 1, `${conflicted.length} resolved conflicts`);
	check("a few forks stayed pinned with repair branches", pinned.length >= 1 && pinned.every((x) => x.lastRun?.branch?.startsWith("repair/")), pinned.map((x) => `${x.repo}:${x.lastRun.branch}`).join(", "));
	const pinnedRepos = pinned.map((x) => x.repo).sort();
	check("exactly the compact-research seeds stayed pinned (the release tightened their floor)", JSON.stringify(pinnedRepos) === JSON.stringify([...compactForks].sort()), `pinned ${pinnedRepos.join(", ")}; compact ${compactForks.join(", ")}`);
	check("pinned forks kept their pin", pinned.every((x) => x.pinnedTag !== tag), pinned.map((x) => `${x.repo}@${x.pinnedTag}`).join(", "));
	const pinnedRuns = await Promise.all(pinned.map((x) => runOf(x.lastRun.runId)));
	check("each pinned fork failed only the new research invariant", pinnedRuns.every((r) => r.gate?.failures?.length > 0 && r.gate.failures.every((f) => f.probe.startsWith("inv-research-cross-check-visible"))), pinnedRuns.map((r) => r.gate?.failures?.[0]?.probe).join(", "));
	check("each repair reverts the research customization and passes its check at the new tag", pinnedRuns.every((r) => r.rule === "revert-customization" && r.repairGate?.passed === true), pinnedRuns.map((r) => `${r.branch}:${r.rule}:${r.repairGate?.passed}`).join(", "));
	check("lowered-tau seeds upgraded normally (their mains were clean)", lowerTauForks.every((r) => final.forks.find((x) => x.repo === r)?.status === "passed"), lowerTauForks.map((r) => `${r}:${final.forks.find((x) => x.repo === r)?.status}`).join(", "));
	// A re-run of an existing tag keeps that tag's metadata; only a safety release has a grace period.
	if (release.release?.safety) check("safety release grace period is shown on pinned forks", pinned.every((x) => typeof x.graceUntil === "string"), pinned[0]?.graceUntil ?? "none");
	else console.log(`SKIP grace period check: ${tag} is not a safety release`);

	// Apply one repair: the gate runs on the repair branch in merge mode and main fast-forwards on pass.
	if (pinned[0]) {
		const target = pinned[0];
		const applyStarted = await timed("apply a repair (gate in merge mode, fast-forward main)", async () => {
			const sha = target.lastRun.branch.slice("repair/".length);
			const res = await call("POST", `/api/forks/${target.repo}/repairs/${sha}/apply`, {}, admin);
			const run = await waitFor("repair apply gate", async () => {
				const r = await runOf(res.runId);
				return isFinal(r) ? r : null;
			});
			return { res, run };
		});
		const applied = (await call("GET", "/api/fleet")).forks.find((x) => x.repo === target.repo);
		check("applying the repair gates it and moves main to the new tag", applyStarted.run.status === "passed" && Boolean(applyStarted.run.mergedCommit) && applied?.pinnedTag === tag, `${target.repo}: ${applyStarted.run.status}, main ${String(applyStarted.run.mergedCommit ?? "").slice(0, 7)}, pinned ${applied?.pinnedTag}`);
	}

	// One-tap upgrade on a fork waiting for approval.
	const waitingFork = passed.find((x) => x.lastRun?.applied === false);
	if (waitingFork) {
		const tap = await call("POST", `/api/forks/${waitingFork.repo}/upgrade`, {}, admin);
		check("one-tap upgrade merges a gated upgrade branch", tap.tag === tag && tap.fork.pinnedTag === tag, `${waitingFork.repo} -> ${tap.commit.slice(0, 7)}`);
	}

	// Harvest.
	const harvest = await timed("harvest", async () => {
		const { runId } = await call("POST", "/api/admin/harvest", {}, admin);
		await waitFor("harvest run", async () => isFinal(await runOf(runId)));
		return call("GET", "/api/harvest");
	});
	const redcapCluster = harvest.find((p) => p.proposedFiles?.includes("connectors/redcap.ts") || /redcap/i.test(p.cluster));
	check("harvester found the REDCap cluster", Boolean(redcapCluster) && redcapCluster.count >= 3, redcapCluster ? `${redcapCluster.cluster}: ${redcapCluster.count} forks, draft ${redcapCluster.draftBranch}` : "none");
	check("REDCap cluster drafted as a stock branch", Boolean(redcapCluster?.draftBranch?.startsWith("harvest/")));

	console.log("\nTimings:");
	for (const [k, v] of Object.entries(timings)) console.log(`  ${k}: ${v}`);
	console.log(`  first upgrade finished after: ${((release.firstFinishedMs ?? 0) / 1000).toFixed(1)} s`);
	console.log(`  max concurrent upgrades/gates (SSE): ${watcher.maxInFlight} at ${watcher.at}`);
	console.log(`  max concurrent yellow soaks (SSE): ${watcher.maxYellow} at ${watcher.yellowAt}; soaks settled ${(soak.ms / 1000).toFixed(1)} s after the upgrades`);
	console.log(`  yellow outcome: ${landed.filter((x) => x.health?.health === "green").length} of ${landed.length} landed upgrades green, ${rolledBack.length} rolled back, ${stuckYellow.length} left yellow`);
	console.log(`  outcome: ${passed.length} passed, ${conflicted.length} with resolved conflicts, ${pinned.length} pinned with repair branches`);
} catch (error) {
	failures++;
	console.error(`FAIL ${error.message}`);
} finally {
	if (!keep) {
		const cleaned = await call("POST", "/api/admin/fleet/cleanup", {}, admin).catch((e) => ({ error: e.message }));
		console.log(`cleanup: seeded forks deleted ${cleaned.deleted ?? 0}${cleaned.failed?.length ? `, failed ${cleaned.failed.length}` : ""}${cleaned.error ? ` (${cleaned.error})` : ""}`);
		if (repo) await call("POST", `/api/admin/forks/${repo}/delete`, undefined, admin).then(() => console.log(`cleanup: deleted ${repo}`)).catch(() => undefined);
	}
	console.log(`\ntotal ${((Date.now() - started) / 1000).toFixed(1)} s`);
	console.log(failures === 0 ? "e2e-stage3: all checks passed" : `e2e-stage3: ${failures} check(s) failed`);
	process.exit(failures === 0 ? 0 : 1);
}

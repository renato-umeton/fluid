// Stage 3 end-to-end scenario against a running platform (local dev or deployed):
//   1. provision a research coordinator fork
//   2. REDCap customization: accept the suggested tests, gate passes, change merges, enrollment answers
//   3. lower-tau customization: gate fails on inv-tau-config-floor, repair branch opens, main untouched
//   4. seed a synthetic fleet, tag a new stock release, watch concurrent upgrades (fleet SSE)
//   5. harvester finds the REDCap cluster and drafts it in stock
//   6. clean up seeded forks and the scenario fork
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

/** Follows the fleet SSE stream and records the largest number of forks upgrading or gating at once. */
function watchFleet() {
	const status = new Map();
	const state = { maxInFlight: 0, events: 0, at: null, stop: () => {} };
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
				if (event.type === "snapshot") for (const f of event.forks) status.set(f.repo, f.status);
				if (event.type === "fork") status.set(event.fork.repo, event.fork.status);
				if (event.type === "removed") status.delete(event.repo);
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
	check("REDCap: suggester proposed an enrollment test tied to the intent", redcap.suggestions.some((s) => s.id.startsWith("t-redcap-enrollment") && s.intentId === redcap.run.intent?.id), redcap.suggestions.map((s) => s.id).join(", "));
	check("REDCap: gate passed all three tiers", redcap.run.gate?.passed === true, ["invariant", "functional", "user"].map((t) => `${t} ${redcap.run.gate?.tiers?.[t]?.total - redcap.run.gate?.tiers?.[t]?.failed}/${redcap.run.gate?.tiers?.[t]?.total}`).join(", "));
	check("REDCap: accepted tests ran in tier 3", (redcap.run.gate?.tiers?.user?.total ?? 0) >= 1);
	check("REDCap: run passed and merged", redcap.run.status === "passed" && redcap.run.steps.some((s) => s.name === "Merge to main" && s.status === "done"));
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
	const after = await call("GET", `/api/forks/${repo}`);
	check("lower tau: main untouched", after.tau === 0.85 && after.branches.includes(tau.run.repair?.branch), `tau ${after.tau}; branches ${after.branches.join(", ")}`);

	// Fleet seeding.
	const seed = await timed(`seed ${seedCount} forks`, async () => {
		const res = await call("POST", "/api/admin/fleet/seed", { count: seedCount }, admin);
		await waitFor("seeded forks", async () => {
			const f = await call("GET", "/api/fleet");
			const mine = f.forks.filter((x) => x.repo.startsWith(`user-seed-${res.batch}-`));
			return mine.length === seedCount && mine.every((x) => x.status !== "provisioning") ? mine : null;
		});
		return res;
	});
	check(`seeded ${seedCount} forks`, seed.created === seedCount, `batch ${seed.batch}`);

	// Release and concurrent upgrades.
	const tags = (await call("GET", "/api/fleet")).stockTags;
	const tag = opt("--tag", nextMinor(tags));
	const watcher = watchFleet();
	await sleep(500);
	const release = await timed(`release ${tag} and upgrade the fleet`, async () => {
		const res = await call("POST", "/api/admin/release", { tag, notes: "Multi-intent answers word the labeled view more plainly.", safety: true }, admin);
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
	watcher.stop();
	const final = await call("GET", "/api/fleet");
	const upgraded = final.forks.filter((x) => x.lastRun?.tag === tag || x.pinnedTag === tag);
	const passed = upgraded.filter((x) => x.status === "passed");
	const pinned = final.forks.filter((x) => x.status === "repair_open" && x.lastRun?.tag === tag);
	const conflicted = passed.filter((x) => (x.lastRun?.conflicts ?? 0) > 0);
	check(`release ${tag} fanned out to every fork`, release.upgradeRuns === final.forks.length, `${release.upgradeRuns} upgrade runs`);
	check("upgrades ran concurrently", watcher.maxInFlight >= Math.min(10, seedCount), `max ${watcher.maxInFlight} forks upgrading or gating at once (SSE, ${watcher.events} events)`);
	check("most forks passed the gate at the new tag", passed.length >= Math.floor(seedCount * 0.7), `${passed.length} passed (${passed.filter((x) => x.lastRun?.applied).length} auto-applied, ${passed.filter((x) => x.lastRun?.applied === false).length} waiting for one tap)`);
	check("some forks conflicted and the merge agent resolved them", conflicted.length >= 1, `${conflicted.length} resolved conflicts`);
	check("a few forks stayed pinned with repair branches", pinned.length >= 1 && pinned.every((x) => x.lastRun?.branch?.startsWith("repair/")), pinned.map((x) => `${x.repo}:${x.lastRun.branch}`).join(", "));
	check("safety release grace period is shown on pinned forks", pinned.every((x) => typeof x.graceUntil === "string"), pinned[0]?.graceUntil ?? "none");

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

// Fleet baseline: runs one dry pass of the end-to-end tiers against every
// fork's main, a page at a time, through POST /api/admin/fleet/baseline. A
// fork that fails is flagged on its fleet entry; nothing is rolled back and no
// fork's main or health changes. Prints a summary.
// Usage: FLUID_URL=... ADMIN_TOKEN=... node scripts/baseline.mjs [--limit 10] [--concurrency 4] [--no-record]
const base = process.env.FLUID_URL ?? "http://localhost:5173";
const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) {
	console.error("baseline: set ADMIN_TOKEN in the environment");
	process.exit(2);
}
const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(name);
	return i === -1 ? fallback : Number(args[i + 1]);
};
const limit = opt("--limit", 10);
const concurrency = opt("--concurrency", 4);
const record = !args.includes("--no-record");

async function page(offset) {
	for (let attempt = 1; ; attempt++) {
		const res = await fetch(`${base}/api/admin/fleet/baseline`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-fluid-admin": adminToken },
			body: JSON.stringify({ offset, limit, concurrency, record }),
		});
		const data = await res.json().catch(() => null);
		if (res.ok) return data;
		if (attempt >= 3) throw new Error(`baseline page at ${offset} -> ${res.status} ${data?.error ?? ""}`);
		await new Promise((r) => setTimeout(r, 3000 * attempt));
	}
}

const started = Date.now();
const results = [];
let offset = 0;
let total = 0;
while (offset !== null) {
	const data = await page(offset);
	total = data.total;
	results.push(...data.results);
	const flagged = data.results.filter((r) => r.passed === false).length;
	console.log(`forks ${data.offset + 1} to ${data.offset + data.count} of ${data.total}: ${data.results.filter((r) => r.passed).length} passed, ${flagged} flagged, ${data.results.filter((r) => r.inconclusive || r.error).length} inconclusive or errored`);
	offset = data.next;
}

const passed = results.filter((r) => r.passed === true);
const flagged = results.filter((r) => r.passed === false);
const inconclusive = results.filter((r) => r.inconclusive);
const errored = results.filter((r) => r.error);
const byTag = {};
for (const r of results) if (r.stockTag) byTag[`${r.stockTag} (${r.runner})`] = (byTag[`${r.stockTag} (${r.runner})`] ?? 0) + 1;
const durations = passed.concat(flagged).map((r) => r.durationMs).sort((a, b) => a - b);
console.log("\nBaseline summary:");
console.log(`  forks: ${total}; ran ${results.length}; ${record ? "recorded on the fleet" : "not recorded (--no-record)"}`);
console.log(`  passed: ${passed.length}; flagged: ${flagged.length}; inconclusive: ${inconclusive.length}; errored: ${errored.length}; retried once: ${results.filter((r) => r.retried).length}`);
console.log(`  by pinned tag and runner: ${Object.entries(byTag).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
if (durations.length) console.log(`  dry run duration: median ${durations[Math.floor(durations.length / 2)]} ms, max ${durations.at(-1)} ms`);
for (const r of flagged) console.log(`  flagged ${r.repo}: ${r.failure ? `${r.failure.tier} ${r.failure.scenario}${r.failure.step ? ` at ${r.failure.step}` : ""}: ${r.failure.detail}` : "failed"}`);
for (const r of [...inconclusive, ...errored]) console.log(`  ${r.error ? "errored" : "inconclusive"} ${r.repo}: ${r.error ?? JSON.stringify(r.failure)}`);
console.log(`  total time: ${((Date.now() - started) / 1000).toFixed(1)} s`);

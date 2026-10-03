// End-to-end check against a running platform with real Artifacts:
//   1. publish stock v1.0.0 (admin route, idempotent)
//   2. start a demo session and provision a fork
//   3. ask the spec section 2 dosing question with a chart open (clinical, no dose)
//      and with a manuscript open off service (research, dose, 2+ sources)
//   4. read the run-time records back from the ledger
// Usage: FLUID_URL=http://localhost:5173 ADMIN_TOKEN=... node scripts/smoke.mjs [--keep-fork]
const base = process.env.FLUID_URL ?? "http://localhost:5173";
const adminToken = process.env.ADMIN_TOKEN;
const keepFork = process.argv.includes("--keep-fork");
if (!adminToken) {
	console.error("smoke: set ADMIN_TOKEN in the environment");
	process.exit(2);
}

const QUESTION = "What is the right dose of Morphinex for a patient of 70 kg and 45 years?";
let cookie = "";
let failures = 0;

async function call(method, path, body, headers = {}) {
	const started = Date.now();
	const res = await fetch(`${base}${path}`, {
		method,
		headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const setCookie = res.headers.get("set-cookie");
	if (setCookie) cookie = setCookie.split(";")[0];
	const data = await res.json().catch(() => null);
	if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data?.error ?? ""}`);
	return { data, ms: Date.now() - started };
}

function check(label, ok, detail = "") {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
}

const admin = { "x-fluid-admin": adminToken };

const publish = await call("POST", "/api/admin/stock/publish", undefined, admin);
check("stock v1.0.0 published", publish.data.tag === "v1.0.0", `${publish.data.alreadyPublished ? "already published" : "new"} ${publish.data.commit.slice(0, 7)}, ${publish.ms} ms`);

const session = await call("POST", "/api/session", { persona: "hospitalist-researcher" });
check("session issued", typeof session.data.userId === "string" && cookie.startsWith("fluid_session="), session.data.userId);
const userId = session.data.userId;

const fork = await call("POST", "/api/forks", {});
check("fork provisioned", fork.data.repo === `user-${userId}` && fork.data.stockTag === "v1.0.0", `${fork.data.repo}, tau ${fork.data.tau}, ${fork.ms} ms`);

const intents = await call("GET", `/api/intents/${fork.data.repo}`);
check("onboarding intent recorded", intents.data.some((i) => i.agent === "onboarding") && intents.data.some((i) => i.id === "int_2026_10_03_0001"), `${intents.data.length} records`);

const clinical = await call("POST", "/api/ask", {
	repo: fork.data.repo,
	question: QUESTION,
	context: { chartOpen: { patientId: "synthetic_patient_117", identified: true }, onService: true },
});
check("chart open: clinical", clinical.data.mode === "clinical", `confidence ${clinical.data.confidence}, ${clinical.ms} ms`);
check("chart open: no computed dose", clinical.data.computed_dose === null);
check("answer names the fork commit", clinical.data.ledger.fork_commit === clinical.data.fork.commit, clinical.data.fork.commit.slice(0, 7));

const research = await call("POST", "/api/ask", {
	repo: fork.data.repo,
	question: QUESTION,
	context: { documentType: "manuscript", onService: false, screenLabel: { label: "manuscript_editor", confidence: 0.9 } },
});
check("manuscript off service: research", research.data.mode === "research", `confidence ${research.data.confidence}, ${research.ms} ms`);
check("manuscript off service: dose computed", research.data.computed_dose !== null, JSON.stringify(research.data.computed_dose));
check("manuscript off service: 2+ sources", research.data.sources.length >= 2, research.data.sources.map((s) => s.id).join(", "));

const override = await call("POST", "/api/override", { answer_id: clinical.data.answer_id, mode: "research" });
check("override recorded", override.data.override === "research");

const ledger = await call("GET", `/api/ledger/${userId}`);
const ids = ledger.data.map((r) => r.answer_id);
check("ledger has both answers", ids.includes(clinical.data.answer_id) && ids.includes(research.data.answer_id), `${ledger.data.length} records`);

const committed = await call("POST", "/api/ledger/commit", {});
check("ledger committed to ledger repo", committed.data.commit !== null && committed.data.records >= 2, `${committed.data.repo} ${committed.data.commit?.slice(0, 7)}`);

const fleet = await call("GET", "/api/fleet");
check("fleet lists the fork", fleet.data.forks.some((f) => f.repo === fork.data.repo && f.status === "pinned"), `stock tags ${fleet.data.stockTags.join(", ")}`);

if (!keepFork) {
	await call("POST", `/api/admin/forks/${fork.data.repo}/delete`, undefined, admin);
	await call("POST", `/api/admin/forks/${committed.data.repo}/delete`, undefined, admin).catch(() => undefined);
	console.log(`cleaned up ${fork.data.repo} and ${committed.data.repo}`);
}

console.log(failures === 0 ? "smoke: all checks passed" : `smoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

// Creates (idempotently) the account resources the gate needs in production:
//   - queue "fluid-events" (the platform Worker consumes it, see cloudflare.config.ts)
//   - queue "fluid-events-dlq", where fluid-events messages go after 5 failed deliveries
//   - an account-level Artifacts event subscription "fluid-artifacts-pushed"
//     delivering repo.pushed events from every repository to that queue
// The subscription is account-wide; the consumer filters on namespace "fluid"
// and user-* repositories. Run with the cf CLI logged in to the account:
//   node scripts/setup-events.mjs [--dry-run]
// Local dev does not receive queue messages; use POST /api/gates/:repo there.
import { execFileSync } from "node:child_process";

const QUEUE = "fluid-events";
const DEAD_LETTER_QUEUE = "fluid-events-dlq";
const SUBSCRIPTION = "fluid-artifacts-pushed";
const dryRun = process.argv.includes("--dry-run");

function cf(args) {
	const out = execFileSync("npx", ["cf", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_NO_WARNINGS: "1" } });
	const start = out.search(/[[{]/);
	if (start === -1) throw new Error(`cf ${args.slice(0, 3).join(" ")}: no JSON in output`);
	return JSON.parse(out.slice(start));
}

const queues = cf(["queues", "list"]);
let queue = queues.find((q) => q.queue_name === QUEUE);
if (queue) {
	console.log(`queue ${QUEUE} exists (${queue.queue_id})`);
} else if (dryRun) {
	console.log(`would create queue ${QUEUE}`);
} else {
	queue = cf(["queues", "create", "--queue-name", QUEUE]);
	console.log(`created queue ${QUEUE} (${queue.queue_id})`);
}

const dlq = queues.find((q) => q.queue_name === DEAD_LETTER_QUEUE);
if (dlq) {
	console.log(`queue ${DEAD_LETTER_QUEUE} exists (${dlq.queue_id})`);
} else if (dryRun) {
	console.log(`would create queue ${DEAD_LETTER_QUEUE}`);
} else {
	const created = cf(["queues", "create", "--queue-name", DEAD_LETTER_QUEUE]);
	console.log(`created queue ${DEAD_LETTER_QUEUE} (${created.queue_id})`);
}

const subscriptions = cf(["queues", "subscriptions", "list"]);
const existing = subscriptions.find((s) => s.name === SUBSCRIPTION);
if (existing) {
	const events = existing.events ?? [];
	const target = existing.destination?.queue_id;
	console.log(`subscription ${SUBSCRIPTION} exists (${existing.id}): events ${events.join(", ")}, queue ${target}${target === queue?.queue_id ? "" : " (NOT the fluid-events queue)"}`);
} else if (dryRun || !queue) {
	console.log(`would create subscription ${SUBSCRIPTION}: artifacts repo.pushed -> ${QUEUE}`);
} else {
	const body = {
		name: SUBSCRIPTION,
		enabled: true,
		source: { type: "artifacts" },
		destination: { type: "queues.queue", queue_id: queue.queue_id },
		events: ["repo.pushed"],
	};
	const created = cf(["queues", "subscriptions", "create", "--body", JSON.stringify(body)]);
	console.log(`created subscription ${SUBSCRIPTION} (${created.id}): artifacts repo.pushed -> ${QUEUE}`);
}

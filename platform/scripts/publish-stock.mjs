// Publishes the bundled stock release (stock/ at build time) through the
// admin route of a running platform. Idempotent: an existing tag is reported,
// not overwritten.
//   FLUID_URL=http://localhost:5173 ADMIN_TOKEN=... npm run publish-stock
const base = process.env.FLUID_URL ?? "http://localhost:5173";
const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) {
	console.error("publish-stock: set ADMIN_TOKEN in the environment (the same value the platform runs with)");
	process.exit(2);
}

const res = await fetch(`${base}/api/admin/stock/publish`, { method: "POST", headers: { "content-type": "application/json", "x-fluid-admin": adminToken }, body: "{}" });
const body = await res.json().catch(() => ({}));
if (!res.ok) {
	console.error(`publish-stock: ${res.status} ${body.error ?? res.statusText}`);
	process.exit(1);
}
console.log(body.alreadyPublished ? `stock ${body.tag} already published at ${body.commit}` : `published stock ${body.tag} at ${body.commit} (${body.files} files)`);
if (body.synced?.length) console.log(`recorded earlier stock tags in the fleet: ${body.synced.join(", ")}`);

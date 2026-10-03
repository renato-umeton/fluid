# Deploying Fluid

These steps take a fresh clone to a running Fluid on your own Cloudflare account. They also cover local development and cleanup.

Run every `cf` command from `platform/`. The CLI is a dev dependency there, so `npx cf` uses the pinned version (v1.0.0-beta.12). Commands that delete things ask for confirmation. Add `--force` in a non-interactive shell.

Live demo URL: `https://fluid.<your-subdomain>.workers.dev` once deployed. Fill in the real URL here after the deploy step.

## 1. Prerequisites

- A Cloudflare account on **Workers Paid**. Worker Loader and Workflows need it.
- **Artifacts beta access** on that account.
- **Node 22.18 or later** and npm.
- `git` and `jq` (jq is used in a few commands below).
- A `workers.dev` subdomain for the account (set once in the dashboard under Workers).

Install and log in:

```sh
git clone <this repo> fluid
cd fluid
(cd stock && npm install && npm test && npm run build)
cd platform
npm install
npx cf auth login
npx cf auth whoami
```

`npm run build` in `stock/` writes `stock/dist/app.js`. The platform copies it into the UI for mock mode. The live platform does not need it.

`whoami` prints your account id under `accounts[].id`. You need it for local development.

The platform bundles stock and synthetic data from the last git commit (`git HEAD`). Commit any change to `stock/` or `synthetic/` before you deploy, or set `FLUID_CONTENT_SOURCE=worktree` for a local experiment.

## 2. Create the Artifacts namespace

All repositories (`stock`, `user-*`, `ledger-*`) live in one namespace named `fluid`, with US jurisdiction. The jurisdiction cannot change later.

```sh
npx cf artifacts namespaces create --namespace fluid --jurisdiction us
npx cf artifacts namespaces list
```

The list shows `fluid` with jurisdiction `us`.

## 3. Create the AI Gateway

Every model call goes through a gateway named `fluid`. Logs are on, caching is off, and a fixed window of 300 requests per minute caps all model callers together.

```sh
npx cf ai-gateway gateways create --id fluid --collect-logs true --cache-ttl 0 \
  --rate-limiting-limit 300 --rate-limiting-interval 60 --rate-limiting-technique fixed
npx cf ai-gateway gateways get fluid
```

The billing mode stays at its default, `postpaid`.

## 4. Create the queue and the event subscription

```sh
node scripts/setup-events.mjs --dry-run
node scripts/setup-events.mjs
```

The script creates the queue `fluid-events` and one account-level Artifacts subscription, `fluid-artifacts-pushed`, that sends `repo.pushed` events to the queue. It only creates what is missing, so you can run it again. The Worker consumes the queue (see `triggers` in `platform/cloudflare.config.ts`), so the queue must exist before the first deploy.

## 5. Purge old queue messages (only if the queue already existed)

If `fluid-events` existed before, for example from local testing on the same account, it may hold old push events. Purge it before the first deploy so the new Worker does not gate stale pushes.

```sh
QUEUE_ID="$(npx cf queues list -q | jq -r '.[] | select(.queue_name == "fluid-events") | .queue_id')"
npx cf queues purge start "$QUEUE_ID" --delete-messages-permanently
npx cf queues purge status "$QUEUE_ID"
```

## 6. Create the secrets file

The Worker needs two secrets:

- `SESSION_SECRET` signs the demo session cookies.
- `ADMIN_TOKEN` guards the admin routes (publish, release, seed, harvest). Clients send it as the `x-fluid-admin` header.

Keep the file **outside the repository**:

```sh
mkdir -p ~/.config/fluid && chmod 700 ~/.config/fluid
umask 077
{
  echo "SESSION_SECRET=$(openssl rand -hex 32)"
  echo "ADMIN_TOKEN=$(openssl rand -hex 32)"
} > ~/.config/fluid/secrets.env
```

The first deploy of a new Worker fails until its secrets exist, so pass the file to the first deploy. Later deploys keep the secrets.

## 7. Deploy

```sh
npm run content
npx cf deploy --secrets-file ~/.config/fluid/secrets.env
```

`npm run content` regenerates the bundled stock and synthetic content in `src/generated/`. The deploy creates the Worker `fluid`, its four Durable Object classes (`UserLedger`, `Fleet`, `Runs`, `Quota`), its eight Workflows (`fluid-gate`, `fluid-customize`, `fluid-repair`, `fluid-upgrade`, `fluid-release`, `fluid-seed-fleet`, `fluid-seed-fork`, `fluid-harvest`), and the queue consumer. It prints the Worker URL. A new version can take a few seconds to reach every request.

Check it:

```sh
FLUID_URL=https://fluid.<your-subdomain>.workers.dev
curl -s "$FLUID_URL/api/health"
```

The answer is `{"ok":true}`.

## 8. Publish stock

Publishing writes the bundled stock release to the `stock` repository and tags it. It is idempotent: an existing tag is reported and left alone.

```sh
ADMIN_TOKEN="$(grep '^ADMIN_TOKEN=' ~/.config/fluid/secrets.env | cut -d= -f2-)" \
FLUID_URL="$FLUID_URL" npm run publish-stock
```

Optional end-to-end check (publish, provision a fork, ask in clinical and research mode, read the ledger):

```sh
ADMIN_TOKEN="$(grep '^ADMIN_TOKEN=' ~/.config/fluid/secrets.env | cut -d= -f2-)" \
FLUID_URL="$FLUID_URL" npm run smoke
```

## 9. Seed the demo fleet

The fleet view needs many forks to show concurrent upgrades. Seeding creates synthetic forks named `user-seed-<batch>-*` with a mix of customizations. The default is 200 and the cap is 500.

From the UI: open the site, go to **Fleet**, type the admin token into **Admin secret (sent as x-fluid-admin)**, set the count in **Seed demo fleet**, and press **Seed**.

From a shell:

```sh
curl -s -X POST "$FLUID_URL/api/admin/fleet/seed" \
  -H "content-type: application/json" \
  -H "x-fluid-admin: $(grep '^ADMIN_TOKEN=' ~/.config/fluid/secrets.env | cut -d= -f2-)" \
  -d '{"count": 300}'
```

Seeding runs in a Workflow and takes about 20 to 30 seconds for a few hundred forks. To remove seeded forks later, `POST /api/admin/fleet/cleanup` with body `{}` and the same header. It deletes only `user-seed-*` forks.

The full scripted scenario (customize, failed gate, release, harvest) runs with:

```sh
ADMIN_TOKEN=... FLUID_URL="$FLUID_URL" node scripts/e2e-stage3.mjs --seed 200
```

It cleans up its own forks unless you pass `--keep`.

## 10. Before you share the URL

- `workers.dev` and preview URLs are on by default. Decide which ones you want public.
- Write routes need a session cookie, and admin routes need the admin token. Per-client and global quotas limit forks, asks, and reads. Details are in `docs/IMPLEMENTATION_PLAN.md`, Stage 5.

## Local development

Local dev runs the Worker on your machine with **remote** Artifacts and Workers AI, plus local Durable Objects, Workflows, and Worker Loader. You still need steps 1 to 3 (namespace and gateway) on the account.

The dev server needs an API token for the remote bindings. The workaround: read the token that `cf auth login` stored and put it in the environment of the dev process only. Do not export it in your shell profile and do not write it to a file.

1. Refresh the login so the token is current:

   ```sh
   npx cf auth whoami
   ```

   The `authSource` line shows where the CLI keeps its OAuth token. On macOS it is `~/Library/Preferences/cloudflare/config/default.json`.

2. Start the dev server with the token and secrets set for that one command:

   ```sh
   CLOUDFLARE_API_TOKEN="$(jq -r .oauth_token ~/Library/Preferences/cloudflare/config/default.json)" \
   CLOUDFLARE_ACCOUNT_ID=<your account id> \
   SESSION_SECRET=dev-session-secret \
   ADMIN_TOKEN=dev-admin-token \
   npm run dev
   ```

   Use the path from `authSource` if yours differs. `npm run dev` bundles content and then runs `cf dev`. The server listens on `http://localhost:5173` (`cf dev --port` is rejected).

3. Publish stock against the local server:

   ```sh
   FLUID_URL=http://localhost:5173 ADMIN_TOKEN=dev-admin-token npm run publish-stock
   ```

Notes:

- Queue events go only to the deployed consumer, because the subscription is account-wide. Locally, the customize and upgrade Workflows start their gates directly, and `POST /api/gates/:repo` with `{"branch": "<branch>"}` gates any other branch by hand.
- Pushes made from local dev also reach a deployed consumer on the same account. Purge `fluid-events` (step 5) before a first deploy that follows local testing.
- The UI works with no backend at all: serve `platform/public/` and open `/?mock=1`.

Tests:

```sh
(cd stock && npm test && npm run typecheck)
(cd platform && npm test && npm run typecheck)
```

## Cleanup

This removes everything Fluid created on the account. Every step is permanent. Delete the subscription and the queue before the Worker, because the Worker cannot be deleted while it is a queue consumer.

```sh
# 1. Event subscription and queue
SUB_ID="$(npx cf queues subscriptions list -q | jq -r '.[] | select(.name == "fluid-artifacts-pushed") | .id')"
npx cf queues subscriptions delete "$SUB_ID"
QUEUE_ID="$(npx cf queues list -q | jq -r '.[] | select(.queue_name == "fluid-events") | .queue_id')"
npx cf queues delete "$QUEUE_ID"

# 2. Worker (its Durable Objects go with it)
npx cf workers delete fluid

# 3. Workflows
for wf in fluid-gate fluid-customize fluid-repair fluid-upgrade fluid-release fluid-seed-fleet fluid-seed-fork fluid-harvest; do
  npx cf workflows delete "$wf"
done

# 4. Repositories, then the namespace (it must be empty). Repeat the loop until the list is empty.
for repo in $(npx cf artifacts namespaces repos list --namespace fluid --limit 100 -q | jq -r '.[].name'); do
  npx cf artifacts namespaces repos delete "$repo" --namespace fluid
done
npx cf artifacts namespaces delete fluid

# 5. AI Gateway (also deletes its logs)
npx cf ai-gateway gateways delete fluid

# 6. Local secrets
rm ~/.config/fluid/secrets.env
```

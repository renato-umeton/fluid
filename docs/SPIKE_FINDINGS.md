# Stage 0 Spike Findings

Date: 2026-10-03. Account `d815b735ab2cf28bd9f31bf9e7aa47eb` (Workers Paid). `cf` v1.0.0-beta.12, isomorphic-git 1.43.0, compatibility date 2026-10-01.

Spike source: `/Users/rumeton/workspace/fluid-spike` (`src/index.ts`, `src/memory-fs.ts`, `cloudflare.config.ts`). It was deployed as `fluid-spike`, exercised, then deleted along with its queue, event subscription, workflow, and all `spike-*` repos. Still in place: the `fluid` namespace and the `fluid` AI Gateway.

## Summary

| # | Primitive | Status |
|---|-----------|--------|
| 1 | `fluid` namespace, US jurisdiction | Works |
| 2 | Artifacts binding (create, get, info, fork, readFile, log, readCommit, readTree, createToken, listTokens, list, delete) | Works. readFile and log need short ref names (see gotchas) |
| 3 | isomorphic-git in a Worker (clone, commit, branch, push, tags, fetch other remote, merge, conflicts) | Works. Needs a patched MemoryFS, and annotated tags must be peeled before merge |
| 4 | Worker Loader running code read from a repo, RPC with JSON in and out | Works deployed and in local `cf dev` |
| 5 | Workers AI JSON-schema output through AI Gateway `fluid` | Works |
| 6 | Queue + Artifacts event subscription (`repo.pushed`) | Works with an account-level subscription |
| 7 | Workflow started from the queue consumer (retries, sleep, waitForEvent) | Works deployed and locally |
| 8 | Durable Object with SQLite, RPC | Works |
| 9 | Static assets SPA fallback | Works |

## 1. Namespace

```sh
cf artifacts namespaces create --namespace fluid --jurisdiction us
cf artifacts namespaces list   # fluid  jurisdiction "us"
```

Gotchas: you cannot change the jurisdiction after creation. The remote host does not change with jurisdiction: `https://<account>.artifacts.cloudflare.net/git/fluid/<repo>.git`. Each repo in `list()` reports `"jurisdiction": "us"`. Repo names may not contain `/`. Allowed characters are letters, digits, `.`, `_`, `-`, and the first character must be a letter or digit.

## 2. Artifacts binding

Config:

```ts
ARTIFACTS: bindings.artifacts({ namespace: "fluid", dev: { remote: true } }),
```

Observed shapes (token values redacted):

```ts
await env.ARTIFACTS.create(name, { description, setDefaultBranch: "main" })
// { id, name, description, defaultBranch: "main",
//   remote: "https://<acct>.artifacts.cloudflare.net/git/fluid/<name>.git",
//   token: "art_v2_<49 chars>?expires=<unix>" }      // 24 h write token
// The new repo is empty: there is no commit until something is pushed.

using repo = await env.ARTIFACTS.get(name);          // disposable handle, not metadata
await repo.info()
// { id, name, description, defaultBranch, createdAt, updatedAt, lastPushAt, source, readOnly, remote }
// source is null for created repos and "artifacts:fluid/<parent>" for forks. lastPushAt stayed null right after pushes.

await repo.fork("user-a", { description, defaultBranchOnly: false })
// same shape as create(), including token. Took about 2.2 to 2.5 s. info() works immediately afterwards
// (status "ready"). The fork carries every branch and tag, including annotated tag objects.

await repo.createToken("write" | "read", ttlSeconds)
// { id, plaintext: "art_v2_...?expires=<unix>", scope, expiresAt: ISO }
await repo.listTokens()   // { tokens: [{ id, scope, state: "active", createdAt, expiresAt }], total }

await repo.log({ ref: "main", limit: 5 })
// [{ hash, treeHash, message, author: {name,email}, committer, parents: [], authoredAt, committedAt }]  (unix seconds)
await repo.readCommit(sha)       // same shape as a log entry
await repo.readTree(treeHash)    // [{ name, mode: "40000"|"100644", hash, type: "tree"|"blob" }]  immediate children only
await repo.readFile({ ref, path }) // Blob (type "text/plain;charset=utf-8") or null
await env.ARTIFACTS.list({ limit })  // { repos: [{ ...info, status: "ready", jurisdiction: "us" }], total }
await env.ARTIFACTS.delete(name)     // true
```

readFile ref resolution:

| ref | Result |
|-----|--------|
| `main` | content |
| `v1.0.0` (annotated tag, short name) | content |
| commit SHA | content |
| `repair/v1.1.0` (branch name containing a slash) | content |
| `refs/heads/main` | **null** |
| `refs/tags/v1.0.0` | **null** |
| `refs/tags/light-v1` | **null** |
| missing path, or a directory | null |

`log({ ref: "refs/tags/v1.0.0" })` returns `[]`, while `log({ ref: "v1.0.0" })` works.

**Decision:** always pass short names (`main`, `v1.0.0`) or SHAs to the binding, never `refs/...`. To pin a fork runtime to a tag, resolve it once with `(await repo.log({ ref: tag, limit: 1 }))[0].hash`, then read files and key caches by that SHA. Event payloads carry full refs (`refs/heads/x`), so strip the `refs/heads/` or `refs/tags/` prefix before calling the binding.

Latency: create took about 1.7 to 2.5 s, info about 90 ms, and each readFile about 100 to 140 ms. Run readFile calls in parallel when loading many files.

## 3. isomorphic-git in a Worker

Requirements: `compatibilityFlags: ["nodejs_compat"]` plus `globalThis.Buffer ??= Buffer` (from `node:buffer`).

```ts
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
const onAuth = () => ({ username: "x", password: token.split("?expires=")[0] });
await git.clone({ fs, http, dir, url: remote, ref: "main", singleBranch: false, onAuth });
await git.branch({ fs, dir, ref: "user-a/custom", checkout: true });
await git.commit({ fs, dir, message: "...\n\nIntent-Id: x", author });
await git.push({ fs, http, dir, url: remote, ref: "user-a/custom", onAuth });
await git.annotatedTag({ fs, dir, ref: "v1.1.0", message, tagger: author });
await git.push({ fs, http, dir, url: remote, ref: "refs/tags/v1.1.0", onAuth });   // tags must be pushed explicitly
await git.addRemote({ fs, dir, remote: "stock", url: stockRemote });
await git.fetch({ fs, http, dir, remote: "stock", ref: "v1.1.0", tags: true, singleBranch: true, onAuth: stockAuth });
const tagOid = await git.resolveRef({ fs, dir, ref: "refs/tags/v1.1.0" });        // tag object OID
const commitOid = (await git.readTag({ fs, dir, oid: tagOid })).tag.object;       // peel
await git.merge({ fs, dir, ours: "main", theirs: commitOid, author, message });
```

Observed results:
- Fast-forward merge returns `{ oid, fastForward: true }`. A 3-way merge of disjoint changes returns `{ oid, tree, mergeCommit: true }`.
- On conflict with the default `abortOnConflict: true`, merge throws `MergeConflictError` with `data: { filepaths: ["shared.txt"], bothModified: [...], deleteByUs: [], deleteByTheirs: [] }`. The branch head stays unchanged.
- With `abortOnConflict: false`, merge also throws `MergeConflictError`, but it writes standard markers into the worktree (`<<<<<<< user-a/custom ... ======= ... >>>>>>> <sha>`).
- Manual resolution works: write the file, `git.add`, then `git.commit({ parent: [oursSha, theirsCommitSha], ref: "refs/heads/repair/v1.1.0" })` and push. `repo.log` on the repair branch shows both parents.
- One fetch can use a different repo's token than the push target. Every Artifacts token is scoped to a single repo.

Gotchas:
- **The MemoryFS on the docs page does not work with isomorphic-git 1.43.** isomorphic-git binds `readlink` and `symlink` unconditionally and throws `Cannot read properties of undefined (reading 'bind')`. It also branches on `err.code` (`ENOENT`, `ENOTDIR`). The spike's `src/memory-fs.ts` is the docs version plus coded errors and `readlink`/`symlink` stubs. Copy it into `platform/`.
- **`git.merge` does not peel annotated tags.** Passing `refs/tags/v1.1.0` throws `ObjectTypeError ... is a tag`. Peel to the commit first, as shown above.
- The lightweight tag `light-v1` and the annotated tag `v1.0.0` both pushed and listed correctly (`listServerRefs`).
- Push of a new branch to a repo took about 200 to 470 ms, and clone of a small repo about 520 ms.

Limits observed: the full scenario (2 clones, 5 pushes, a fetch, 4 merges, small repos of about 10 KB and 42 files in memory) took 4.3 s wall time and at most **231 ms CPU** (GraphQL `workersInvocationsAdaptive`). Median request CPU was about 1 ms. The memory footprint is trivial at stock-repo scale. Artifacts limits: 32 MB per blob, 1 GB per repo, and 2,000 git requests per 10 s per repo.

## 4. Worker Loader (Dynamic Workers)

Config: `LOADER: bindings.workerLoader()`. No resource is needed. Only Workers Paid has it. Billing counts each unique (id, code) pair once per day, so use `get()` with a stable id and avoid `load()`.

```ts
export class ConnectorHost extends WorkerEntrypoint<Env, { forkId: string }> {
  async whoami() { return { forkId: this.ctx.props.forkId }; }
}
// in fetch(request, env, ctx):
const sha = (await repo.log({ ref: "v1.0.0", limit: 1 }))[0].hash;
const worker = env.LOADER.get(`${repoName}:${sha}`, async () => ({
  compatibilityDate: "2026-10-01",
  mainModule: "app/index.js",
  modules: {                                    // read from Artifacts with repo.readFile
    "app/index.js": { js: indexText },
    "app/policy.js": { js: policyText },         // relative ESM imports between modules work
    "app/manifest.json": { json: JSON.parse(manifestText) },  // `import manifest from "./manifest.json"`
  },
  env: { HOST: ctx.exports.ConnectorHost({ props: { forkId: "user-a" } }) },  // parent RPC capability
  globalOutbound: null,                          // fetch() inside throws
}));
const card = await worker.getEntrypoint("Fork").ask({ question, context });   // JSON in, JSON out over RPC
const res = await worker.getEntrypoint().fetch("http://fork/ask", { method: "POST", body });  // default export fetch
```

The loaded module uses a named `WorkerEntrypoint` for RPC:

```js
import { WorkerEntrypoint } from "cloudflare:workers";
export class Fork extends WorkerEntrypoint { async ask(req) { /* this.env.HOST.whoami() */ } }
export default { async fetch(request) { ... } };
```

Measured deployed: about 420 ms to read 3 files plus log (sequential), a 17 ms cold RPC, and a 2 to 5 ms warm RPC. Loading `v1.0.0` and `v1.1.0` side by side gave the right versions. Local `cf dev` behaved the same.

Gotchas:
- **Modules must be JavaScript.** There is no TypeScript build step. **Decision:** stock and fork runtime code must be committed as plain ESM `.js`, with JSDoc types or `.d.ts` files if wanted. The alternative is a platform-side bundle step, for example `@cloudflare/worker-bundler`. Committing `.js` keeps the "every commit is instantly live" property. The contract in the plan says `stock/app/index.ts`, so change it to `stock/app/index.js`.
- `ctx.exports.<Class>` loopback works with compat date 2026-10-01 and no extra flag. Exported `WorkerEntrypoint` classes are picked up without an `exports` entry.
- With `get()`, the callback must return identical code for the same id. Key by commit SHA.

## 5. Workers AI through AI Gateway

The gateway was created with `cf ai-gateway gateways create --id fluid --collect-logs true --cache-ttl 0 ...` (billing mode postpaid, the default).

```ts
AI: bindings.ai({ dev: { remote: true } }),
const res = await env.AI.run(model, {
  messages: [...],
  response_format: { type: "json_schema", json_schema: SCHEMA },
  max_tokens: 600,
}, { gateway: { id: "fluid", skipCache: true } });
// env.AI.aiGatewayLogId is set after the call, which confirms the request went through the gateway
```

Classification prompt (schema `{mode enum, confidence number, signals string[]}`), all through the gateway:

| Model | Latency | Result | Output location |
|-------|---------|--------|-----------------|
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 1.7 s (2.4 s from local dev) | valid | `res.response` is an **already-parsed object** |
| `@cf/openai/gpt-oss-120b` | 5.4 s | valid | `res.choices[0].message.content` (JSON string) |
| `@cf/zai-org/glm-5.3-flash` | 6.0 s | valid, richest signals | `choices[0].message.content` |
| `@cf/qwen/qwen3.8-27b` | 11.5 s | valid | `choices[0].message.content` |
| `@cf/deepseek-ai/deepseek-v4-flash-0731` | 6.8 s | empty content | spent all 600 tokens on reasoning |
| `@cf/moonshotai/kimi-k2.6` | 11.8 s | empty content | same |

**Decision:** use `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for fast per-request structured calls. Use `@cf/openai/gpt-oss-120b` (or `@cf/zai-org/glm-5.3-flash`) for agent work such as code edits, test suggestion, and repair, inside Workflows where latency does not matter. Write one parser that accepts both `res.response` (object or string) and `res.choices[0].message.content`. Give reasoning models `max_tokens` of at least 2000. Always validate the parsed output against the schema in code, because Workers AI may return `JSON Mode couldn't be met`.

## 6. Queues + Artifacts event subscription

```sh
cf queues create --queue-name <queue>
cf queues subscriptions create --body '{"name":"fluid-artifacts","enabled":true,
  "source":{"type":"artifacts"},
  "destination":{"type":"queues.queue","queue_id":"<queue_id>"},
  "events":["repo.created","repo.forked","repo.pushed"]}'
cf queues subscriptions list
cf queues subscriptions delete <id> --force
```

Consumer config: `triggers: [triggers.queue({ name: "<queue>", maxBatchSize: 10, maxBatchTimeout: 1 })]`.

Gotchas:
- The `--source-type` flag on `cf queues subscriptions create` does not list `artifacts`. Use `--body`.
- Event names in the subscription are the **short** form (`repo.pushed`). The `cf.artifacts.repo.pushed` form is rejected with "Unrecognized event types".
- The docs list `pushed` as repo-level only, but an **account-level** `artifacts` source accepted `repo.pushed` and delivered pushes from every repo in the account. **Decision:** create one subscription for the platform, not one per fork. Filter by `source.namespace === "fluid"` in the consumer, because the source is account-wide (pushes to other namespaces, such as `argos`, were not tested but would also match).
- No `repo.forked` event arrived within about 3 minutes of a fork. Do not depend on it: use the return value of `fork()`.
- Push-to-consumer latency was about 3 s. Each ref in a push produces its own event: main, every tag, every branch.
- Pushes made from local `cf dev` also reach the deployed consumer, because the subscription is account-wide.

Exact payload received for a new branch push:

```json
{
  "type": "cf.artifacts.repo.pushed",
  "source": { "namespace": "fluid", "repoName": "spike-user-a-r5", "type": "artifacts" },
  "metadata": { "accountId": "d815...", "eventSubscriptionId": "5162...", "eventSchemaVersion": 1,
                "eventTimestamp": "2026-10-03T21:31:44.205Z" },
  "payload": {
    "ref": "refs/heads/user-a/evt1",
    "before": "0000000000000000000000000000000000000000",
    "after": "51e4fce944f2e5d131e3e6b7b8457ecc3a34e6a2",
    "commits": [ { "id": "51e4...", "message": "event probe", "messageTruncated": false,
                   "timestamp": "2026-10-03T21:31:43.000Z",
                   "author": { "name": "...", "email": "..." }, "committer": { ... },
                   "parents": ["06c0..."] }, "...whole reachable history for a new branch..." ],
    "totalCommitsCount": 3,
    "commitsTruncated": false
  }
}
```

- A tag push has `ref: "refs/tags/v1.0.0"`, `after` = the tag object OID for an annotated tag, `commits: []`, and `totalCommitsCount: 0`.
- `before` is all zeros when a ref is created.
- `repo.created` payload: `{ repoId, defaultBranch, description, readOnly, createdAt, updatedAt, lastPushAt }`, with `source.type: "artifacts"`.

## 7. Workflows

Declare the workflow as an export. It needs no binding: call it through `ctx.exports`.

```ts
exports: { SpikeGate: exports.workflow({ name: "fluid-spike-gate" }) },  // name is unique per account
```

```ts
export class SpikeGate extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const r = await step.do("flaky", { retries: { limit: 3, delay: "2 seconds", backoff: "constant" }, timeout: "30 seconds" }, async () => {...});
    await step.sleep("nap", "3 seconds");
    const ev = await step.waitForEvent("await-approval", { type: "approval", timeout: "2 minutes" }); // throws on timeout
    return { r, ev };
  }
}
// queue(batch, env, ctx):
const inst = await ctx.exports.SpikeGate.create({ params: { repo, ref, after } });
// elsewhere:
await (await ctx.exports.SpikeGate.get(id)).status();   // { status: "running"|"complete"|..., output, error }
await (await ctx.exports.SpikeGate.get(id)).sendEvent({ type: "approval", payload: {...} });
```

Results: the consumer started an instance per push event. The step failed on attempt 1 and passed on attempt 2. Inside a step, a fresh `env.ARTIFACTS.get()` read of the pushed SHA worked. sendEvent resumed `waitForEvent`, and the output came back intact. `waitForEvent` returned `{ type, payload, timestamp }`. Local `cf dev` runs workflows too; its status adds `__LOCAL_DEV_STEP_OUTPUTS`.

Gotchas:
- Deploying creates the workflow. Deleting it needs `cf workflows delete <name> --force` before or after deleting the Worker.
- Keep `using` handles inside the step closure, because step results must be serializable.

## 8. Durable Objects with SQLite

```ts
exports: { EventLog: exports.durableObject({ storage: "sqlite" }) },
env:     { EVENT_LOG: bindings.durableObject({ worker: "fluid-spike", exportName: "EventLog" }) },
```

```ts
export class EventLog extends DurableObject<Env> {
  constructor(ctx, env) { super(ctx, env); ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS ..."); }
  add(kind: string, body: unknown) { this.ctx.storage.sql.exec("INSERT ...", ...); return this.ctx.storage.sql.exec("SELECT count(*) AS n FROM events").one().n; }
}
const stub = env.EVENT_LOG.get(env.EVENT_LOG.idFromName("spike"));
await stub.add("manual", { hello: "world" });   // RPC
```

On deploy, cf reported "Durable Object exports reconciliation: Created: EventLog". It wrote no migrations block by hand. RPC calls from fetch, the queue consumer, and Workflow steps all worked. `sql.exec` runs one statement per call, so split multi-statement DDL into separate calls.

## 9. Static assets for an SPA

```ts
assets: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*"] },
```

Put the files in `public/`, the Vite `publicDir`. `cloudflare.config.ts` has no `assets.directory`. `/some/client/route` served `index.html`, and `/api/*` reached the Worker.

## Deployment and local dev notes

- **Secrets:** declare `SPIKE_SECRET: bindings.secret()`. The first deploy of a new Worker fails until the secret exists, so deploy with `cf deploy --secrets-file <file outside the repo>` (one `NAME=value` line per secret). Later deploys keep the secret. `cf workers secrets update --worker <name> --text ...` also works once the Worker exists. Locally, `cf dev` picks the secret up from the process environment (`SPIKE_SECRET=... npx cf dev`), so no `.dev.vars` file is needed.
- **Local dev with remote bindings:** prefix `cf dev` with `CLOUDFLARE_API_TOKEN="$(jq -r .oauth_token ~/Library/Preferences/cloudflare/config/default.json)" CLOUDFLARE_ACCOUNT_ID=...`, and run `cf auth whoami` first so the token is fresh. `cf dev --port` is rejected, and the server listens on `http://localhost:5173`. Artifacts (remote), AI (remote), Worker Loader, Durable Objects, and Workflows (local simulation) all worked. Queue events from the subscription go only to the deployed consumer.
- A new deploy can take a few seconds to reach all requests, and early requests may still hit the previous version.
- `workers.dev` and preview URLs are enabled by default. Set them explicitly before the public demo.
- `cf workers delete` refuses while the Worker is a queue consumer. Delete the queue first (`cf queues delete <id> --force`).
- Destructive `cf` commands need `--force` in a non-interactive shell.

## Decisions for later stages

1. The fork runtime code in stock is plain ESM JavaScript (`stock/app/index.js`, with relative imports and `.json` modules). The platform loads it with `LOADER.get("<repo>:<sha>", ...)`, calls the named entrypoint `Fork.ask()` over RPC, and passes `globalOutbound: null`. Connectors reach synthetic data only through `ctx.exports` RPC capabilities passed in `env`.
2. Binding calls use short refs or SHAs. Tags resolve to SHAs through `log()`.
3. Git writes go through isomorphic-git with the patched MemoryFS (`fluid-spike/src/memory-fs.ts`). Annotated tags are peeled before merge. A conflict produces a `repair/<tag>` branch with a manually resolved two-parent commit, or the conflict is reported and the fork is left pinned.
4. One account-level Artifacts subscription (`repo.pushed`, short event name) feeds one queue. The consumer filters on namespace `fluid` and on refs of the form `refs/heads/user-*` (or the chosen work-branch prefix), then starts the Gate workflow through `ctx.exports`.
5. Models go through gateway `fluid`: llama-3.3-70b-fp8-fast for fast structured calls, gpt-oss-120b for agent work. Output is parsed with a shape-tolerant reader and validated in code.
6. Durable Objects and Workflows are declared through `exports` in `cloudflare.config.ts`. Workflows are called through `ctx.exports`, and DOs through a `bindings.durableObject({ worker: "<self>", exportName })` binding.

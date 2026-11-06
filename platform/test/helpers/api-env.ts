// A Worker env for route tests: Durable Objects over the in-memory SQLite
// fake, and a fake Artifacts binding that records token calls and reads
// seeded in-memory repositories (fake-repos.ts). Nothing here reaches the
// network.
import { Fleet } from "../../src/durable/fleet.ts";
import { Quota } from "../../src/durable/quota.ts";
import { Runs } from "../../src/durable/runs.ts";
import { UserLedger } from "../../src/durable/user-ledger.ts";
import { signSession, SESSION_COOKIE, type Session } from "../../src/lib/session.ts";
import { construct } from "./durable.ts";
import { fakeGitRepo, type FakeGitRepo, type RepoSeed } from "./fake-repos.ts";

export const SECRET = "test-session-secret-0123456789abcdef";

function namespace(Class: new (ctx: never, env: never) => unknown, env: () => unknown) {
	const instances = new Map<string, unknown>();
	return {
		idFromName: (name: string) => name,
		get: (id: string) => {
			if (!instances.has(id)) instances.set(id, construct(Class, env()).instance);
			return instances.get(id);
		},
	};
}

export interface FakeRepo {
	name: string;
	tokens: { id: string; scope: string; ttl: number; revoked: boolean }[];
	forkedFrom: string | null;
	revokeResult: boolean;
	/** The repository's content: empty unless seeded. */
	git: FakeGitRepo;
}

const REMOTE_BASE = "https://acct.artifacts.cloudflare.net/git/fluid/";
const REF_LISTING = ".git/info/refs?service=git-upload-pack";

export function fakeArtifacts() {
	const repos = new Map<string, FakeRepo>();
	const deletedNames: string[] = [];
	const add = (name: string) => {
		repos.set(name, { name, tokens: [], forkedFrom: null, revokeResult: true, git: fakeGitRepo() });
	};
	const handle = (repo: FakeRepo) => ({
		info: async () => ({ name: repo.name, remote: `${REMOTE_BASE}${repo.name}.git` }),
		// Reads see the repo's current content, so seeding it again shows through handles already open.
		log: (options?: { ref?: string; limit?: number; offset?: number }) => repo.git.log(options),
		readCommit: (hash: string) => repo.git.readCommit(hash),
		readTree: (hash: string) => repo.git.readTree(hash),
		readBlob: (hash: string) => repo.git.readBlob(hash),
		readFile: (args: { ref: string; path: string }) => repo.git.readFile(args),
		createToken: async (scope: string, ttl: number) => {
			const id = `tok_${repo.name}_${repo.tokens.length + 1}`;
			repo.tokens.push({ id, scope, ttl, revoked: false });
			return { id, plaintext: `art_v2_${"s".repeat(20)}${repo.tokens.length}?expires=1790000000`, scope, expiresAt: "2026-10-06T13:00:00.000Z" };
		},
		revokeToken: async (id: string) => {
			const token = repo.tokens.find((t) => t.id === id);
			if (!token || !repo.revokeResult) return false;
			token.revoked = true;
			return true;
		},
		// Unlike Artifacts, the fork starts empty: it does not copy this repo's main. Tests seed() forks they read.
		fork: async (name: string, _opts?: unknown) => {
			if (repos.has(name)) throw new Error(`repo ${name} already exists`);
			repos.set(name, { name, tokens: [], forkedFrom: repo.name, revokeResult: true, git: fakeGitRepo() });
			return { name };
		},
		[Symbol.dispose]: () => undefined,
	});
	return {
		repos,
		add,
		/**
		 * Creates the repo if needed and replaces its content with the seeded
		 * history; returns that content (commit ids in seed order). Seed a new
		 * tag name rather than moving a tag: src/stock/suite.ts caches a release
		 * tag's commit (and its suite) by tag name for the life of the module,
		 * so a moved tag keeps resolving to its first commit within a test file.
		 */
		seed(name: string, seed: RepoSeed): FakeGitRepo {
			if (!repos.has(name)) add(name);
			const git = fakeGitRepo(seed);
			repos.get(name)!.git = git;
			return git;
		},
		/**
		 * A stand-in for global fetch (vi.stubGlobal) that answers the ref
		 * listing of a repo's git remote, which the platform reads without
		 * cloning (listRemoteRefs: stock/suite.ts resolves a release tag with
		 * it). Any other request fails, so a test never reaches the network.
		 * It answers in git protocol v1 only and never asks for credentials.
		 */
		fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = input instanceof Request ? input.url : String(input);
			const name = url.startsWith(REMOTE_BASE) && url.endsWith(REF_LISTING) ? url.slice(REMOTE_BASE.length, -REF_LISTING.length) : null;
			if (name === null) throw new Error(`no network in tests: ${init?.method ?? "GET"} ${url}`);
			const repo = repos.get(name);
			if (!repo) return new Response(`repository ${name} not found`, { status: 404 });
			return new Response(repo.git.advertisement(), { headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
		},
		deleted: deletedNames,
		binding: {
			delete: async (name: string) => {
				if (repos.delete(name)) deletedNames.push(name);
				return deletedNames.includes(name);
			},
			get: async (name: string) => {
				const repo = repos.get(name);
				if (!repo) throw new Error(`repository ${name} not found`);
				return handle(repo);
			},
		},
	};
}

export function apiEnv() {
	const artifacts = fakeArtifacts();
	const env: Record<string, unknown> = { SESSION_SECRET: SECRET, ADMIN_TOKEN: "admin-token", ARTIFACTS: artifacts.binding };
	env.FLEET = namespace(Fleet as never, () => env);
	env.QUOTA = namespace(Quota as never, () => env);
	env.RUNS = namespace(Runs as never, () => env);
	env.USER_LEDGER = namespace(UserLedger as never, () => env);
	return { env: env as unknown as Env, artifacts, fleet: (env.FLEET as { get(id: string): Fleet }).get("global") };
}

/** An ExecutionContext whose workflow exports record what they were asked to create. */
export function workerContext() {
	const created: { workflow: string; id?: string; params: unknown }[] = [];
	const sent: { workflow: string; id: string; event: unknown }[] = [];
	const workflow = (name: string) => ({
		create: async (o: { id?: string; params: unknown }) => (created.push({ workflow: name, ...o }), { id: o.id ?? "x" }),
		get: async (id: string) => ({ status: async () => ({ status: "running" }), sendEvent: async (event: unknown) => void sent.push({ workflow: name, id, event }) }),
	});
	const exports = new Proxy({}, { get: (_t, name: string) => workflow(name) });
	return { created, sent, ctx: { waitUntil: () => undefined, passThroughOnException: () => undefined, exports } as unknown as ExecutionContext };
}

export async function cookieFor(session: Partial<Session> & { userId: string }): Promise<string> {
	const value = await signSession({ persona: "hospitalist-researcher", issuedAt: Date.now(), ...session }, SECRET);
	return `${SESSION_COOKIE}=${value}`;
}

export function post(path: string, headers: Record<string, string> = {}, body: unknown = {}): Request {
	return new Request(`https://fluid.test${path}`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers }, body: JSON.stringify(body) });
}

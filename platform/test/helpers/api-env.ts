// A Worker env for route tests: Durable Objects over the in-memory SQLite
// fake, and a fake Artifacts binding that records token calls. Nothing here
// reaches the network.
import { Fleet } from "../../src/durable/fleet.ts";
import { Quota } from "../../src/durable/quota.ts";
import { Runs } from "../../src/durable/runs.ts";
import { signSession, SESSION_COOKIE, type Session } from "../../src/lib/session.ts";
import { construct } from "./durable.ts";

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
}

export function fakeArtifacts() {
	const repos = new Map<string, FakeRepo>();
	const handle = (repo: FakeRepo) => ({
		info: async () => ({ name: repo.name, remote: `https://acct.artifacts.cloudflare.net/git/fluid/${repo.name}.git` }),
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
		fork: async (name: string, _opts?: unknown) => {
			if (repos.has(name)) throw new Error(`repo ${name} already exists`);
			repos.set(name, { name, tokens: [], forkedFrom: repo.name, revokeResult: true });
			return { name };
		},
		[Symbol.dispose]: () => undefined,
	});
	return {
		repos,
		add(name: string) {
			repos.set(name, { name, tokens: [], forkedFrom: null, revokeResult: true });
		},
		binding: {
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
	return { env: env as unknown as Env, artifacts, fleet: (env.FLEET as { get(id: string): Fleet }).get("global") };
}

export async function cookieFor(session: Partial<Session> & { userId: string }): Promise<string> {
	const value = await signSession({ persona: "hospitalist-researcher", issuedAt: Date.now(), ...session }, SECRET);
	return `${SESSION_COOKIE}=${value}`;
}

export function post(path: string, headers: Record<string, string> = {}, body: unknown = {}): Request {
	return new Request(`https://fluid.test${path}`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers }, body: JSON.stringify(body) });
}

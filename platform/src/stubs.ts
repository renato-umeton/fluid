// Typed access to the Durable Object namespaces. The generated binding types
// do not carry the class types through, and the runtime's RPC type mapping is
// too deep for these record types, so each stub is presented as its class's
// public methods returning promises. The casts live here, once.
import type { Fleet } from "./durable/fleet.ts";
import type { Quota } from "./durable/quota.ts";
import type { Runs } from "./durable/runs.ts";
import type { UserLedger } from "./durable/user-ledger.ts";

type Base = keyof import("cloudflare:workers").DurableObject;

/** Public methods of a Durable Object class as seen through an RPC stub. */
export type Rpc<T> = {
	[K in Exclude<keyof T, Base> as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

function stub<T>(ns: unknown, name: string): Rpc<T> & { fetch(request: Request): Promise<Response> } {
	const namespace = ns as DurableObjectNamespace;
	return namespace.get(namespace.idFromName(name)) as unknown as Rpc<T> & { fetch(request: Request): Promise<Response> };
}

export const fleetStub = (env: Env) => stub<Fleet>(env.FLEET, "global");
export const ledgerStub = (env: Env, userId: string) => stub<UserLedger>(env.USER_LEDGER, userId);
export const runsStub = (env: Env, runId: string) => stub<Runs>(env.RUNS, runId);
export const quotaStub = (env: Env, subject: string) => stub<Quota>(env.QUOTA, subject);

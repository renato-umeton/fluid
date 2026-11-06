// A Worker Loader binding (env.LOADER) for Node tests. get(id, factory) keeps
// one isolate per id, as the real loader does: the factory runs once, on the
// first call into the isolate. Its module map is written under
// test/.tmp-loader-<random>/<id>/ and its main module imported through
// vitest, which transforms these files like any other file of the project.
// So the alias in vitest.config.ts applies to them and cloudflare:workers
// resolves to test/helpers/cloudflare-workers.ts with no rewriting
// (entrypointClass checks that it did).
//
// Kept from a real isolate: each id has its own directory and so its own
// module instances (module state stays per isolate), the env is the
// factory's, and calls cross a boundary like Workers RPC (see overRpc).
// Not kept: every fake isolate shares one Node realm with the platform and
// the test, so globals and built-in prototypes are common to all of them and
// fork code that patches them affects everyone. Imports resolve as in Node
// (node: builtins load where an isolate would refuse them), globalOutbound
// null is not enforced (stub fetch to keep tests off the network), and there
// are no CPU or memory limits.
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModuleMap } from "../../src/runtime/modules.ts";
import { WorkerEntrypoint } from "./cloudflare-workers.ts";
import { materialize } from "./materialize.ts";

const TEST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The part of WorkerLoaderWorkerCode the platform passes. */
export interface WorkerCode extends ModuleMap {
	compatibilityDate: string;
	env?: Record<string, unknown>;
	globalOutbound?: null;
}

/** An entrypoint stub: any method name is a call into the isolate, as on an RPC stub. */
export type EntrypointStub = Record<string, (...args: unknown[]) => Promise<unknown>>;

/**
 * Properties that stay undefined on a stub: await, JSON.stringify, and
 * vitest's matchers probe them, and none is a method of the platform's
 * entrypoints. Answering them with calls would make the stub a thenable, or
 * turn a printed or compared stub into stray calls and false matches.
 */
const NOT_METHODS = new Set(["then", "toJSON", "asymmetricMatch"]);

export type FakeLoader = ReturnType<typeof fakeLoader>;

export function fakeLoader() {
	// A directory per loader: test files run in parallel, and a new loader starts with fresh module instances.
	const dir = mkdtempSync(join(TEST_DIR, ".tmp-loader-"));
	const built: string[] = [];
	const factories = new Map<string, () => WorkerCode | Promise<WorkerCode>>();
	const isolates = new Map<string, Promise<{ exports: Record<string, unknown>; env: unknown }>>();

	const boot = async (id: string) => {
		built.push(id);
		const code = await factories.get(id)!();
		const exports = await materialize<Record<string, unknown>>(code, join(dir, id.replace(/[^A-Za-z0-9._-]/g, "_")), code.mainModule);
		return { exports, env: overRpc(code.env ?? {}) };
	};
	const isolate = (id: string) => {
		if (!isolates.has(id)) isolates.set(id, boot(id));
		return isolates.get(id)!;
	};

	return {
		/** Ids of the isolates whose factory ran, in order. */
		built,
		get(id: string, factory: () => WorkerCode | Promise<WorkerCode>) {
			if (!factories.has(id)) factories.set(id, factory);
			return {
				getEntrypoint(name: string, options: { props?: unknown } = {}): EntrypointStub {
					const call = async (method: string, args: unknown[]): Promise<unknown> => {
						const { exports, env } = await isolate(id);
						const Class = entrypointClass(exports, id, name);
						const ctx = { props: options.props ?? {}, waitUntil: () => undefined };
						// The stand-in WorkerEntrypoint ignores its constructor arguments, so env and ctx are set on the instance.
						const instance = Object.assign(new Class(ctx, env), { ctx, env }) as Record<string, unknown>;
						const fn = instance[method];
						if (typeof fn !== "function") throw new Error(`${id}: entrypoint ${name} has no method ${method}`);
						return crossCall((...a: unknown[]) => fn.apply(instance, a), args);
					};
					return new Proxy({}, { get: (_target, method) => (typeof method === "string" && !NOT_METHODS.has(method) ? (...args: unknown[]) => call(method, args) : undefined) });
				},
			};
		},
		/** Removes this loader's modules from disk (afterAll). */
		cleanup() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** The named export as an entrypoint class, checked to extend the stand-in so a cloudflare:workers import that resolved elsewhere fails here. */
function entrypointClass(exports: Record<string, unknown>, id: string, name: string): new (ctx: unknown, env: unknown) => object {
	const Class = exports[name];
	if (typeof Class !== "function") throw new Error(`${id}: the main module exports no entrypoint ${name}`);
	if (!(Class.prototype instanceof WorkerEntrypoint)) throw new Error(`${id}: ${name} does not extend the WorkerEntrypoint of test/helpers/cloudflare-workers.ts`);
	return Class as new (ctx: unknown, env: unknown) => object;
}

/** Calls fn with arguments, result, and any error crossing the RPC boundary. */
async function crossCall(fn: (...args: unknown[]) => unknown, args: unknown[]): Promise<unknown> {
	try {
		return overRpc(await fn(...args.map(overRpc)));
	} catch (error) {
		throw overRpc(error);
	}
}

/**
 * A value as the other side of a Workers RPC call receives it: data is
 * structured-cloned (so neither side sees the other mutate it), a function
 * becomes an async callback whose calls cross the same way, and an error
 * keeps only its message and a built-in error type, as structured clone keeps.
 */
function overRpc(value: unknown): unknown {
	if (typeof value === "function") return (...args: unknown[]) => crossCall(value as (...a: unknown[]) => unknown, args);
	if (Array.isArray(value)) return value.map(overRpc);
	if (value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
		return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, overRpc(inner)]));
	}
	return structuredClone(value);
}

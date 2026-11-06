// A Worker Loader binding (env.LOADER) for Node tests. get(id, factory) keeps
// one isolate per id, as the real loader does: the factory runs once, on the
// first call into the isolate. Its module map is written under
// test/.tmp-loader-<random>/<boot order>-<id>/ and its main module imported through
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
		// Boot order makes the folder unique: ids that differ only in punctuation or case would otherwise share
		// one, and the second isolate would run the first one's modules.
		const folder = `${built.push(id)}-${id.replace(/[^A-Za-z0-9._-]/g, "_")}`;
		const code = await factories.get(id)!();
		const exports = await materialize<Record<string, unknown>>(code, join(dir, folder), code.mainModule);
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
					const invoke = (method: string) => async (...args: unknown[]): Promise<unknown> => {
						const { exports, env } = await isolate(id);
						const Class = entrypointClass(exports, id, name);
						const ctx = { props: options.props ?? {}, waitUntil: () => undefined };
						// The stand-in WorkerEntrypoint ignores its constructor arguments, so env and ctx are set on the instance.
						const instance = Object.assign(new Class(ctx, env), { ctx, env }) as Record<string, unknown>;
						const fn = instance[method];
						if (typeof fn !== "function") throw new Error(`${id}: entrypoint ${name} has no method ${method}`);
						return fn.apply(instance, args);
					};
					// The Error made at the call holds the caller's stack, which an error thrown back carries.
					return new Proxy({}, { get: (_target, method) => (typeof method === "string" && !NOT_METHODS.has(method) ? (...args: unknown[]) => crossCall(invoke(method), args, new Error()) : undefined) });
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

type Callable = (...args: unknown[]) => unknown;

/**
 * One call across the boundary. The arguments are copied when the call is
 * made (a value that cannot cross fails it there), then the result is
 * copied back, or the error: a thrown string arrives as an Error, and an
 * error carries the caller's stack from `site`, never the thrower's.
 */
async function crossCall(fn: Callable, args: unknown[], site: Error): Promise<unknown> {
	const sent = overRpc(args) as unknown[];
	try {
		return overRpc(await fn(...sent));
	} catch (thrown) {
		const crossed = overRpc(typeof thrown === "string" ? new Error(thrown) : thrown);
		if (crossed instanceof Error) setStack(crossed, site.stack!.split("\n").slice(1).join("\n"));
		throw crossed;
	}
}

/** Types structured clone copies faithfully; they cross as it copies them. */
const CLONED_TYPES = [Date, Map, Set, RegExp, ArrayBuffer, Blob];

/**
 * A value as the other side of a Workers RPC call receives it. Arrays and
 * plain objects (prototype Object.prototype) are copied with their own
 * enumerable properties, shared references and cycles kept. Date, Map, Set,
 * RegExp, ArrayBuffer and its views, and Blob go through structured clone.
 * A function becomes an async callback whose calls cross the same way. An
 * error keeps its type when built in, its name, message, cause, and own
 * enumerable properties, but not the thrower's stack. Anything else, a
 * class instance or a null-prototype object included, throws DataCloneError
 * as workerd does. Not modeled: RpcTarget, streams, Request and Response,
 * which Workers RPC can send.
 */
function overRpc(value: unknown): unknown {
	return cross(value, new Map());
}

function cross(value: unknown, seen: Map<object, unknown>): unknown {
	if (typeof value === "function") return (...args: unknown[]) => crossCall(value as Callable, args, new Error());
	if (typeof value === "symbol") throw dataCloneError("Symbol");
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return seen.get(value);
	if (value instanceof Error) return copyError(value, seen);
	if (Array.isArray(value)) return copyOwn(value, new Array(value.length), seen);
	if (Object.getPrototypeOf(value) === Object.prototype) return copyOwn(value, {}, seen);
	if (ArrayBuffer.isView(value) || CLONED_TYPES.some((type) => value instanceof type)) {
		const copy = structuredClone(value);
		seen.set(value, copy);
		return copy;
	}
	throw dataCloneError((value as { constructor?: { name?: string } }).constructor?.name || "Object");
}

function copyOwn<T extends object>(source: object, target: T, seen: Map<object, unknown>): T {
	seen.set(source, target);
	for (const key of Object.keys(source)) define(target, key, cross((source as Record<string, unknown>)[key], seen));
	return target;
}

function copyError(error: Error, seen: Map<object, unknown>): Error {
	// Structured clone keeps a built-in error type, the message, and the cause; in Node it turns a DOMException into a plain object.
	const copy: Error = error instanceof DOMException ? new DOMException(error.message, error.name) : structuredClone(error);
	seen.set(error, copy);
	if (copy.name !== error.name) copy.name = error.name;
	if (Object.hasOwn(error, "cause")) copy.cause = cross(error.cause, seen);
	for (const key of Object.keys(error)) define(copy, key, cross((error as unknown as Record<string, unknown>)[key], seen));
	setStack(copy, "");
	return copy;
}

/** Sets the stack an error shows: its own header, then `frames` (stack lines without a header). */
function setStack(error: Error, frames: string): void {
	const header = error.message ? `${error.name}: ${error.message}` : error.name;
	Object.defineProperty(error, "stack", { value: frames ? `${header}\n${frames}` : header, writable: true, configurable: true });
}

/** Defines a data property, so a key such as __proto__ stays an own key instead of invoking a setter. */
function define(target: object, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function dataCloneError(type: string): DOMException {
	return new DOMException(`Could not serialize object of type "${type}". This type does not support serialization.`, "DataCloneError");
}

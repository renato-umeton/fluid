// Workflow bindings for ctx.exports in Node tests, close to the real ones
// where the platform relies on them: create refuses an id that already
// exists (the platform counts that as started), createBatch creates each
// instance in turn, and get finds only instances that exist. Params are
// copied as the binding serializes them. Every instance created is recorded
// in order; nothing runs, a test runs a workflow class itself. Export names
// ending in "Workflow" are bindings; any other name comes from `extra` (for
// example LlmHost).
export interface CreatedInstance {
	workflow: string;
	id: string;
	params: unknown;
}

const WORKFLOW_EXPORT = /^[A-Z][A-Za-z]*Workflow$/;

export function fakeWorkflows(extra: Record<string, unknown> = {}) {
	const created: CreatedInstance[] = [];
	const batches: { workflow: string; ids: string[] }[] = [];
	const exists = (workflow: string, id: string) => created.some((instance) => instance.workflow === workflow && instance.id === id);
	const handle = (id: string) => ({ id, status: async () => ({ status: "running" }), sendEvent: async () => undefined });
	const binding = (workflow: string) => {
		const create = async (options: { id?: string; params: unknown }) => {
			const id = options.id ?? crypto.randomUUID();
			if (exists(workflow, id)) throw new Error(`instance ${id} already exists`);
			created.push({ workflow, id, params: structuredClone(options.params) });
			return handle(id);
		};
		return {
			create,
			createBatch: async (items: { id?: string; params: unknown }[]) => {
				batches.push({ workflow, ids: items.map((item) => item.id ?? "") });
				const handles = [];
				for (const item of items) handles.push(await create(item));
				return handles;
			},
			get: async (id: string) => {
				if (!exists(workflow, id)) throw new Error(`instance ${id} not found`);
				return handle(id);
			},
		};
	};
	const exports = new Proxy(extra, { get: (target, name) => (typeof name === "string" && WORKFLOW_EXPORT.test(name) ? binding(name) : (target as Record<string | symbol, unknown>)[name]) });
	const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, exports } as unknown as ExecutionContext;
	return {
		created,
		batches,
		exports: exports as Record<string, never>,
		ctx,
		/** The instances created of one workflow, by its export name. */
		of: (workflow: string) => created.filter((instance) => instance.workflow === workflow),
	};
}

/** A workflow step stand-in that runs every step at once, records its name and config, and copies its result as the engine stores it. */
export function fakeSteps() {
	const done: { name: string; config?: unknown }[] = [];
	const slept: string[] = [];
	const step = {
		do: async (name: string, ...rest: unknown[]) => {
			done.push({ name, ...(rest.length > 1 ? { config: rest[0] } : {}) });
			return structuredClone(await (rest.at(-1) as () => Promise<unknown>)());
		},
		sleep: async (name: string) => void slept.push(name),
		waitForEvent: async () => {
			throw new Error("these tests send no events");
		},
	};
	return { step, done, slept, names: () => done.map((entry) => entry.name) };
}

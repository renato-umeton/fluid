// Stand-in for the runtime module in Node tests: just enough of the base
// classes for Durable Objects and entrypoints to be constructed directly.
export class DurableObject<E = unknown> {
	constructor(
		protected ctx: DurableObjectState,
		protected env: E,
	) {}
}

export class WorkerEntrypoint<E = unknown, P = unknown> {
	protected ctx!: ExecutionContext & { props: P };
	protected env!: E;
}

export class WorkflowEntrypoint<E = unknown, P = unknown> {
	protected ctx!: ExecutionContext;
	protected env!: E;
	declare readonly params?: P;
}

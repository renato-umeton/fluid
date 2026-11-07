// The rotation instances this isolate has started, or found already started,
// by instance id. A flood of requests tripping one copy then awaits no
// duplicate create on the Workflows binding. A live-path rotation id carries
// its ten-minute window, so remembering one never holds a later rotation
// back. Bounded; the loader's clearRuntimeCache forgets them all, as a new
// isolate would.
const started = new Set<string>();
const STARTED_LIMIT = 1000;

/** Whether this isolate started the rotation with this instance id, or found it started. */
export function rotationStarted(id: string): boolean {
	return started.has(id);
}

export function rememberRotation(id: string): void {
	if (started.has(id)) return;
	if (started.size >= STARTED_LIMIT) started.delete(started.values().next().value!);
	started.add(id);
}

export function forgetRotations(): void {
	started.clear();
}

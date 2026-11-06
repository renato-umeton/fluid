// Keeps a value small enough to store and show: a gate failure's expected and
// actual values, a security event's detail. Lives apart from the gate rules so
// a Durable Object can clip without loading them.

const MAX_VALUE_CHARS = 400;

/** The value itself when its text (JSON for anything but a string) fits; otherwise the start of that text and its length. */
export function clipValue(value: unknown): unknown {
	if (value === undefined) return null;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (text === undefined) return String(value);
	if (text.length <= MAX_VALUE_CHARS) return value;
	return `${text.slice(0, MAX_VALUE_CHARS)}... (${text.length} chars)`;
}

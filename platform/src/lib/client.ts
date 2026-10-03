// Client keys for per-client quotas. IPv4 addresses are used as they are.
// An IPv6 client usually controls a whole /64, so IPv6 addresses are keyed
// by their first four groups; otherwise one host could rotate addresses to
// get a fresh quota for every request.

/** Quota key for the address in cf-connecting-ip, or "local" when there is none (local dev). */
export function clientKey(address: string | null | undefined): string {
	const value = (address ?? "").trim().toLowerCase();
	if (value === "") return "local";
	if (!value.includes(":")) return value;
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
	if (mapped) return mapped[1]!;
	const groups = expandIpv6(value);
	if (!groups) return value;
	return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** The eight groups of an IPv6 address, or null when it does not parse. */
function expandIpv6(address: string): string[] | null {
	const halves = address.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...tail];
	return groups.every((g) => /^[0-9a-f]{1,4}$/.test(g)) ? groups : null;
}

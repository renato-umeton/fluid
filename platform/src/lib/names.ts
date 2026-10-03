// Repository and identifier naming. Artifacts repo names allow letters,
// digits, ".", "_", "-", must start with a letter or digit, and may not
// contain "/".

export const REPO_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
export const STOCK_REPO = "stock";

export function isValidRepoName(name: string): boolean {
	return typeof name === "string" && REPO_NAME_PATTERN.test(name) && !name.endsWith(".git");
}

/** Sandbox user ids are lowercase letters, digits, and dashes. */
export function normalizeUserId(userId: string): string {
	const id = String(userId ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (id === "" || id.length > 48) throw new Error(`invalid user id ${JSON.stringify(userId)}`);
	return id;
}

export function forkRepoName(userId: string): string {
	return assertRepoName(`user-${normalizeUserId(userId)}`);
}

export function ledgerRepoName(userId: string): string {
	return assertRepoName(`ledger-${normalizeUserId(userId)}`);
}

export function userIdFromForkRepo(repo: string): string | null {
	return /^user-([a-z0-9-]+)$/.exec(repo)?.[1] ?? null;
}

export function assertRepoName(name: string): string {
	if (!isValidRepoName(name)) throw new Error(`invalid repository name ${JSON.stringify(name)}`);
	return name;
}

/** Random sandbox user id, for example "s-3f9a1c2b7d". */
export function newSandboxUserId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(5));
	return `s-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Build-time intent id in the stock style: int_YYYY_MM_DD_<suffix>. */
export function newIntentId(now = new Date(), suffix?: string): string {
	const date = now.toISOString().slice(0, 10).replace(/-/g, "_");
	const tail = suffix ?? [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `int_${date}_${tail}`;
}

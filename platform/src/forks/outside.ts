// Bring your own agent: a short-lived write token that lets the fork's owner
// push to their fork with plain git. Artifacts tokens are scoped to one repo
// but not to branches, so main is protected by the platform instead (see
// main-guard.ts): only work/* pushes reach the gate, and a push to main that
// the platform did not make is undone. The token is returned to its owner
// once and never logged.
import { scrubText, tokenSecret } from "../git/tokens.ts";

export const OUTSIDE_TOKEN = { ttlSeconds: 3600, branchPrefix: "work/" } as const;

/** The parts of an Artifacts repo handle the token route uses. */
export interface TokenRepo {
	info(): Promise<{ remote: string }>;
	createToken(scope: "write" | "read", ttl: number): Promise<{ id: string; plaintext: string; scope: string; expiresAt: string }>;
	revokeToken(tokenOrId: string): Promise<boolean>;
}

export interface OutsideAccess {
	repo: string;
	remote: string;
	token: string;
	expiresAt: string;
	branchPrefix: string;
	commands: string[];
}

/**
 * Fleet value that marks a fork as reachable from outside. It is written
 * before the first token exists and never removed, so main protection is on
 * for as long as any outside token might be live.
 */
export interface OutsideGrant {
	repo: string;
	userId: string;
	tokenId: string | null;
	firstAt: string;
	mintedAt: string;
	expiresAt: string | null;
}

export function outsideGrantKey(repo: string): string {
	return `outside:${repo}`;
}

/** The remote with the token's secret as the password (git asks for no credentials then). */
export function authedRemote(remote: string, token: string): string {
	const url = new URL(remote);
	if (url.protocol !== "https:") throw new Error(`remote ${remote} is not https`);
	url.username = "x";
	url.password = tokenSecret(token);
	return url.toString();
}

export function outsideCommands(repo: string, remote: string, token: string): string[] {
	const branch = `${OUTSIDE_TOKEN.branchPrefix}my-change`;
	return [`git clone ${authedRemote(remote, token)} ${repo}`, `cd ${repo}`, `git checkout -b ${branch}`, "git add -A && git commit -m \"Describe the change\"", `git push origin ${branch}`];
}

/**
 * Mints a write token for one hour and revokes the fork's previous outside
 * token, so at most one is live. A previous token that cannot be revoked
 * (already expired or gone) does not stop the new one; the error is returned
 * for the log. Errors never carry the token.
 */
export async function mintOutsideToken(repo: TokenRepo, name: string, previousTokenId: string | null): Promise<{ access: OutsideAccess; tokenId: string; revokeError: string | null }> {
	try {
		const info = await repo.info();
		const token = await repo.createToken("write", OUTSIDE_TOKEN.ttlSeconds);
		let revokeError: string | null = null;
		if (previousTokenId) {
			try {
				await repo.revokeToken(previousTokenId);
			} catch (error) {
				revokeError = scrubText(error instanceof Error ? error.message : String(error));
			}
		}
		return {
			access: { repo: name, remote: info.remote, token: token.plaintext, expiresAt: token.expiresAt, branchPrefix: OUTSIDE_TOKEN.branchPrefix, commands: outsideCommands(name, info.remote, token.plaintext) },
			tokenId: token.id,
			revokeError,
		};
	} catch (error) {
		throw new Error(`could not mint a token for ${name}: ${scrubText(error instanceof Error ? error.message : String(error))}`);
	}
}

// Bring your own agent. The owner never gets a token for their real fork:
// Artifacts tokens are scoped to a repo but not to branches, so such a token
// could write main. Instead each fork gets an inbox repo, inbox-<fork>, an
// Artifacts fork of the user's fork, and the one hour write token is scoped
// to the inbox only. The platform imports work/* branches from the inbox
// into the real fork (forks/inbox.ts), where the gate decides as usual.
// The token is returned to its owner once and never logged.
import { scrubText, tokenSecret } from "../git/tokens.ts";
import { assertRepoName } from "../lib/names.ts";

export const OUTSIDE_TOKEN = { ttlSeconds: 3600, branchPrefix: "work/" } as const;
export const INBOX_PREFIX = "inbox-";

/** The parts of an Artifacts repo handle the token route uses. */
export interface TokenRepo {
	info(): Promise<{ remote: string }>;
	createToken(scope: "write" | "read", ttl: number): Promise<{ id: string; plaintext: string; scope: string; expiresAt: string }>;
	revokeToken(tokenOrId: string): Promise<boolean>;
}

export interface OutsideAccess {
	repo: string;
	inbox: string;
	remote: string;
	token: string;
	expiresAt: string;
	branchPrefix: string;
	commands: string[];
}

/** Fleet value for a fork that has an inbox: the inbox name and the live outside token's id (never the token). */
export interface OutsideGrant {
	repo: string;
	inbox: string;
	userId: string;
	tokenId: string | null;
	firstAt: string;
	mintedAt: string;
	expiresAt: string | null;
}

export function outsideGrantKey(repo: string): string {
	return `outside:${repo}`;
}

/** The inbox of a user fork. Inbox names never start with "user-", so nothing treats an inbox as a fork. */
export function inboxRepoName(fork: string): string {
	return assertRepoName(`${INBOX_PREFIX}${fork}`);
}

/** The user fork an inbox belongs to, or null when the name is not an inbox of a user fork. */
export function forkOfInbox(inbox: string): string | null {
	return /^inbox-(user-[a-z0-9-]+)$/.exec(inbox)?.[1] ?? null;
}

/** The remote with the token's secret as the password (git asks for no credentials then). */
export function authedRemote(remote: string, token: string): string {
	const url = new URL(remote);
	if (url.protocol !== "https:") throw new Error(`remote ${remote} is not https`);
	url.username = "x";
	url.password = tokenSecret(token);
	return url.toString();
}

export function outsideCommands(inbox: string, remote: string, token: string): string[] {
	const branch = `${OUTSIDE_TOKEN.branchPrefix}my-change`;
	return [`git clone ${authedRemote(remote, token)} ${inbox}`, `cd ${inbox}`, `git checkout -b ${branch}`, 'git add -A && git commit -m "Describe the change"', `git push origin ${branch}`];
}

/**
 * Mints a write token for one hour on the inbox and revokes the previous
 * outside token, so at most one is live. A previous token that cannot be
 * revoked (already expired or gone) does not stop the new one; the reason is
 * returned for the log. Errors never carry the token.
 */
export async function mintOutsideToken(inbox: TokenRepo, names: { fork: string; inbox: string }, previousTokenId: string | null): Promise<{ access: OutsideAccess; tokenId: string; revokeError: string | null }> {
	try {
		const info = await inbox.info();
		const token = await inbox.createToken("write", OUTSIDE_TOKEN.ttlSeconds);
		let revokeError: string | null = null;
		if (previousTokenId) {
			try {
				if (!(await inbox.revokeToken(previousTokenId))) revokeError = `token ${previousTokenId} was not found (already expired or revoked)`;
			} catch (error) {
				revokeError = scrubText(error instanceof Error ? error.message : String(error));
			}
		}
		return {
			access: { repo: names.fork, inbox: names.inbox, remote: info.remote, token: token.plaintext, expiresAt: token.expiresAt, branchPrefix: OUTSIDE_TOKEN.branchPrefix, commands: outsideCommands(names.inbox, info.remote, token.plaintext) },
			tokenId: token.id,
			revokeError,
		};
	} catch (error) {
		throw new Error(`could not mint a token for ${names.inbox}: ${scrubText(error instanceof Error ? error.message : String(error))}`);
	}
}

import { describe, expect, it } from "vitest";
import { authedRemote, mintOutsideToken, OUTSIDE_TOKEN, outsideCommands, outsideGrantKey, type TokenRepo } from "../src/forks/outside.ts";
import { LIMITS } from "../src/api/routes.ts";

const REMOTE = "https://acct.artifacts.cloudflare.net/git/fluid/user-s-1a2b.git";
const TOKEN = "art_v2_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLM?expires=1790000000";
const SECRET = TOKEN.split("?")[0]!;

function fakeRepo(overrides: Partial<TokenRepo> = {}) {
	const calls: { created: [string, number][]; revoked: string[] } = { created: [], revoked: [] };
	const repo: TokenRepo = {
		info: async () => ({ remote: REMOTE }),
		createToken: async (scope, ttl) => {
			calls.created.push([scope, ttl]);
			return { id: "tok_new", plaintext: TOKEN, scope, expiresAt: "2026-10-06T13:00:00.000Z" };
		},
		revokeToken: async (id) => {
			calls.revoked.push(id);
			return true;
		},
		...overrides,
	};
	return { repo, calls };
}

describe("outside tokens", () => {
	it("lasts one hour and only names work branches", () => {
		expect(OUTSIDE_TOKEN.ttlSeconds).toBe(3600);
		expect(OUTSIDE_TOKEN.branchPrefix).toBe("work/");
	});

	it("puts only the secret part of the token in the remote URL", () => {
		const url = authedRemote(REMOTE, TOKEN);
		expect(url).toBe(`https://x:${SECRET}@acct.artifacts.cloudflare.net/git/fluid/user-s-1a2b.git`);
		expect(url).not.toContain("expires");
	});

	it("refuses a remote that is not https", () => {
		expect(() => authedRemote("http://acct/git/fluid/x.git", TOKEN)).toThrow(/https/);
	});

	it("lists clone, branch, and push commands for a work branch", () => {
		const commands = outsideCommands("user-s-1a2b", REMOTE, TOKEN);
		expect(commands[0]).toBe(`git clone ${authedRemote(REMOTE, TOKEN)} user-s-1a2b`);
		expect(commands).toContain("git checkout -b work/my-change");
		expect(commands.at(-1)).toBe("git push origin work/my-change");
	});

	it("mints a write token for one hour and returns the access details", async () => {
		const { repo, calls } = fakeRepo();
		const minted = await mintOutsideToken(repo, "user-s-1a2b", null);
		expect(calls.created).toEqual([["write", 3600]]);
		expect(calls.revoked).toEqual([]);
		expect(minted.tokenId).toBe("tok_new");
		expect(minted.access).toMatchObject({ repo: "user-s-1a2b", remote: REMOTE, token: TOKEN, expiresAt: "2026-10-06T13:00:00.000Z", branchPrefix: "work/" });
		expect(minted.access.commands).toEqual(outsideCommands("user-s-1a2b", REMOTE, TOKEN));
	});

	it("revokes the fork's previous outside token so one stays live", async () => {
		const { repo, calls } = fakeRepo();
		await mintOutsideToken(repo, "user-s-1a2b", "tok_old");
		expect(calls.revoked).toEqual(["tok_old"]);
	});

	it("still returns the new token when the old one is already gone", async () => {
		const { repo } = fakeRepo({ revokeToken: async () => { throw new Error("not found"); } });
		const minted = await mintOutsideToken(repo, "user-s-1a2b", "tok_old");
		expect(minted.tokenId).toBe("tok_new");
		expect(minted.revokeError).toMatch(/not found/);
	});

	it("never puts the token into an error message", async () => {
		const { repo } = fakeRepo({ info: async () => { throw new Error(`boom ${TOKEN}`); } });
		await expect(mintOutsideToken(repo, "user-s-1a2b", null)).rejects.toThrow(/<redacted-token>/);
	});

	it("keys the grant record by repo", () => {
		expect(outsideGrantKey("user-s-1a2b")).toBe("outside:user-s-1a2b");
	});

	it("has quotas per user, per client, and overall", () => {
		expect(LIMITS.outsideTokensPerUserPerHour).toBe(3);
		expect(LIMITS.outsideTokensPerClientPerHour).toBe(6);
		expect(LIMITS.outsideTokensGlobalPerHour).toBe(60);
	});
});

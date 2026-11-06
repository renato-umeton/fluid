import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import stockSource from "../src/generated/stock-source.json";
import { VARIANT_PATTERN, deriveSeed, fingerprint, variantNames } from "../src/polymorph/names.ts";

const files = stockSource.files as Record<string, string>;
const stockNames: string[] = JSON.parse(files["polymorph.json"]!).names;

const SECRET = "polymorph-test-secret-0123456789";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const seedFor = (epoch: number) => deriveSeed(SECRET, "user-ada", SHA, epoch);

describe("published stock", () => {
	it("carries upstream's polymorph name list", () => {
		expect(typeof files["polymorph.json"]).toBe("string");
		expect(stockNames).toContain("researchNeedsAttestation");
	});
});

describe("deriveSeed", () => {
	it("is the hex HMAC-SHA256 of the fork, commit, and epoch under the secret", async () => {
		const expected = createHmac("sha256", SECRET).update(`polymorph:v1:user-ada:${SHA}:3`).digest("hex");
		expect(await deriveSeed(SECRET, "user-ada", SHA, 3)).toBe(expected);
	});

	it("changes with the secret, the fork, the commit, and the epoch", async () => {
		const seeds = await Promise.all([
			deriveSeed(SECRET, "user-ada", SHA, 0),
			deriveSeed(`${SECRET}x`, "user-ada", SHA, 0),
			deriveSeed(SECRET, "user-bob", SHA, 0),
			deriveSeed(SECRET, "user-ada", "f".repeat(40), 0),
			deriveSeed(SECRET, "user-ada", SHA, 1),
		]);
		expect(new Set(seeds).size).toBe(seeds.length);
	});

	it.each<[string, string, string, string, number, RegExp]>([
		["a short secret", "too-short", "user-ada", SHA, 0, /secret/],
		["an empty fork", SECRET, "", SHA, 0, /repo/],
		["a colon in the fork, which would make two seeds collide", SECRET, "user:ada", SHA, 0, /repo/],
		["an empty commit", SECRET, "user-ada", "", 0, /sha/],
		["a negative epoch", SECRET, "user-ada", SHA, -1, /epoch/],
		["a fractional epoch", SECRET, "user-ada", SHA, 1.5, /epoch/],
	])("refuses %s", async (_label, secret, repo, sha, epoch, message) => {
		await expect(deriveSeed(secret, repo, sha, epoch)).rejects.toThrow(message);
	});
});

describe("variantNames", () => {
	it("appends $ and eight base36 characters to every name", async () => {
		const variants = await variantNames(await seedFor(0), ["researchNeedsAttestation", "classify"]);
		expect([...variants.keys()]).toEqual(["researchNeedsAttestation", "classify"]);
		for (const [name, variant] of variants) {
			expect(variant).toMatch(VARIANT_PATTERN);
			expect(variant.startsWith(`${name}$`)).toBe(true);
		}
	});

	it("takes each suffix from the HMAC of the seed and that name alone", async () => {
		const seed = await seedFor(0);
		const alone = await variantNames(seed, ["classify"]);
		const together = await variantNames(seed, ["softmax", "classify", "topIntent"]);
		expect(together.get("classify")).toBe(alone.get("classify"));
		const digest = createHmac("sha256", seed).update("classify").digest();
		const suffix = (digest.readUIntBE(0, 6) % 36 ** 8).toString(36).padStart(8, "0");
		expect(alone.get("classify")).toBe(`classify$${suffix}`);
	});

	it("gives every name of the stock list its own suffix", async () => {
		const variants = await variantNames(await seedFor(0), stockNames);
		const suffixes = new Set([...variants.values()].map((variant) => variant.slice(variant.indexOf("$") + 1)));
		expect(variants.size).toBe(stockNames.length);
		expect(suffixes.size).toBe(stockNames.length);
	});

	it("renames differently under another seed", async () => {
		const [a, b] = await Promise.all([seedFor(0), seedFor(1)].map(async (seed) => variantNames(await seed, stockNames)));
		expect(stockNames.filter((name) => a.get(name) === b.get(name))).toEqual([]);
	});

	it("is the same for the same seed", async () => {
		const seed = await seedFor(2);
		expect(await variantNames(seed, stockNames)).toEqual(await variantNames(seed, stockNames));
	});

	it("refuses a seed that did not come from deriveSeed", async () => {
		await expect(variantNames("not-a-seed", ["classify"])).rejects.toThrow(/seed/);
		await expect(variantNames("", ["classify"])).rejects.toThrow(/seed/);
	});
});

describe("fingerprint", () => {
	it("is eight lowercase hex characters, stable per seed and different across seeds", async () => {
		const seeds = await Promise.all([0, 1, 2].map(seedFor));
		const prints = await Promise.all(seeds.map(fingerprint));
		for (const print of prints) expect(print).toMatch(/^[0-9a-f]{8}$/);
		expect(new Set(prints).size).toBe(3);
		expect(await fingerprint(seeds[0]!)).toBe(prints[0]);
	});

	it("comes from a message no listed name can be, so it reveals neither the seed nor a suffix", async () => {
		const seed = await seedFor(0);
		const print = await fingerprint(seed);
		expect(print).toBe(createHmac("sha256", seed).update("polymorph:v1:fingerprint").digest("hex").slice(0, 8));
		expect(seed).not.toContain(print);
		const variants = await variantNames(seed, stockNames);
		expect([...variants.values()].filter((variant) => variant.includes(print))).toEqual([]);
	});

	it("refuses a seed that did not come from deriveSeed", async () => {
		await expect(fingerprint("abc")).rejects.toThrow(/seed/);
	});
});

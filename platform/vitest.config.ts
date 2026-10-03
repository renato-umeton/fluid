import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests run in Node without the Workers plugin: they cover pure logic
// (git over MemoryFS, transforms, toml, cookies, refs) and never touch the network.
// Durable Object classes run against an in-memory SQLite fake of their storage
// (test/helpers/durable.ts); cloudflare:workers resolves to a small stand-in.
export default defineConfig({
	resolve: {
		alias: { "cloudflare:workers": fileURLToPath(new URL("./test/helpers/cloudflare-workers.ts", import.meta.url)) },
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});

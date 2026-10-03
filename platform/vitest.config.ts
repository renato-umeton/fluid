import { defineConfig } from "vitest/config";

// Unit tests run in Node without the Workers plugin: they cover pure logic
// (git over MemoryFS, transforms, toml, cookies, refs) and never touch the network.
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
	},
});

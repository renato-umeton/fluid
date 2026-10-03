// Bundles the fork runtime into dist/app.js: one ES module, no imports, with a
// single default export { ask }. JSON policy files are inlined.
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(root, "app", "index.ts")],
  outfile: join(root, "dist", "app.js"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  legalComments: "none",
  logLevel: "info",
});

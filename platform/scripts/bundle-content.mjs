// Bundles the content the platform Worker needs at runtime but cannot read
// from disk once deployed:
//   src/generated/stock-source.json  files of the stock release (published to Artifacts)
//                                    plus the demo release overlay (appended only to demo releases)
//   src/generated/synthetic.json     synthetic data injected into fork runtimes as env.data
// and copies the stock browser bundle for the UI when it has been built:
//   public/vendor/stock-app.js       from stock/dist/app.js
// Generated files are gitignored and rebuilt before dev, build, test, and typecheck.
//
// Stock and synthetic content is read from the last commit (git HEAD), so a
// release is always published from committed source. Set
// FLUID_CONTENT_SOURCE=worktree to bundle uncommitted files while developing.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const platformRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(platformRoot, "..");
const stockRoot = join(repoRoot, "stock");
const generatedDir = join(platformRoot, "src", "generated");

// What the published stock repo contains: the runtime, the suites the gate
// reads, the probe runner, the intent ledger, and configuration. Unit tests,
// build scripts, and tooling stay in the monorepo.
const STOCK_INCLUDE = [
	"app/",
	"intent/",
	"policies/",
	"connectors/",
	"tests/invariants/",
	"tests/functional/",
	"tests/user/",
	"tests/runner.ts",
	".intent/",
	"fluid.toml",
	"README.md",
];

const fromWorktree = process.env.FLUID_CONTENT_SOURCE === "worktree";

function git(args) {
	return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

/** Files under a top-level directory of the monorepo, keyed by path relative to it. */
function readTree(top) {
	const out = {};
	if (fromWorktree) {
		const root = join(repoRoot, top);
		for (const full of walk(root)) out[relative(root, full).split(sep).join("/")] = readFileSync(full, "utf8");
		return out;
	}
	for (const path of git(["ls-tree", "-r", "--name-only", "HEAD", `${top}/`]).split("\n").filter(Boolean)) {
		out[path.slice(top.length + 1)] = git(["show", `HEAD:${path}`]);
	}
	return out;
}

function walk(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === ".DS_Store") continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else out.push(full);
	}
	return out;
}

function included(path) {
	return STOCK_INCLUDE.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}

// Invariant probes added only to demo releases (never published as stock content).
const DEMO_OVERLAY_PATH = "overlays/demo-release/invariants.json";

function bundleStock() {
	const files = {};
	const tree = readTree("stock");
	for (const [path, text] of Object.entries(tree)) {
		if (included(path)) files[path] = text;
	}
	if (tree[DEMO_OVERLAY_PATH] === undefined) throw new Error(`bundle-content: stock is missing ${DEMO_OVERLAY_PATH}`);
	const demoOverlay = JSON.parse(tree[DEMO_OVERLAY_PATH]);
	for (const required of ["app/index.ts", "fluid.toml", "tests/invariants/manifest.json", "tests/functional/manifest.json"]) {
		if (!(required in files)) throw new Error(`bundle-content: stock is missing ${required}`);
	}
	const intents = Object.keys(files).filter((p) => p.startsWith(".intent/") && p.endsWith(".json")).sort();
	const latestIntent = intents.length ? JSON.parse(files[intents[intents.length - 1]]) : null;
	const stockTag = /^stock_tag\s*=\s*"([^"]+)"/m.exec(files["fluid.toml"])?.[1];
	if (!stockTag) throw new Error("bundle-content: stock fluid.toml has no stock_tag");
	return { stockTag, intentId: latestIntent?.id ?? null, files, demoOverlay };
}

function bundleSynthetic() {
	const tree = readTree("synthetic");
	const manifest = JSON.parse(tree["manifest.json"]);
	const data = {};
	for (const [key, file] of Object.entries(manifest.envDataKeys)) {
		if (tree[file] === undefined) throw new Error(`bundle-content: synthetic/${file} is missing`);
		data[key] = JSON.parse(tree[file]);
	}
	return data;
}

function writeJson(name, value) {
	mkdirSync(generatedDir, { recursive: true });
	writeFileSync(join(generatedDir, name), `${JSON.stringify(value)}\n`);
}

const stock = bundleStock();
writeJson("stock-source.json", stock);
writeJson("synthetic.json", bundleSynthetic());

const stockApp = join(stockRoot, "dist", "app.js");
if (existsSync(stockApp)) {
	const vendorDir = join(platformRoot, "public", "vendor");
	mkdirSync(vendorDir, { recursive: true });
	copyFileSync(stockApp, join(vendorDir, "stock-app.js"));
}

const source = fromWorktree ? "worktree" : `commit ${git(["rev-parse", "--short", "HEAD"]).trim()}`;
console.log(`bundle-content (${source}): stock ${stock.stockTag}, ${Object.keys(stock.files).length} files; synthetic data bundled`);

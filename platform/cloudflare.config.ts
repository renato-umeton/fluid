import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "fluid",
		compatibilityDate: "2026-10-01",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint,
		assets: {
			notFoundHandling: "single-page-application",
			runWorkerFirst: ["/api/*"],
		},
		env: {
			ARTIFACTS: bindings.artifacts({ namespace: "fluid", dev: { remote: true } }),
			AI: bindings.ai({ dev: { remote: true } }),
			LOADER: bindings.workerLoader(),
			USER_LEDGER: bindings.durableObject({ worker: "fluid", exportName: "UserLedger" }),
			FLEET: bindings.durableObject({ worker: "fluid", exportName: "Fleet" }),
			RUNS: bindings.durableObject({ worker: "fluid", exportName: "Runs" }),
			QUOTA: bindings.durableObject({ worker: "fluid", exportName: "Quota" }),
			SESSION_SECRET: bindings.secret(),
			ADMIN_TOKEN: bindings.secret(),
		},
		exports: {
			UserLedger: exports.durableObject({ storage: "sqlite" }),
			Fleet: exports.durableObject({ storage: "sqlite" }),
			Runs: exports.durableObject({ storage: "sqlite" }),
			Quota: exports.durableObject({ storage: "sqlite" }),
		},
	},
});

import { bindings, defineConfig, exports, triggers } from "cf/config";
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
			// Browser Rendering for the yellow soak's browser checks (a remote browser; local dev cannot reach localhost).
			BROWSER: bindings.browser({ dev: { remote: true } }),
			// The URL users reach (the browser checks load the app there). Set FLUID_PUBLIC_ORIGIN when deploying; empty leaves the browser tier unavailable.
			PUBLIC_ORIGIN: bindings.text(process.env.FLUID_PUBLIC_ORIGIN ?? ""),
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
			GateWorkflow: exports.workflow({ name: "fluid-gate" }),
			CustomizeWorkflow: exports.workflow({ name: "fluid-customize" }),
			RepairWorkflow: exports.workflow({ name: "fluid-repair" }),
			UpgradeWorkflow: exports.workflow({ name: "fluid-upgrade" }),
			ReleaseWorkflow: exports.workflow({ name: "fluid-release" }),
			SeedFleetWorkflow: exports.workflow({ name: "fluid-seed-fleet" }),
			SeedForkWorkflow: exports.workflow({ name: "fluid-seed-fork" }),
			HarvestWorkflow: exports.workflow({ name: "fluid-harvest" }),
			YellowWorkflow: exports.workflow({ name: "fluid-yellow" }),
			ImportWorkflow: exports.workflow({ name: "fluid-import" }),
		},
		// Artifacts repo.pushed events (account-level subscription, see scripts/setup-events.mjs).
		// Messages that still fail after maxRetries go to fluid-events-dlq instead of being dropped.
		triggers: [triggers.queue({ name: "fluid-events", maxBatchSize: 10, maxBatchTimeout: 1, maxRetries: 5, deadLetterQueue: "fluid-events-dlq" })],
	},
});

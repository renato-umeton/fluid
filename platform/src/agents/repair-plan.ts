// Repair agent planning (spec 7): given a failed gate and the fork's
// build-time intent records, decide what to explain and, when a
// deterministic fix exists, what to change. Fixes never merge on their own;
// they go to a repair/<short-sha> branch for the user to review.
import type { BuildTimeIntent } from "../forks/provision.ts";
import type { GateFailure, GateResult } from "../gate/tiers.ts";
import { setTomlValue } from "../lib/toml.ts";

export interface RepairPlan {
	/** Files the fix writes (full content) or deletes (null). Empty when there is no deterministic fix. */
	files: Record<string, string | null>;
	fixSummary: string | null;
	explanation: string;
	intentRefs: string[];
	/** Failures the deterministic rules could not address (the model may explain them). */
	unexplained: GateFailure[];
	rule: "restore-tau" | "revert-customization" | "keep-green" | "none";
}

export interface RepairInput {
	gate: Pick<GateResult, "failures" | "stockTag" | "ref" | "commit">;
	intents: BuildTimeIntent[];
	fluidToml: string | null;
	stockMinTau: number;
	/** Stock's version (at the gate's stock tag) of files the customizations touched; null when stock has no such file. */
	stockVersions: Record<string, string | null>;
}

const CUSTOM_AGENTS = new Set(["customization-agent", "seed-customization", "merge-agent"]);

export function customizationIntents(intents: BuildTimeIntent[]): BuildTimeIntent[] {
	return intents.filter((i) => i.agent !== null && CUSTOM_AGENTS.has(i.agent));
}

export function isTauFailure(f: GateFailure): boolean {
	return f.path === "thresholds.tau" || /tau-config|tau-behavior/.test(f.probe) || (f.path === "tau" && f.op === "gte");
}

export function isClinicalFailure(f: GateFailure): boolean {
	return f.tier !== "user" && (f.path === "computed_dose" || /clinical|never-doses|no-dose|chart-open|order-entry/.test(f.probe));
}

/** A failure of the research numeric floor (two registry sources, visible cross-check). */
export function isResearchFailure(f: GateFailure): boolean {
	return f.tier === "invariant" && /^inv-research-/.test(f.probe);
}

/** Runtime files the fork's customizations changed (candidates to revert to stock). */
export function customizedRuntimeFiles(intents: BuildTimeIntent[]): string[] {
	const files = customizationIntents(intents).flatMap((i) => i.files);
	return [...new Set(files.filter((f) => /^(app|intent|policies|connectors)\//.test(f)))].sort();
}

export function planRepair(input: RepairInput): RepairPlan {
	const failures = input.gate.failures;
	const custom = customizationIntents(input.intents);
	const tauFailures = failures.filter(isTauFailure);
	const clinicalFailures = failures.filter((f) => !isTauFailure(f) && isClinicalFailure(f));
	const researchFailures = failures.filter((f) => !isTauFailure(f) && !isClinicalFailure(f) && isResearchFailure(f));
	const files: Record<string, string | null> = {};
	const refs = new Set<string>();
	const fixes: string[] = [];
	const reasons: string[] = [];
	let rule: RepairPlan["rule"] = "none";

	if (tauFailures.length > 0 && input.fluidToml !== null) {
		files["fluid.toml"] = setTomlValue(input.fluidToml, "thresholds", "tau", input.stockMinTau);
		const owners = custom.filter((i) => i.files.includes("fluid.toml"));
		owners.forEach((i) => refs.add(i.id));
		const first = tauFailures[0]!;
		fixes.push(`restore thresholds.tau to the stock minimum ${input.stockMinTau}`);
		reasons.push(
			`The gate failed ${first.probe} (${first.path} ${first.op} ${JSON.stringify(first.expected)}, got ${JSON.stringify(first.actual)}). ${owners.length ? `Intent ${owners.map((i) => `${i.id} ("${i.request}")`).join(", ")} lowered tau` : "fluid.toml sets tau"} below the stock minimum, which stock ${input.gate.stockTag ?? ""} enforces as an invariant. Users may raise tau, never lower it.`,
		);
		rule = "restore-tau";
	}

	if (clinicalFailures.length > 0) {
		const owners = custom.filter((i) => i.files.some((f) => /^(app|intent|policies)\//.test(f)));
		const revert = [...new Set(owners.flatMap((i) => i.files).filter((f) => /^(app|intent|policies|connectors)\//.test(f)))];
		for (const path of revert) {
			if (!(path in input.stockVersions)) continue;
			files[path] = input.stockVersions[path] ?? null;
		}
		owners.forEach((i) => refs.add(i.id));
		const first = clinicalFailures[0]!;
		if (revert.length > 0) {
			fixes.push(`revert ${revert.join(", ")} to stock ${input.gate.stockTag ?? ""}`);
			if (rule === "none") rule = "revert-customization";
		}
		reasons.push(
			`The gate failed the clinical floor at ${first.probe} (${first.path || "card"} ${first.op}). ${owners.length ? `Intent ${owners.map((i) => `${i.id} ("${i.purpose || i.request}")`).join(", ")} changed ${revert.join(", ")}` : "A customization changed clinical behavior"}; clinical mode must never compute a patient-specific dose. The repair puts stock's clinical behavior back and keeps the customization on its own branch for rework.`,
		);
	}

	if (researchFailures.length > 0) {
		// Only customizations that change research answers are candidates; others stay as they are.
		const owners = custom.filter((i) => i.modes_affected.includes("research") && i.files.some((f) => /^(app|policies|connectors)\//.test(f)));
		const revert = [...new Set(owners.flatMap((i) => i.files).filter((f) => /^(app|intent|policies|connectors)\//.test(f)))].filter((path) => path in input.stockVersions);
		for (const path of revert) files[path] = input.stockVersions[path] ?? null;
		owners.forEach((i) => refs.add(i.id));
		const first = researchFailures[0]!;
		if (revert.length > 0) {
			fixes.push(`revert ${revert.join(", ")} to stock ${input.gate.stockTag ?? ""}`);
			if (rule === "none") rule = "revert-customization";
		}
		reasons.push(
			`The gate failed the research floor at ${first.probe} (${first.path || "card"} ${first.op} ${JSON.stringify(first.expected)}). ${owners.length ? `Intent ${owners.map((i) => `${i.id} ("${i.purpose || i.request}")`).join(", ")} changed how research answers read` : "A customization changed research answers"}; stock ${input.gate.stockTag ?? ""} requires research numeric answers to show their per-source cross-check. The repair puts stock's research answer back and keeps the customization on its own branch for rework.`,
		);
	}

	const explained = new Set([...tauFailures, ...clinicalFailures, ...researchFailures]);
	const unexplained = failures.filter((f) => !explained.has(f));
	if (unexplained.length > 0 && reasons.length === 0) {
		const touched = custom.filter((i) => i.files.length > 0);
		touched.forEach((i) => refs.add(i.id));
		const f = unexplained[0]!;
		reasons.push(
			`The gate failed ${f.tier} probe ${f.probe} (${f.path || "card"} ${f.op}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}). ${touched.length ? `The customizations most likely involved are ${touched.map((i) => `${i.id} ("${i.request}", files ${i.files.join(", ")})`).join("; ")}.` : "No customization intent record explains this change."} No deterministic fix applies; review the branch and the intent records.`,
		);
	}
	const fixSummary = fixes.length ? capitalize(fixes.join("; ")) : null;
	const explanation = `${reasons.join(" ")}${fixSummary ? ` Proposed fix: ${fixSummary}.` : ""} The fork stays on its current main; nothing merges until you review this branch.`;
	return { files, fixSummary, explanation, intentRefs: [...refs], unexplained, rule };
}

/**
 * Repair for a change the yellow soak rolled back. main is already back on
 * the last green tree, and the repair branch starts there. It relies only on
 * the change's own intent records and never writes files: reverting files to
 * stock could undo older customizations that were green. Applying it keeps
 * the green tree and records the diagnosis; the change comes back only when
 * the user reworks it and runs the request again.
 */
export function planYellowRepair(input: RepairInput, changeIntentIds: string[]): RepairPlan {
	const ids = new Set(changeIntentIds);
	const own = input.intents.filter((i) => ids.has(i.id));
	const f = input.gate.failures[0];
	const what = f ? `${f.probe}${f.description ? ` (${f.description})` : ""}: ${f.path || "result"} ${f.op}, expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}` : "the end-to-end suite";
	const change = own.length ? own.map((i) => `${i.id} ("${i.request}", files ${i.files.filter((x) => !x.startsWith(".intent/")).join(", ") || "none"})`).join("; ") : changeIntentIds.length ? changeIntentIds.join(", ") : "a change with no intent record";
	const explanation = `The change went live on main in yellow and the end-to-end suite then failed ${what}, so main was rolled back to the last green commit. The change: ${change}. Applying this repair keeps main on the last green tree that the rollback restored and records this diagnosis; it never reverts older customizations. To bring the change back, rework it and run the request again.`;
	return { files: {}, fixSummary: "Keep the last green tree that the rollback restored and record the diagnosis", explanation, intentRefs: own.length ? own.map((i) => i.id) : [...ids], unexplained: input.gate.failures, rule: "keep-green" };
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Markdown body of the explanation file committed to the repair branch. */
export function repairNote(input: { repo: string; ref: string; commit: string; stockTag: string | null; plan: RepairPlan; failures: GateFailure[]; modelNote?: string | null }): string {
	const lines = [
		`# Repair for ${input.ref} at ${input.commit.slice(0, 7)}`,
		"",
		`Fork: ${input.repo}. Gate run against stock ${input.stockTag ?? "(unknown)"}.`,
		"",
		"## What failed",
		"",
		...input.failures.slice(0, 10).map((f) => `- ${f.tier} ${f.probe}: ${f.path || "card"} ${f.op}, expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)} (sample ${f.sample} of ${f.samples})`),
		"",
		"## Why",
		"",
		input.plan.explanation,
		...(input.modelNote ? ["", "## Repair agent notes", "", input.modelNote] : []),
		"",
		"## Intent records relied on",
		"",
		...(input.plan.intentRefs.length ? input.plan.intentRefs.map((id) => `- .intent/${id}.json`) : ["- none"]),
		"",
		input.plan.fixSummary ? `## Proposed fix\n\n${input.plan.fixSummary}. Review and merge this branch yourself; the platform never merges repairs automatically.` : "## Proposed fix\n\nNone. The customization needs rework; this branch only records the diagnosis.",
		"",
	];
	return lines.join("\n");
}

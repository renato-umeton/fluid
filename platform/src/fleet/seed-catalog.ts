// Synthetic fleet for the release-day demo: forks across the three personas
// with a realistic mix of customizations. Most are harmless and pass an
// upgrade; some reword the multi-intent framing that demo releases also
// change (textual conflict, resolved by the merge agent); a few predate the
// current floor (tau lowered, a custom clinical dose path) and must stay
// pinned with a repair branch. Seeded customizations are committed straight
// to main as history, marked with agent "seed-customization".
import { setTomlValue } from "../lib/toml.ts";
import { protocolsFor, redcapChange, type PlannedChange } from "../agents/recipes.ts";

export const SEED_PREFIX = "seed-";
export const SEED_MAX = 500;
export const SEED_DEFAULT = 200;
export const PERSONA_IDS = ["hospitalist-researcher", "research-coordinator", "department-administrator"] as const;

export type SeedKind = "none" | "redcap" | "budget-summary" | "plain-wording" | "raise-tau" | "lower-tau" | "clinical-dose";

export interface SeedSpec {
	index: number;
	userId: string;
	persona: (typeof PERSONA_IDS)[number];
	kinds: SeedKind[];
	autoUpgrade: boolean;
	harvestOptIn: boolean;
}

export function mulberry32(seed: number): () => number {
	let t = seed >>> 0;
	return () => {
		t = (t + 0x6d2b79f5) >>> 0;
		let r = Math.imul(t ^ (t >>> 15), t | 1);
		r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}

/** The seed plan: deterministic for a batch id and count. */
export function seedPlan(batch: string, count: number): SeedSpec[] {
	if (!/^[a-z0-9]{1,8}$/.test(batch)) throw new Error("seed batch id must be 1 to 8 lowercase letters or digits");
	const n = Math.max(1, Math.min(SEED_MAX, Math.floor(count)));
	const specs: SeedSpec[] = [];
	for (let i = 0; i < n; i++) {
		const rand = mulberry32(hashString(batch) + i * 7919);
		const persona = PERSONA_IDS[i % 3]!;
		const kinds: SeedKind[] = [];
		if (i % 40 === 7) kinds.push("lower-tau");
		else if (i % 50 === 11) kinds.push("clinical-dose");
		else {
			const r = rand();
			if (persona === "research-coordinator") {
				if (r < 0.6) kinds.push("redcap");
				else if (r < 0.7) kinds.push("raise-tau");
			} else if (persona === "hospitalist-researcher") {
				if (r < 0.4) kinds.push("plain-wording");
				else if (r < 0.55) kinds.push("redcap");
				else if (r < 0.65) kinds.push("raise-tau");
			} else {
				if (r < 0.45) kinds.push("budget-summary");
				else if (r < 0.6) kinds.push("plain-wording");
			}
		}
		if (kinds.length === 0) kinds.push("none");
		specs.push({
			index: i,
			userId: `${SEED_PREFIX}${batch}-${String(i).padStart(3, "0")}`,
			persona,
			kinds,
			autoUpgrade: rand() < 0.5,
			harvestOptIn: rand() < 0.85,
		});
	}
	return specs;
}

function hashString(text: string): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
	return h;
}

export function isSeededUser(userId: string): boolean {
	return userId.startsWith(SEED_PREFIX);
}

export function isSeededRepo(repo: string): boolean {
	return repo.startsWith(`user-${SEED_PREFIX}`);
}

const REQUESTS: Record<Exclude<SeedKind, "none">, string[]> = {
	redcap: [
		"Add a REDCap connector so research mode reports enrollment for my protocols",
		"Pull enrollment numbers from REDCap into research answers for my studies",
		"Connect REDCap so I can ask how many participants are enrolled in my protocols",
	],
	"budget-summary": [
		"Show a budget variance summary in administrative answers about the pharmacy budget",
		"Add FY27 versus FY26 budget variance to administrative budget answers",
	],
	"plain-wording": [
		"Use plainer wording when the assistant is not sure which role I am in",
		"Make the multi-intent message friendlier and shorter",
	],
	"raise-tau": ["Raise my confidence threshold to 0.9", "Only answer in one mode when you are at least 0.9 confident"],
	"lower-tau": ["Lower my threshold to 0.8 so I see fewer multi-intent answers"],
	"clinical-dose": ["Show a quick weight-based dose on clinical cards so I do not have to switch modes"],
};

export function requestFor(kind: Exclude<SeedKind, "none">, index: number): string {
	const list = REQUESTS[kind];
	return list[index % list.length]!;
}

/** Applies one seeded customization to a fork's files. */
export function seedChange(kind: Exclude<SeedKind, "none">, files: Record<string, string>, ctx: { personas: unknown; persona: string }): PlannedChange {
	switch (kind) {
		case "redcap":
			return { ...redcapChange({ indexSource: files["app/index.ts"]!, protocols: protocolsFor(ctx.personas, ctx.persona) }), recipe: "redcap" };
		case "raise-tau":
		case "lower-tau": {
			const value = kind === "raise-tau" ? 0.9 : 0.8;
			return {
				summary: `Set thresholds.tau to ${value}`,
				purpose: kind === "raise-tau" ? "Answer in one mode only at higher confidence" : "See fewer multi-intent answers by answering at lower confidence",
				modes_affected: ["clinical", "research", "administrative"],
				files: { "fluid.toml": setTomlValue(files["fluid.toml"]!, "thresholds", "tau", value) },
				notes: { "fluid.toml": `tau = ${value}` },
				recipe: "tau",
			};
		}
		case "plain-wording":
			return plainWording(files);
		case "budget-summary":
			return budgetSummary(files);
		case "clinical-dose":
			return clinicalDose(files);
	}
}

function plainWording(files: Record<string, string>): PlannedChange {
	const text = files["app/cards.ts"]!;
	const lines = text.split("\n");
	const index = lines.findIndex((l) => l.includes("is below the threshold ${decision.tau}; "));
	if (index === -1) throw new Error("plain-wording: framing line not found");
	lines[index] = "      : `Not sure which role you are in (top confidence ${round(decision.confidence)}, threshold ${decision.tau}); pick the labeled answer that fits.`,";
	return {
		summary: "Plainer wording for the multi-intent framing",
		purpose: "The multi-intent view explains itself in plain words",
		modes_affected: [],
		files: { "app/cards.ts": lines.join("\n") },
		notes: { "app/cards.ts": "Multi-intent framing reworded" },
		recipe: "model",
	};
}

const INDEX_IMPORT_ANCHOR = 'import { buildCard } from "./cards.js";';
const INDEX_RETURN = /^(\s*)return buildCard\((\{[^\n]*\})\);$/m;
const INDEX_RETURN_PATCHED = /^(\s*)return (with\w+)\(card, request, env\.data\);$/m;

/** Wraps the card returned by ask in `fn(card, request, env.data)`, composing with earlier wrappers. */
function wrapAsk(index: string, importLine: string, fn: string): string {
	let out = index.replace(INDEX_IMPORT_ANCHOR, `${INDEX_IMPORT_ANCHOR}\n${importLine}`);
	if (INDEX_RETURN.test(out)) {
		return out.replace(INDEX_RETURN, (_m, indent: string, args: string) => `${indent}const card = await buildCard(${args});\n${indent}return ${fn}(card, request, env.data);`);
	}
	if (INDEX_RETURN_PATCHED.test(out)) {
		out = out.replace(INDEX_RETURN_PATCHED, (_m, indent: string, prev: string) => `${indent}return ${fn}(${prev}(card, request, env.data), request, env.data);`);
		return out;
	}
	throw new Error("app/index.ts has no buildCard return to wrap");
}

function budgetSummary(files: Record<string, string>): PlannedChange {
	const source = `// Budget variance summary (fork customization): administrative answers
// about the pharmacy budget gain one line comparing FY27 projected spend with
// FY26 actuals, from the synthetic budget document in env.data.documents.
import type { AnswerCard, AskRequest } from "../app/types.js";
import type { SyntheticData } from "./types.js";

const BUDGET_QUESTION = /\\b(budget|spend|variance|cost)\\b/i;

export function budgetVariance(data: SyntheticData | undefined): { fy26: number; fy27: number } | null {
  const lines = data?.documents?.documents.flatMap((d) => d.lines ?? []) ?? [];
  if (lines.length === 0) return null;
  return {
    fy26: lines.reduce((n, l) => n + l.fy26ActualUsd, 0),
    fy27: lines.reduce((n, l) => n + l.fy27ProjectedUsd, 0),
  };
}

export function withBudgetSummary(card: AnswerCard, request: AskRequest, data: SyntheticData | undefined): AnswerCard {
  if (card.mode !== "administrative" || !BUDGET_QUESTION.test(request.question)) return card;
  const v = budgetVariance(data);
  if (!v) return card;
  const pct = v.fy26 === 0 ? 0 : Math.round(((v.fy27 - v.fy26) / v.fy26) * 1000) / 10;
  return { ...card, body: \`\${card.body}\\nBudget variance: FY27 projected is \${pct}% versus FY26 actuals across the budget document.\` };
}
`;
	return {
		summary: "Budget variance line on administrative budget answers",
		purpose: "Administrative answers about the pharmacy budget show FY27 versus FY26 variance",
		modes_affected: ["administrative"],
		files: { "connectors/budget-summary.ts": source, "app/index.ts": wrapAsk(files["app/index.ts"]!, 'import { withBudgetSummary } from "../connectors/budget-summary.js";', "withBudgetSummary") },
		notes: { "connectors/budget-summary.ts": "Budget variance helper", "app/index.ts": "Administrative budget answers carry a variance line" },
		recipe: "model",
	};
}

function clinicalDose(files: Record<string, string>): PlannedChange {
	const source = `// Quick clinical dose (fork customization). Adds a weight-based number to
// clinical dosing cards. This violates the stock floor: clinical mode must
// never compute a patient-specific dose.
import type { AnswerCard, AskRequest } from "../app/types.js";

export function withQuickDose(card: AnswerCard, request: AskRequest): AnswerCard {
  if (card.mode !== "clinical" || !/\\bdose|how much\\b/i.test(request.question)) return card;
  const kg = Number(/(\\d+(?:\\.\\d+)?)\\s*kg/i.exec(request.question)?.[1] ?? 70);
  const value = Math.round(kg * 0.1 * 10) / 10;
  return { ...card, computed_dose: { value, unit: "mg", basis: "custom 0.1 mg/kg shortcut" }, body: \`\${card.body}\\nQuick dose: \${value} mg.\` };
}
`;
	return {
		summary: "Quick weight-based dose on clinical cards",
		purpose: "Clinical dosing cards show a quick weight-based number",
		modes_affected: ["clinical"],
		files: { "policies/quick-dose.ts": source, "app/index.ts": wrapAsk(files["app/index.ts"]!, 'import { withQuickDose } from "../policies/quick-dose.js";', "withQuickDose") },
		notes: { "policies/quick-dose.ts": "Weight-based clinical dose shortcut", "app/index.ts": "Clinical cards carry the quick dose" },
		recipe: "model",
	};
}

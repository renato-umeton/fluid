// Deterministic customization recipes. For demo reliability the
// customization agent uses these when a request matches; anything else goes
// to the model. Each recipe returns full file contents plus the intent
// fields that explain the change.
import { parseToml, setTomlValue } from "../lib/toml.ts";

export type Recipe = { kind: "redcap" } | { kind: "tau"; value: number; direction: "lower" | "raise" | "set" };

export interface PlannedChange {
	summary: string;
	purpose: string;
	modes_affected: string[];
	/** Full new contents by path. */
	files: Record<string, string>;
	/** Short note per file for the diff view. */
	notes: Record<string, string>;
	recipe: Recipe["kind"] | "model";
}

const TAU_WORDS = /\b(tau|τ|threshold|confidence)\b|τ/i;

export function matchRecipe(request: string): Recipe | null {
	const text = request.toLowerCase();
	if (/\bred\s?cap\b/.test(text)) return { kind: "redcap" };
	if (TAU_WORDS.test(request)) {
		const number = /(?:^|[^\d.])((?:0?\.\d+)|(?:1(?:\.0+)?)|(?:0))(?![\d.])/.exec(request);
		const direction = /\b(lower|reduce|decrease|drop|loosen)\b/.test(text) ? "lower" : /\b(raise|increase|tighten|bump|higher)\b/.test(text) ? "raise" : "set";
		if (number) return { kind: "tau", value: Number(number[1]), direction };
		if (direction === "raise") return { kind: "tau", value: Number.NaN, direction };
		if (direction === "lower") return { kind: "tau", value: Number.NaN, direction };
	}
	return null;
}

/** The value a tau recipe writes, given the fork's current tau. */
export function tauTarget(recipe: Extract<Recipe, { kind: "tau" }>, currentTau: number): number {
	if (Number.isFinite(recipe.value)) return round2(recipe.value);
	if (recipe.direction === "raise") return round2(Math.min(1, currentTau + 0.05));
	return round2(Math.max(0, currentTau - 0.15));
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

export function tauChange(fluidToml: string, recipe: Extract<Recipe, { kind: "tau" }>): PlannedChange {
	const parsed = parseToml(fluidToml);
	const current = typeof (parsed.thresholds as Record<string, unknown> | undefined)?.tau === "number" ? ((parsed.thresholds as Record<string, unknown>).tau as number) : 0.85;
	const target = tauTarget(recipe, current);
	const lower = target < current;
	return {
		summary: `Set thresholds.tau from ${current} to ${target} in fluid.toml`,
		purpose: lower
			? "Answer in the top mode at lower confidence, so fewer questions show the labeled multi-intent view"
			: "Answer in a single mode only at higher confidence, so more borderline questions show labeled answers per intent",
		modes_affected: ["clinical", "research", "administrative"],
		files: { "fluid.toml": setTomlValue(fluidToml, "thresholds", "tau", target) },
		notes: { "fluid.toml": `tau = ${current} becomes tau = ${target}` },
		recipe: "tau",
	};
}

/** Protocols a persona coordinates (from synthetic personas), used as "my protocols". */
export function protocolsFor(personas: unknown, personaId: string | null): string[] {
	const list = (personas as { personas?: { id: string; protocols?: string[] }[] } | null)?.personas ?? [];
	const own = list.find((p) => p.id === personaId)?.protocols;
	if (own?.length) return own;
	return list.flatMap((p) => p.protocols ?? []).slice(0, 2);
}

const INDEX_IMPORT_ANCHOR = 'import { buildCard } from "./cards.js";';
const INDEX_RETURN = /^(\s*)return buildCard\((\{[^\n]*\})\);$/m;

/** REDCap recipe: a connector over env.data.redcap and a research-mode enrollment answer path. */
export function redcapChange(input: { indexSource: string; protocols: string[] }): PlannedChange {
	if (input.indexSource.includes("../connectors/redcap.js")) throw new Error("this fork already has the REDCap connector");
	if (!input.indexSource.includes(INDEX_IMPORT_ANCHOR) || !INDEX_RETURN.test(input.indexSource)) {
		throw new Error("app/index.ts no longer has the stock buildCard call; the REDCap recipe cannot patch it");
	}
	const index = input.indexSource
		.replace(INDEX_IMPORT_ANCHOR, `${INDEX_IMPORT_ANCHOR}\nimport { withEnrollment } from "../connectors/redcap.js";`)
		.replace(INDEX_RETURN, (_m, indent: string, args: string) => `${indent}const card = await buildCard(${args});\n${indent}return withEnrollment(card, request, env.data);`);
	return {
		summary: "Add a REDCap connector and report enrollment for my protocols in research mode",
		purpose: `Research mode can answer protocol status questions with enrollment counts from REDCap for ${input.protocols.join(" and ")}`,
		modes_affected: ["research"],
		files: { "connectors/redcap.ts": redcapConnectorSource(input.protocols), "app/index.ts": index },
		notes: {
			"connectors/redcap.ts": "REDCap export reader (mock service in env.data.redcap): enrollment by protocol",
			"app/index.ts": "Research answers about my protocols carry an enrollment section",
		},
		recipe: "redcap",
	};
}

export function redcapConnectorSource(protocols: string[]): string {
	const list = protocols.map((p) => JSON.stringify(p)).join(", ");
	return `// REDCap connector (fork customization). Reads the mock REDCap export the
// platform injects as env.data.redcap and adds an enrollment section to
// research-mode answers about this user's protocols. Clinical cards are
// never touched.
import type { AnswerCard, AskRequest } from "../app/types.js";
import type { SyntheticData } from "./types.js";

/** Protocols this user coordinates. */
export const MY_PROTOCOLS: string[] = [${list}];

const PROTOCOL_PATTERN = /IRB-\\d{4}-\\d{4}/gi;
const ENROLLMENT_QUESTION = /\\b(enrol(l)?(ed|ment|ing|s)?|recruit(ed|ing|ment)?|accrual|participants?)\\b/i;
/** Consented and not withdrawn. */
const COUNTED = ["enrolled", "completed"];

export interface Enrollment {
  protocolId: string;
  redcapProjectId: number;
  title: string;
  enrolled: number;
  active: number;
  completed: number;
  withdrawn: number;
  target: number;
  exportedAt: string | null;
}

interface RedcapProject {
  protocolId: string;
  redcapProjectId: number;
  title: string;
  targetEnrollment: number;
  records: { status: string }[];
}

interface RedcapExport {
  exportedAt?: string;
  projects?: RedcapProject[];
}

export function isEnrollmentQuestion(question: string): boolean {
  return ENROLLMENT_QUESTION.test(question);
}

/** Protocols named in the question, or this user's protocols when none is named. */
export function protocolsAsked(question: string): string[] {
  const named = [...new Set((question.match(PROTOCOL_PATTERN) ?? []).map((p) => p.toUpperCase()))];
  return named.length > 0 ? named : MY_PROTOCOLS;
}

export function enrollmentFor(data: SyntheticData | undefined, protocolIds: string[]): Enrollment[] {
  const exp = (data?.redcap ?? {}) as RedcapExport;
  const out: Enrollment[] = [];
  for (const id of protocolIds) {
    const project = exp.projects?.find((p) => p.protocolId === id);
    if (!project) continue;
    const count = (status: string) => project.records.filter((r) => r.status === status).length;
    out.push({
      protocolId: project.protocolId,
      redcapProjectId: project.redcapProjectId,
      title: project.title,
      enrolled: project.records.filter((r) => COUNTED.includes(r.status)).length,
      active: count("enrolled"),
      completed: count("completed"),
      withdrawn: count("withdrawn"),
      target: project.targetEnrollment,
      exportedAt: exp.exportedAt ?? null,
    });
  }
  return out;
}

function enrollmentLines(list: Enrollment[]): string[] {
  if (list.length === 0) return ["Enrollment: no matching protocol in the REDCap export."];
  return list.map(
    (e) => \`Enrollment for \${e.protocolId}: \${e.enrolled} enrolled of \${e.target} target (\${e.active} active, \${e.completed} completed, \${e.withdrawn} withdrawn), REDCap project \${e.redcapProjectId}, export \${e.exportedAt ?? "unknown"}.\`,
  );
}

function addEnrollment(card: AnswerCard, list: Enrollment[]): AnswerCard {
  return { ...card, body: [card.body, ...enrollmentLines(list)].join("\\n"), enrollment: list } as AnswerCard;
}

/** Adds enrollment to the research card, or to the research alternative of a multi-intent card. */
export function withEnrollment(card: AnswerCard, request: AskRequest, data: SyntheticData | undefined): AnswerCard {
  if (!isEnrollmentQuestion(request.question)) return card;
  const list = enrollmentFor(data, protocolsAsked(request.question));
  if (card.mode === "research") return addEnrollment(card, list);
  if (card.mode === "multi" && Array.isArray(card.alternatives)) {
    return { ...card, alternatives: card.alternatives.map((alt) => (alt.mode === "research" ? addEnrollment(alt, list) : alt)) };
  }
  return card;
}
`;
}

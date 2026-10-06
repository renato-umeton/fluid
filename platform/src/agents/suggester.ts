// Test suggester (spec 6.3): reads the change and its build-time intent
// record and proposes tier 3 probes in the stock probe format. Each
// suggestion references the intent it verifies. When a change touches the
// intent engine, the mode contracts, or the tau threshold, it also proposes
// copies of the nearest stock invariants so the user can see how close the
// change runs to the floor.
import type { PlannedChange } from "./recipes.ts";
import { regexProblem } from "../gate/regex.ts";
import { parseUiPreferences, UI_PREFERENCES_PATH } from "../ui/preferences.ts";

export const USER_MANIFEST = "tests/user/manifest.json";
/** The fork's own end-to-end scenarios, run in the yellow soak as the user tier. */
export const USER_E2E = "tests/user/e2e.json";
const OPS = ["equals", "notEquals", "gte", "lte", "exists", "some", "every", "contains", "notContains", "length_gte", "notMatches"];
const ASSERTION_KEYS = ["path", "allowEmpty", ...OPS];
const MODES = ["clinical", "research", "administrative"];
const MAX_NEAR = 2;

export interface Probe {
	id: string;
	description?: string;
	kind?: "ask" | "config";
	/** Fork file a config probe reads (fluid.toml when absent; the platform checks ui/preferences.json itself). */
	file?: string;
	request?: { question: string; context: Record<string, unknown>; explicitMode?: string; attestation?: boolean };
	focusMode?: string;
	samples?: number;
	assert: Record<string, unknown>[];
}

export interface Suggestion {
	id: string;
	title: string;
	file: string;
	rationale: string;
	intentId: string;
	kind: "behavior" | "near-invariant" | "e2e";
	/** Tier 3 probe (behavior and near-invariant suggestions). */
	probe?: Probe;
	/** End-to-end scenario for tests/user/e2e.json (e2e suggestions). */
	scenario?: E2EScenario;
	decision: null | "accept" | "reject" | "edit";
}

/** A user end-to-end scenario in the stock scenario format (stock tests/e2e/runner.ts). */
export interface E2EScenario {
	id: string;
	description?: string;
	requires?: { connector?: string };
	steps: Record<string, unknown>[];
}

export interface SuggestInput {
	change: Pick<PlannedChange, "files" | "recipe" | "purpose" | "modes_affected">;
	intentId: string;
	/** Stock invariant manifest at the fork's pinned tag. */
	invariants: { probes?: Probe[] } | null;
	protocols?: string[];
	/** Previous fluid.toml, to tell whether thresholds changed. */
	previousToml?: string | null;
}

export function suggestTests(input: SuggestInput): Suggestion[] {
	const out: Suggestion[] = [];
	if (input.change.recipe === "redcap") out.push(...redcapSuggestions(input));
	if (input.change.files[UI_PREFERENCES_PATH] !== undefined) out.push(...uiSuggestions(input));
	out.push(...nearInvariantSuggestions(input));
	return dedupe(out);
}

function redcapSuggestions(input: SuggestInput): Suggestion[] {
	const protocols = input.protocols?.length ? input.protocols : ["IRB-2026-0142"];
	const out: Suggestion[] = protocols.slice(0, 2).map((protocol) => ({
		id: testId(input.intentId, `redcap-enrollment-${slug(protocol)}`),
		title: `Research mode reports enrollment for ${protocol}`,
		file: USER_MANIFEST,
		rationale: `Checks the purpose of ${input.intentId}: a research-mode question about ${protocol} returns its enrollment count from the REDCap connector.`,
		intentId: input.intentId,
		kind: "behavior",
		decision: null,
		probe: {
			id: testId(input.intentId, `redcap-enrollment-${slug(protocol)}`),
			description: `Research mode reports REDCap enrollment for ${protocol} (verifies ${input.intentId}).`,
			request: { question: `How many participants are enrolled in ${protocol}?`, context: { documentType: "irb" } },
			focusMode: "research",
			assert: [
				{ path: "enrollment.0.protocolId", equals: protocol },
				{ path: "enrollment.0.enrolled", exists: true },
				{ path: "body", contains: `Enrollment for ${protocol}` },
			],
		},
	}));
	out.push({
		id: testId(input.intentId, "redcap-clinical-untouched"),
		title: "Enrollment never appears on a clinical card",
		file: USER_MANIFEST,
		rationale: `Guards the floor next to ${input.intentId}: with an identified chart open the answer stays clinical and carries no REDCap section.`,
		intentId: input.intentId,
		kind: "behavior",
		decision: null,
		probe: {
			id: testId(input.intentId, "redcap-clinical-untouched"),
			description: `With a chart open, enrollment questions stay clinical without REDCap data (verifies ${input.intentId}).`,
			request: { question: `How many participants are enrolled in ${protocols[0]}?`, context: { chartOpen: { patientId: "synthetic_patient_117", identified: true } } },
			assert: [
				{ path: "mode", equals: "clinical" },
				{ path: "enrollment", exists: false },
			],
		},
	});
	return out;
}

/** A config probe on ui/preferences.json asserting the preferences the change writes. */
function uiSuggestions(input: SuggestInput): Suggestion[] {
	const parsed = parseUiPreferences(input.change.files[UI_PREFERENCES_PATH] ?? null);
	if (!parsed.ok || !parsed.present) return [];
	const p = parsed.preferences;
	const assert: Record<string, unknown>[] = [];
	for (const key of ["look", "font", "density", "accent"] as const) if (p[key] !== undefined) assert.push({ path: key, equals: p[key] });
	for (const tab of p.tabs ?? []) assert.push({ path: "tabs", some: { path: "title", equals: tab.title } });
	if (assert.length === 0) return [];
	const id = testId(input.intentId, "ui-preferences");
	return [{
		id,
		title: "UI preferences stay as requested",
		file: USER_MANIFEST,
		rationale: `Checks the purpose of ${input.intentId}: ${UI_PREFERENCES_PATH} keeps the requested preferences. The platform validates the file and runs this config probe itself (stock's runner reads only TOML).`,
		intentId: input.intentId,
		kind: "behavior",
		decision: null,
		probe: { id, description: `${UI_PREFERENCES_PATH} keeps the requested UI preferences (verifies ${input.intentId}).`, kind: "config", file: UI_PREFERENCES_PATH, assert },
	}];
}

const CHART = { chartOpen: { patientId: "synthetic_patient_117", identified: true } };

/**
 * End-to-end scenarios for a customization, proposed next to its tier 3
 * tests and reviewed the same way. They go to tests/user/e2e.json and run in
 * the yellow soak against the live fork, after the change lands on main.
 */
export function suggestScenarios(input: SuggestInput & { tau?: number | null }): Suggestion[] {
	const out: Suggestion[] = [];
	const add = (name: string, title: string, rationale: string, scenario: Omit<E2EScenario, "id">) => {
		const id = testId(input.intentId, `e2e-${name}`);
		out.push({ id, title, file: USER_E2E, rationale, intentId: input.intentId, kind: "e2e", decision: null, scenario: { id, ...scenario } });
	};
	if (input.change.recipe === "redcap") {
		const protocol = (input.protocols?.length ? input.protocols : ["IRB-2026-0142"])[0]!;
		const question = `How many participants are enrolled in ${protocol}?`;
		add("redcap-no-leak", `Enrollment stays in research mode, even after an override to clinical`, `Checks ${input.intentId} end to end on the live fork: a research question about ${protocol} reports enrollment from REDCap, and when the user overrides that answer to clinical, the clinical answer carries no enrollment number and the override reaches the ledger.`, {
			description: `Research mode reports REDCap enrollment for ${protocol}; overriding to clinical leaks no enrollment into clinical framing (verifies ${input.intentId}).`,
			requires: { connector: "redcap" },
			steps: [
				{ id: "research", kind: "ask", request: { question, context: { documentType: "irb" }, explicitMode: "research" }, assert: [{ path: "mode", equals: "research" }, { path: "enrollment.0.protocolId", equals: protocol }, { path: "body", contains: `Enrollment for ${protocol}` }] },
				{ id: "to-clinical", kind: "override", answer: "$research.answer_id", mode: "clinical", reask: "research", assert: [{ path: "record.override", equals: "clinical" }, { path: "card.mode", equals: "clinical" }, { path: "card.enrollment", exists: false }, { path: "card.body", notMatches: "/Enrollment for|enrolled of|REDCap/i" }, { path: "card.framing", every: { notMatches: "/enrol/i" } }] },
				{ id: "record", kind: "ledger", answer: "$research.answer_id", assert: [{ path: "override", equals: "clinical" }, { path: "fork_commit", equals: "$live.commit" }] },
			],
		});
	}
	const prefsText = input.change.files[UI_PREFERENCES_PATH];
	if (prefsText !== undefined) {
		const parsed = parseUiPreferences(prefsText);
		if (parsed.ok && parsed.present) {
			const assert: Record<string, unknown>[] = [{ path: "valid", equals: true }];
			for (const key of ["look", "font", "density", "accent"] as const) if (parsed.preferences[key] !== undefined) assert.push({ path: `parsed.${key}`, equals: parsed.preferences[key] });
			for (const tab of parsed.preferences.tabs ?? []) assert.push({ path: "parsed.tabs", some: { path: "title", equals: tab.title } });
			add("ui-preferences-live", "The live fork keeps the requested look and still answers with the card contract", `Checks ${input.intentId} on the live fork: ${UI_PREFERENCES_PATH} on main is valid and keeps the requested preferences, and answers still carry the override control (the browser tier also checks that the preferences render).`, {
				description: `${UI_PREFERENCES_PATH} on the live main keeps the requested preferences; answers keep the card contract (verifies ${input.intentId}).`,
				steps: [
					{ id: "prefs", kind: "config", file: UI_PREFERENCES_PATH, assert },
					{ id: "ask", kind: "ask", request: { question: "Is Morphinex on formulary?", context: { documentType: "budget" } }, assert: [{ path: "override_available", equals: true }, { path: "ledger.fork_commit", equals: "$live.commit" }] },
				],
			});
		}
	}
	if (input.change.recipe === "tau" && typeof input.tau === "number" && input.tau >= 0.85) {
		add("tau-recorded", `Answers and ledger records use tau ${input.tau}`, `Checks ${input.intentId} on the live fork: answers report the new threshold and their ledger records carry it.`, {
			description: `The live fork answers at tau ${input.tau} and records it in the ledger (verifies ${input.intentId}).`,
			steps: [
				{ id: "ask", kind: "ask", request: { question: "Is Morphinex on formulary?", context: { documentType: "budget" } }, assert: [{ path: "tau", equals: input.tau }] },
				{ id: "record", kind: "ledger", answer: "$ask.answer_id", assert: [{ path: "tau", equals: input.tau }] },
				{ id: "bedside", kind: "ask", request: { question: "What is the right dose of Morphinex for a patient of 70 kg and 45 years?", context: CHART }, assert: [{ path: "mode", equals: "clinical" }, { path: "computed_dose", equals: null }] },
			],
		});
	}
	if (input.change.recipe === "model") {
		const mode = input.change.modes_affected.find((m) => MODES.includes(m)) ?? "administrative";
		const question = mode === "research" ? "What is the right dose of Morphinex for a patient of 70 kg and 45 years?" : mode === "clinical" ? "What does the policy say about Morphinex?" : "Is Morphinex on formulary?";
		add("override-flow", `An override on a ${mode} answer still reaches the ledger`, `A flow check for ${input.intentId} on the live fork: answer in ${mode} mode, override it, and read the ledger record back.`, {
			description: `A ${mode} answer can be overridden and the override reaches the ledger (verifies ${input.intentId}).`,
			steps: [
				{ id: "ask", kind: "ask", request: { question, context: {}, explicitMode: mode }, assert: [{ path: "mode", equals: mode }, { path: "override_available", equals: true }] },
				{ id: "override", kind: "override", answer: "$ask.answer_id", mode: mode === "clinical" ? "administrative" : "clinical", assert: [{ path: "record.answer_id", equals: "$ask.answer_id" }] },
				{ id: "record", kind: "ledger", answer: "$ask.answer_id", assert: [{ path: "override", exists: true }, { path: "fork_commit", equals: "$live.commit" }] },
			],
		});
	}
	return out;
}

/**
 * Adds accepted scenarios to the fork's tests/user/e2e.json (creating it if
 * needed), with the same ownership rule as tier 3: a scenario with the same
 * id is replaced only when it belongs to the same intent.
 */
export function mergeUserE2E(existing: string | null, scenarios: (E2EScenario & { intentId?: string })[]): string {
	let manifest: { suite: string; description?: string; scenarios: (E2EScenario & { intentId?: string })[] } = {
		suite: "e2e",
		description: "This fork's own end-to-end scenarios. They run in the yellow soak after the stock suite; a scenario with \"disabled\": true is skipped and logged.",
		scenarios: [],
	};
	if (existing) {
		try {
			const parsed = JSON.parse(existing);
			if (parsed && Array.isArray(parsed.scenarios)) manifest = { ...manifest, ...parsed, suite: "e2e" };
		} catch {
			// An unreadable file is replaced; the old text stays in git history.
		}
	}
	for (const scenario of scenarios) {
		const current = manifest.scenarios.find((s) => s.id === scenario.id);
		if (current && current.intentId !== scenario.intentId) throw new Error(`end-to-end scenario ${scenario.id} belongs to ${current.intentId ?? "the user"}; refusing to overwrite it`);
	}
	const ids = new Set(scenarios.map((s) => s.id));
	manifest.scenarios = [...manifest.scenarios.filter((s) => !ids.has(s.id)), ...scenarios];
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Which invariant areas a change touches. */
export function touchedAreas(files: Record<string, string>, previousToml?: string | null): { tau: boolean; intent: boolean; contracts: boolean } {
	const paths = Object.keys(files);
	const toml = files["fluid.toml"];
	const tau = toml !== undefined && thresholdsLine(toml) !== thresholdsLine(previousToml ?? "");
	return {
		tau,
		intent: paths.some((p) => p.startsWith("intent/")),
		contracts: paths.some((p) => p === "policies/contracts.ts" || p.startsWith("policies/clinical")),
	};
}

function thresholdsLine(toml: string): string {
	return toml.split("\n").filter((line) => /^\s*tau\s*=/.test(line)).join("|");
}

function nearInvariantSuggestions(input: SuggestInput): Suggestion[] {
	const areas = touchedAreas(input.change.files, input.previousToml);
	const probes = (input.invariants?.probes ?? []).filter((p) => p.kind !== "config" && p.request);
	const picks: { probe: Probe; why: string }[] = [];
	const add = (match: (p: Probe) => boolean, why: string) => {
		for (const probe of probes) {
			if (picks.length >= MAX_NEAR) return;
			if (match(probe) && !picks.some((x) => x.probe.id === probe.id)) {
				picks.push({ probe, why });
				break;
			}
		}
	};
	if (areas.tau) {
		add((p) => /tau-behavior|tau.*floor/.test(p.id), "the tau threshold");
		add((p) => /near-threshold/.test(p.id), "the tau threshold");
	}
	if (areas.intent) add((p) => /chart-open|floor/.test(p.id), "the intent engine");
	if (areas.contracts) add((p) => /never-doses|dosing-clinical/.test(p.id), "a mode contract");
	return picks.map(({ probe, why }) => {
		const id = `near-${input.intentId}-${probe.id}`.slice(0, 80);
		return {
			id,
			title: `Probe next to invariant ${probe.id}`,
			file: USER_MANIFEST,
			rationale: `This change touches ${why}, so the suggester adds a copy of the nearest stock invariant (${probe.id}) as your own test; it shows how close ${input.intentId} runs to the floor.`,
			intentId: input.intentId,
			kind: "near-invariant" as const,
			decision: null,
			probe: { ...stripProbe(probe), id, description: `Copy of stock invariant ${probe.id} (near ${input.intentId}).` },
		};
	});
}

function stripProbe(probe: Probe): Probe {
	const { id, request, focusMode, assert, kind, samples } = probe;
	return { id, ...(kind ? { kind } : {}), ...(request ? { request } : {}), ...(focusMode ? { focusMode } : {}), ...(samples ? { samples } : {}), assert };
}

/**
 * Test ids carry the intent they verify (t-<intentId>-<name>), so tests
 * from different customizations never share an id and one change can never
 * silently replace another change's test.
 */
export function testId(intentId: string, name: string): string {
	return `t-${intentId}-${name}`.slice(0, 80);
}

function dedupe(list: Suggestion[]): Suggestion[] {
	const seen = new Set<string>();
	return list.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}

function slug(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Schema for model-proposed probes (generic changes). */
export const SUGGESTION_SCHEMA = {
	type: "object",
	properties: {
		suggestions: {
			type: "array",
			items: {
				type: "object",
				properties: {
					title: { type: "string" },
					rationale: { type: "string" },
					question: { type: "string" },
					context: { type: "object" },
					focusMode: { type: "string" },
					assert: { type: "array", items: { type: "object" } },
				},
				required: ["title", "question", "assert"],
			},
		},
	},
	required: ["suggestions"],
} as const;

/** Turns model output into validated suggestions; anything malformed is dropped. */
export function suggestionsFromModel(output: Record<string, unknown>, intentId: string, limit = 3): Suggestion[] {
	const raw = Array.isArray(output.suggestions) ? output.suggestions : [];
	const out: Suggestion[] = [];
	for (const [index, item] of raw.entries()) {
		if (out.length >= limit) break;
		const s = item as Record<string, unknown>;
		const id = testId(intentId, `agent-${index + 1}`);
		const probe: Probe = {
			id,
			description: `${String(s.title ?? "Agent test").slice(0, 120)} (verifies ${intentId}).`,
			request: { question: String(s.question ?? "").slice(0, 300), context: isObject(s.context) ? (s.context as Record<string, unknown>) : {} },
			assert: Array.isArray(s.assert) ? (s.assert as Record<string, unknown>[]).slice(0, 5) : [],
		};
		if (typeof s.focusMode === "string" && MODES.includes(s.focusMode)) probe.focusMode = s.focusMode;
		if (validateProbe(probe) !== null) continue;
		out.push({ id, title: String(s.title).slice(0, 120), file: USER_MANIFEST, rationale: String(s.rationale ?? `Checks the purpose of ${intentId}.`).slice(0, 300), intentId, kind: "behavior", decision: null, probe });
	}
	return out;
}

/** A generic behavior probe when nothing better is available: the fork still answers with the card contract intact. */
export function fallbackSuggestion(intentId: string, modes: string[]): Suggestion {
	const mode = modes.find((m) => MODES.includes(m)) ?? "administrative";
	const question = mode === "research" ? "Summarize what the registry says about Morphinex" : mode === "clinical" ? "What does the policy say about Morphinex?" : "What is the formulary status of Morphinex?";
	const probe: Probe = {
		id: testId(intentId, "card-contract"),
		description: `The fork still answers ${mode} questions with the card contract intact (verifies ${intentId}).`,
		request: { question, context: {}, explicitMode: mode },
		assert: [
			{ path: "mode", equals: mode },
			{ path: "override_available", equals: true },
			{ path: "ledger.answer_id", exists: true },
		],
	};
	return { id: probe.id, title: `${capitalize(mode)} answers keep the card contract`, file: USER_MANIFEST, rationale: `A smoke test for ${intentId}: the change did not break answering in ${mode} mode.`, intentId, kind: "behavior", decision: null, probe };
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function isObject(v: unknown): boolean {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Mirrors the stock runner's manifest validation for one probe; returns an error or null. */
export function validateProbe(probe: Probe): string | null {
	if (typeof probe.id !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(probe.id)) return "id must be 1 to 80 letters, digits, dots, dashes, or underscores";
	if (probe.kind !== "config") {
		if (!probe.request || typeof probe.request.question !== "string" || probe.request.question.trim() === "") return "request.question must be a non-empty string";
		if (!isObject(probe.request.context)) return "request.context must be an object";
	}
	if (probe.focusMode !== undefined && !MODES.includes(probe.focusMode)) return "focusMode must be a mode";
	if (!Array.isArray(probe.assert) || probe.assert.length === 0) return "needs at least one assertion";
	for (const assertion of probe.assert) {
		const error = validateAssertion(assertion);
		if (error) return error;
	}
	return null;
}

function validateAssertion(assertion: unknown): string | null {
	if (!isObject(assertion)) return "each assertion must be an object";
	const a = assertion as Record<string, unknown>;
	for (const key of Object.keys(a)) if (!ASSERTION_KEYS.includes(key)) return `unknown assertion key ${key}`;
	if (!OPS.some((op) => op in a)) return "each assertion needs an op";
	if (a.path !== undefined && typeof a.path !== "string") return "path must be a string";
	if (a.notMatches !== undefined) {
		if (typeof a.notMatches !== "string") return "notMatches must be a string";
		const problem = regexProblem(a.notMatches);
		if (problem) return `notMatches: ${problem}`;
	}
	if (a.some !== undefined) return validateAssertion(a.some);
	if (a.every !== undefined) return validateAssertion(a.every);
	return null;
}

/**
 * Adds accepted probes to the fork's tier 3 manifest text (creating it if
 * needed). A probe with the same id is replaced only when it belongs to the
 * same intent (a retried commit); a probe owned by another intent, or written
 * by the user, is never overwritten. Other probes, including disabled ones,
 * are kept as they are.
 */
export function mergeUserManifest(existing: string | null, probes: (Probe & { intentId?: string })[]): string {
	let manifest: { tier: string; samples?: number; description?: string; probes: (Probe & { intentId?: string })[] } = {
		tier: "user",
		samples: 3,
		description: "Tier 3: this fork's own tests. Owned by the user; a probe with \"disabled\": true is skipped and the gate logs it.",
		probes: [],
	};
	if (existing) {
		try {
			const parsed = JSON.parse(existing);
			if (parsed && Array.isArray(parsed.probes)) manifest = { ...manifest, ...parsed, tier: "user" };
		} catch {
			// An unreadable manifest is replaced; the old text stays in git history.
		}
	}
	for (const probe of probes) {
		const current = manifest.probes.find((p) => p.id === probe.id);
		if (current && current.intentId !== probe.intentId) {
			throw new Error(`tier 3 test ${probe.id} belongs to ${current.intentId ?? "the user"}; refusing to overwrite it`);
		}
	}
	const ids = new Set(probes.map((p) => p.id));
	manifest.probes = [...manifest.probes.filter((p) => !ids.has(p.id)), ...probes];
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

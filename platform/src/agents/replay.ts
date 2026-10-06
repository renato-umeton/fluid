// Intent replay. A Fluid fork is a list of wishes and the tests that prove
// them. Recipe changes (tau, ui, REDCap, and the seeded framing wording)
// record in their intent record how to run them again: `replay` is
// { kind, params }. On a stock release the platform can then rebuild the
// fork from fresh stock at the new tag by running each wish again in commit
// order, instead of merging old text. Model-written changes record
// { kind: "model", request } and are not replayed: a fork with one of them
// upgrades by merge, as before.
//
// Everything here is pure: files in, files and per-wish results out. The
// upgrade workflow commits the result and the gate decides.
import type { BuildTimeIntent } from "../forks/provision.ts";
import { parseToml, setTomlValue } from "../lib/toml.ts";
import { framingLineIndex } from "../stock/releases.ts";
import { parseUiPreferences, UI_PREFERENCES_PATH, uiPreferencesJson, validateUiPreferences, type UiPreferences } from "../ui/preferences.ts";
import { cleanText, MAX_REQUEST_CHARS } from "./intent.ts";
import { redcapChange, type PlannedChange } from "./recipes.ts";
import { applyUiMapping, type UiReplayParams } from "./ui-recipe.ts";

export type ReplaySpec =
	| { kind: "redcap"; params: { protocols: string[] } }
	| { kind: "tau"; params: { value: number } }
	| { kind: "ui"; params: UiReplayParams }
	| { kind: "framing"; params: { line: string } }
	| { kind: "model"; request: string };

export type ReplayKind = ReplaySpec["kind"];

/** Kinds the platform can run again deterministically. */
export const REPLAYABLE_KINDS: readonly ReplayKind[] = ["redcap", "tau", "ui", "framing"];

/** Agents whose records are the user's wishes. Platform records (onboarding, merge, repair, rollback) are carried, not replayed. */
export const WISH_AGENTS = ["customization-agent", "seed-customization"];

/** Paths a replay copies from the fork's main: its intent records, repair notes, and its own tests. */
const CARRIED_PREFIXES = [".intent/", ".repair/", "tests/user/"];

export type WishStatus = "replayed" | "fallback" | "failed";

export interface WishResult {
	intentId: string;
	status: WishStatus;
	reason: string;
	kind: ReplayKind | null;
	request: string;
	/** Paths this wish changed on the new base. */
	changed: string[];
	/** Of those, the ones stock also changed between the two tags (fluid.toml aside): where a merge would have had to resolve text. Set by planReplay. */
	stockAlsoChanged?: string[];
}

/** The files one replayed wish wrote, for its own commit. */
export interface ReplayStep {
	intentId: string;
	files: Record<string, string>;
}

/** The replay field for a new intent record: the recipe's own, the request for a model plan, or none. */
export function replayRecordFor(change: Pick<PlannedChange, "recipe" | "replay">, request: string): ReplaySpec | null {
	if (change.replay) return change.replay;
	if (change.recipe === "model") return { kind: "model", request: cleanText(request, MAX_REQUEST_CHARS) };
	return null;
}

/** Spread into an intent record: the replay field when there is one, nothing otherwise (older records have none). */
export function replayExtra(spec: ReplaySpec | null | undefined): { replay?: ReplaySpec } {
	return spec ? { replay: spec } : {};
}

export function isWish(intent: BuildTimeIntent): boolean {
	return typeof intent.agent === "string" && WISH_AGENTS.includes(intent.agent);
}

export function isCarriedPath(path: string): boolean {
	return CARRIED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PROTOCOL_ID = /^[A-Za-z0-9._-]{1,40}$/;
const UI_PARAM_KEYS = ["look", "font", "density", "accent", "tab"];

/**
 * The record's replay field, checked. Intent records live in the fork and
 * its owner can edit them, so anything malformed reads as "no replay" and
 * the fork upgrades by merge.
 */
export function replayOf(intent: BuildTimeIntent): ReplaySpec | null {
	const replay = intent.replay;
	if (!isObject(replay)) return null;
	const params = replay.params;
	switch (replay.kind) {
		case "model":
			return typeof replay.request === "string" ? { kind: "model", request: cleanText(replay.request, MAX_REQUEST_CHARS) } : null;
		case "tau": {
			const value = isObject(params) ? params.value : undefined;
			return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? { kind: "tau", params: { value } } : null;
		}
		case "redcap": {
			const list = isObject(params) ? params.protocols : undefined;
			if (!Array.isArray(list) || list.length === 0 || list.length > 10) return null;
			return list.every((p) => typeof p === "string" && PROTOCOL_ID.test(p)) ? { kind: "redcap", params: { protocols: [...(list as string[])] } } : null;
		}
		case "framing": {
			const line = isObject(params) ? params.line : undefined;
			return typeof line === "string" && line.trim() !== "" && line.length <= 400 && !/[\u0000-\u001f\u007f]/.test(line) ? { kind: "framing", params: { line } } : null;
		}
		case "ui": {
			if (!isObject(params) || Object.keys(params).some((k) => !UI_PARAM_KEYS.includes(k))) return null;
			const { tab, ...rest } = params;
			const check = validateUiPreferences({ ...rest, ...(tab === undefined ? {} : { tabs: [tab] }) });
			return check.ok ? { kind: "ui", params: params as UiReplayParams } : null;
		}
		default:
			return null;
	}
}

/** Runs one wish on `files`; returns the files it writes. Throws when the wish no longer applies. */
export function applyReplay(files: Record<string, string>, spec: Exclude<ReplaySpec, { kind: "model" }>): Record<string, string> {
	switch (spec.kind) {
		case "tau": {
			const toml = files["fluid.toml"];
			if (toml === undefined) throw new Error("the new stock has no fluid.toml");
			return { "fluid.toml": setTomlValue(toml, "thresholds", "tau", spec.params.value) };
		}
		case "redcap":
			return redcapChange({ indexSource: files["app/index.ts"] ?? "", protocols: spec.params.protocols }).files;
		case "framing": {
			const text = files["app/cards.ts"];
			const lines = (text ?? "").split("\n");
			const index = framingLineIndex(lines);
			if (text === undefined || index === -1) throw new Error("the multi-intent framing line is no longer in app/cards.ts");
			lines[index] = spec.params.line;
			return { "app/cards.ts": lines.join("\n") };
		}
		case "ui": {
			const current = parseUiPreferences(files[UI_PREFERENCES_PATH] ?? null);
			const base: UiPreferences = current.ok ? structuredClone(current.preferences) : {};
			const text = uiPreferencesJson(applyUiMapping(base, spec.params));
			const check = parseUiPreferences(text);
			if (!check.ok) throw new Error(`${UI_PREFERENCES_PATH} would not be valid: ${check.errors.join("; ")}`);
			return { [UI_PREFERENCES_PATH]: text };
		}
	}
}

function describe(spec: Exclude<ReplaySpec, { kind: "model" }>): string {
	switch (spec.kind) {
		case "tau":
			return `thresholds.tau set to ${spec.params.value} in fluid.toml`;
		case "redcap":
			return `REDCap connector for ${spec.params.protocols.join(", ")}; app/index.ts patched again on the new stock`;
		case "framing":
			return "multi-intent framing line set to this fork's wording in app/cards.ts";
		case "ui": {
			const p = spec.params;
			const parts = [p.look && `look ${p.look}`, p.font && `font ${p.font}`, p.density && `density ${p.density}`, p.accent && `accent ${p.accent}`, p.tab && `tab "${p.tab.title}"`].filter(Boolean);
			return `${UI_PREFERENCES_PATH}: ${parts.join(", ")}`;
		}
	}
}

/**
 * Rebuilds a fork from `stockFiles` (stock at the new tag, usually with the
 * fork's settings carried by replayBase) by running each wish in the order
 * given. Records that are not wishes are skipped. A wish that cannot be
 * replayed is "fallback"; one that no longer applies is "failed"; both leave
 * the files as they were and the next wish still runs.
 */
export function replayIntents(stockFiles: Record<string, string>, intents: BuildTimeIntent[]): { files: Record<string, string>; results: WishResult[]; steps: ReplayStep[] } {
	let files = { ...stockFiles };
	const results: WishResult[] = [];
	const steps: ReplayStep[] = [];
	for (const intent of intents) {
		if (!isWish(intent)) continue;
		const spec = replayOf(intent);
		const base = { intentId: intent.id, request: cleanText(intent.request, 200), kind: spec?.kind ?? null, changed: [] as string[] };
		if (!spec || spec.kind === "model") {
			const reason = spec ? "written by the agent model, so it cannot be run again exactly; this fork upgrades by merge" : "no replay record (made before intent replay, or not a recipe); this fork upgrades by merge";
			results.push({ ...base, status: "fallback", reason });
			continue;
		}
		let written: Record<string, string>;
		try {
			written = applyReplay(files, spec);
		} catch (error) {
			results.push({ ...base, status: "failed", reason: `no longer applies: ${error instanceof Error ? error.message : String(error)}` });
			continue;
		}
		const changed = Object.keys(written).filter((path) => written[path] !== files[path]).sort();
		const step = Object.fromEntries(changed.map((path) => [path, written[path]!]));
		files = { ...files, ...step };
		steps.push({ intentId: intent.id, files: step });
		results.push({ ...base, status: "replayed", changed, reason: changed.length ? describe(spec) : "already true on the new base; nothing to change" });
	}
	return { files, results, steps };
}

/**
 * The start of a replay: stock's files at `tag`, plus what belongs to the
 * fork and is not a wish: its intent records, repair notes, and own tests
 * from main (records are never deleted), and fluid.toml from stock with
 * stock_tag set to `tag` and the fork's [preferences] values.
 */
export function replayBase(stockFiles: Record<string, string>, mainFiles: Record<string, string>, tag: string): Record<string, string> {
	const files = { ...stockFiles };
	for (const [path, text] of Object.entries(mainFiles)) if (isCarriedPath(path)) files[path] = text;
	const stockToml = stockFiles["fluid.toml"];
	if (stockToml === undefined) throw new Error(`stock ${tag} has no fluid.toml`);
	let toml = setTomlValue(stockToml, null, "stock_tag", tag);
	const prefs = mainFiles["fluid.toml"] ? (parseToml(mainFiles["fluid.toml"]).preferences ?? {}) : {};
	for (const [key, value] of Object.entries(prefs)) if (typeof value !== "object") toml = setTomlValue(toml, "preferences", key, value);
	files["fluid.toml"] = toml;
	return files;
}

/** Intent records in commit order (oldest first); records no commit names follow, oldest first by created_at. */
export function orderIntents(intents: BuildTimeIntent[], commitOrder: string[]): BuildTimeIntent[] {
	const at = new Map(commitOrder.map((id, i) => [id, i]));
	const known = intents.filter((i) => at.has(i.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!);
	const rest = intents.filter((i) => !at.has(i.id)).sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
	return [...known, ...rest];
}

function canonical(value: unknown): string {
	if (!isObject(value)) return JSON.stringify(value);
	return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

function sameToml(a: string | undefined, b: string | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	try {
		return canonical(parseToml(a)) === canonical(parseToml(b));
	} catch {
		return a === b;
	}
}

/**
 * Replay compares and writes text, so it only runs on plain files. Every
 * entry of every tree must be a plain file (mode 100644, not executable, not
 * a link or a submodule), and every file outside the carried folders must be
 * valid UTF-8 text. Carried files may be binary: they are copied by bytes.
 * Returns why replay cannot run, or null.
 */
export function treeGuard(trees: { name: string; files: Record<string, { mode: string; text: string | null }> }[]): string | null {
	for (const { name, files } of trees) {
		for (const [path, entry] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
			if (entry.mode !== "100644") return `${name} has ${path} with mode ${entry.mode}; replay writes plain files only`;
			if (entry.text === null && !isCarriedPath(path)) return `${name} has ${path}, a binary or non-UTF-8 file outside the carried folders; replay compares text only`;
		}
	}
	return null;
}

/** Paths where a rebuilt tree differs from main (carried paths excluded; fluid.toml compared by value). */
export function differingPaths(rebuilt: Record<string, string>, main: Record<string, string>): string[] {
	const paths = [...new Set([...Object.keys(rebuilt), ...Object.keys(main)])].filter((p) => !isCarriedPath(p)).sort();
	return paths.filter((p) => (p === "fluid.toml" ? !sameToml(rebuilt[p], main[p]) : rebuilt[p] !== main[p]));
}

export type ReplayPlan =
	| { mode: "replay"; files: Record<string, string>; base: Record<string, string>; results: WishResult[]; steps: ReplayStep[] }
	| { mode: "merge"; reason: string; results: WishResult[] };

/**
 * Decides whether an upgrade can rebuild the fork by replay. It can when the
 * fork has at least one wish, every wish is replayable, replaying them on
 * the fork's current tag rebuilds main exactly (so nothing on main is lost),
 * and every wish still applies at the new tag. On a safety release no wish
 * may change a file stock also changed. Otherwise the upgrade merges, and
 * the reason says why.
 */
export function planReplay(input: {
	tag: string;
	fromTag: string;
	stockAtTag: Record<string, string>;
	stockAtFrom: Record<string, string>;
	mainFiles: Record<string, string>;
	/** In commit order (orderIntents). */
	intents: BuildTimeIntent[];
	/** A safety release: a wish over a file stock also changed takes the merge path, where the merge agent, the gate, and a repair handle it. */
	safety?: boolean;
}): ReplayPlan {
	const wishes = input.intents.filter(isWish);
	if (wishes.length === 0) return { mode: "merge", reason: "no wishes to carry; a plain merge of stock is enough", results: [] };
	const base = replayBase(input.stockAtTag, input.mainFiles, input.tag);
	const replayed = replayIntents(base, input.intents);
	const stockChanged = (path: string) => path !== "fluid.toml" && input.stockAtFrom[path] !== input.stockAtTag[path];
	const atTag = { ...replayed, results: replayed.results.map((r) => ({ ...r, stockAlsoChanged: r.changed.filter(stockChanged) })) };
	const fallback = atTag.results.filter((r) => r.status === "fallback");
	if (fallback.length) {
		return { mode: "merge", reason: `${wishes.length - fallback.length} of ${wishes.length} wishes can be replayed; ${fallback.map((r) => r.intentId).join(", ")} cannot, so this fork upgrades by merge`, results: atTag.results };
	}
	const atFrom = replayIntents(replayBase(input.stockAtFrom, input.mainFiles, input.fromTag), input.intents);
	const notAtFrom = atFrom.results.find((r) => r.status !== "replayed");
	if (notAtFrom) return { mode: "merge", reason: `${notAtFrom.intentId} does not replay on ${input.fromTag} (${notAtFrom.reason}), so main cannot be rebuilt from its wishes`, results: atTag.results };
	const differs = differingPaths(atFrom.files, input.mainFiles);
	if (differs.length) {
		const shown = differs.slice(0, 5).join(", ") + (differs.length > 5 ? `, and ${differs.length - 5} more` : "");
		return { mode: "merge", reason: `replaying the wishes on ${input.fromTag} does not rebuild main exactly (${shown}): main has changes no wish records`, results: atTag.results };
	}
	const failed = atTag.results.filter((r) => r.status === "failed");
	if (failed.length) return { mode: "merge", reason: failed.map((r) => `${r.intentId} ${r.reason} on ${input.tag}`).join("; "), results: atTag.results };
	const overlap = [...new Set(atTag.results.flatMap((r) => r.stockAlsoChanged ?? []))];
	if (input.safety && overlap.length) return { mode: "merge", reason: `safety release ${input.tag} changes ${overlap.join(", ")}, which wishes also change; the merge path handles it`, results: atTag.results };
	return { mode: "replay", files: atTag.files, base, results: atTag.results, steps: atTag.steps };
}

export interface ReplaySummary {
	tag: string;
	path: "replay" | "merge";
	carried: number;
	total: number;
	reason?: string;
	wishes: { intentId: string; status: WishStatus; kind: ReplayKind | null; request: string; reason: string; stockAlsoChanged: string[] }[];
}

/** "3 of 3 wishes carried to v1.11.0" (replay), or why the upgrade took the merge path. */
export function wishesCarriedText(summary: ReplaySummary): string {
	if (summary.path === "replay") return `${summary.carried} of ${summary.total} wish${summary.total === 1 ? "" : "es"} carried to ${summary.tag}`;
	return `Upgrade to ${summary.tag} took the merge path${summary.reason ? `: ${summary.reason}` : ""}`;
}

/** What the run, the fleet entry, and the UI show: "N of M wishes carried to <tag>" and each wish's result. */
export function replaySummary(tag: string, path: "replay" | "merge", results: WishResult[], reason?: string): ReplaySummary {
	return {
		tag,
		path,
		carried: path === "replay" ? results.filter((r) => r.status === "replayed").length : 0,
		total: results.length,
		...(reason ? { reason: reason.slice(0, 500) } : {}),
		wishes: results.slice(0, 50).map((r) => ({ intentId: r.intentId, status: r.status, kind: r.kind, request: r.request, reason: r.reason.slice(0, 300), stockAlsoChanged: r.stockAlsoChanged ?? [] })),
	};
}

// Stock release metadata and the demo release change. Every published tag
// gets releases/<tag>.json in stock: notes, the safety flag, the date, and
// for safety releases the grace period from spec 7 (after it, a pinned
// fork's failing capability falls back to stock behavior until repaired).
import stockSource from "../generated/stock-source.json";
import { parseToml, setTomlValue } from "../lib/toml.ts";

export const RELEASES_DIR = "releases/";
/** Spec 7 leaves the length open; the demo uses two weeks. */
export const SAFETY_GRACE_DAYS = 14;

export interface ReleaseMetadata {
	tag: string;
	notes: string;
	safety: boolean;
	date: string;
	graceDays: number | null;
	graceUntil: string | null;
	previousTag: string | null;
	intentId: string | null;
}

export function releaseMetadata(input: { tag: string; notes?: string; safety?: boolean; date?: Date; previousTag?: string | null; intentId?: string | null }): ReleaseMetadata {
	const date = input.date ?? new Date();
	const safety = input.safety === true;
	const graceUntil = safety ? new Date(date.getTime() + SAFETY_GRACE_DAYS * 86_400_000).toISOString() : null;
	return {
		tag: input.tag,
		notes: cleanNotes(input.notes ?? ""),
		safety,
		date: date.toISOString(),
		graceDays: safety ? SAFETY_GRACE_DAYS : null,
		graceUntil,
		previousTag: input.previousTag ?? null,
		intentId: input.intentId ?? null,
	};
}

export function releaseMetadataPath(tag: string): string {
	return `${RELEASES_DIR}${tag}.json`;
}

/** Release notes are free text from an admin: printable characters only, bounded length. */
export function cleanNotes(notes: string): string {
	return notes.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, 2000);
}

/** Line in app/cards.ts the demo releases reword. Seeded forks that customized the same line conflict on purpose. */
export const MULTI_FRAMING_PREFIX = "      : `Top intent confidence ${round(decision.confidence)} is below the threshold ${decision.tau}; ";
const MULTI_FRAMING_ENDINGS = [
	"labeled answers are shown for each plausible intent, most likely first.`,",
	"choose the labeled answer that matches what you are doing.`,",
	"each plausible intent gets its own labeled answer.`,",
];

export interface OverlayProbe {
	id: string;
	[key: string]: unknown;
}

/** Invariant probes a demo release adds to the floor (stock/overlays/demo-release/invariants.json). */
export const DEMO_OVERLAY: { description?: string; probes: OverlayProbe[] } = (stockSource as unknown as { demoOverlay: { description?: string; probes: OverlayProbe[] } }).demoOverlay;

const INVARIANTS_PATH = "tests/invariants/manifest.json";

/** True when an invariant manifest already carries every demo release probe. */
export function hasDemoTightening(invariantsText: string | null | undefined): boolean {
	if (!invariantsText) return false;
	const ids = new Set(((JSON.parse(invariantsText) as { probes?: { id?: string }[] }).probes ?? []).map((p) => p.id));
	return DEMO_OVERLAY.probes.every((p) => ids.has(p.id));
}

/**
 * The demo release: the current stock files with
 * - one benign wording change to the multi-intent framing (a different
 *   phrasing each release), so a release always has a real diff and some
 *   customized forks conflict;
 * - the overlay invariants appended to tests/invariants/manifest.json when
 *   missing, so the release tightens the floor and seeded forks that strip
 *   the research cross-check fail only at the new tag;
 * - harvest_opt_in = false in stock's fluid.toml (harvesting is opt-in).
 */
export function demoReleaseFiles(files: Record<string, string>, tag?: string): { files: Record<string, string>; changed: string[] } {
	const path = "app/cards.ts";
	const text = files[path];
	if (text === undefined) throw new Error("stock has no app/cards.ts");
	const lines = text.split("\n");
	const index = lines.findIndex((line) => line.startsWith(MULTI_FRAMING_PREFIX) || line.includes("is below the threshold ${decision.tau}; "));
	if (index === -1) throw new Error("demo release: the multi-intent framing line was not found in app/cards.ts");
	const current = lines[index]!.replace(/\s*\/\/ wording revised in \S+$/, "");
	const ending = MULTI_FRAMING_ENDINGS.find((e) => !current.endsWith(e)) ?? MULTI_FRAMING_ENDINGS[0]!;
	// The trailing comment names the release, so the line differs from every earlier release's
	// (a fork pinned several releases back still conflicts if it customized this line).
	lines[index] = `${MULTI_FRAMING_PREFIX}${ending}${tag ? ` // wording revised in ${tag}` : ""}`;
	const out: Record<string, string> = { ...files, [path]: lines.join("\n") };
	const changed = [path];

	const invariantsText = files[INVARIANTS_PATH];
	if (invariantsText === undefined) throw new Error(`stock has no ${INVARIANTS_PATH}`);
	const manifest = JSON.parse(invariantsText) as { probes: OverlayProbe[] };
	const present = new Set(manifest.probes.map((p) => p.id));
	const added = DEMO_OVERLAY.probes.filter((p) => !present.has(p.id));
	if (added.length > 0) {
		out[INVARIANTS_PATH] = `${JSON.stringify({ ...manifest, probes: [...manifest.probes, ...added] }, null, 2)}\n`;
		changed.push(INVARIANTS_PATH);
	}

	const toml = files["fluid.toml"];
	if (toml !== undefined && (parseToml(toml).preferences as Record<string, unknown> | undefined)?.harvest_opt_in !== false) {
		out["fluid.toml"] = setTomlValue(toml, "preferences", "harvest_opt_in", false);
		changed.push("fluid.toml");
	}
	return { files: out, changed };
}

/** Tag pinned in a fluid.toml, or null. */
export function pinnedTagOf(fluidToml: string | null | undefined): string | null {
	if (!fluidToml) return null;
	try {
		const tag = parseToml(fluidToml).stock_tag;
		return typeof tag === "string" ? tag : null;
	} catch {
		return null;
	}
}

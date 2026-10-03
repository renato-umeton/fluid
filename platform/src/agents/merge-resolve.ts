// Merge agent for upgrades (spec 7): resolves textual conflicts between a
// fork and a new stock tag using the fork's build-time intent records. The
// model proposes resolutions; the deterministic fallback keeps the fork's
// version of every file an intent record lists (the customization is the
// point of the fork), takes stock's version otherwise, and always keeps the
// fork's fluid.toml with stock_tag moved to the new tag. Either way the gate
// decides whether the result may ship.
import type { ConflictVersions } from "../git/ops.ts";
import type { BuildTimeIntent } from "../forks/provision.ts";
import { setTomlValue } from "../lib/toml.ts";
import { transformTs } from "../runtime/modules.ts";

export type Choice = "ours" | "theirs" | "merged" | "toml";

export interface Resolution {
	path: string;
	choice: Choice;
	content: string | null;
	reason: string;
	intentIds: string[];
	by: "model" | "fallback";
}

/** Intent records that list a path (agent-written records only; onboarding and stock records do not count). */
export function intentsForPath(intents: BuildTimeIntent[], path: string): BuildTimeIntent[] {
	return intents.filter((i) => i.agent !== "onboarding" && i.agent !== null && Array.isArray(i.files) && i.files.includes(path));
}

export function fallbackResolution(version: ConflictVersions, intents: BuildTimeIntent[], newTag: string): Resolution {
	const { path } = version;
	if (path === "fluid.toml") {
		const base = version.ours ?? version.theirs ?? "";
		return { path, choice: "toml", content: setTomlValue(base, null, "stock_tag", newTag), reason: `Kept this fork's settings and moved stock_tag to ${newTag}.`, intentIds: [], by: "fallback" };
	}
	const owners = intentsForPath(intents, path);
	if (owners.length > 0 && version.ours !== null) {
		return {
			path,
			choice: "ours",
			content: version.ours,
			reason: `Kept the fork's version: ${owners.map((i) => `${i.id} ("${i.purpose || i.request}")`).join("; ")} changed this file on purpose. Stock's change to it is not applied; the gate checks the result against ${newTag}.`,
			intentIds: owners.map((i) => i.id),
			by: "fallback",
		};
	}
	return {
		path,
		choice: "theirs",
		content: version.theirs,
		reason: version.theirs === null ? `Stock ${newTag} removed this file and no intent record claims it.` : `No intent record claims this file, so stock ${newTag}'s version wins.`,
		intentIds: [],
		by: "fallback",
	};
}

export const MERGE_SCHEMA = {
	type: "object",
	properties: {
		resolutions: {
			type: "array",
			items: {
				type: "object",
				properties: {
					path: { type: "string" },
					choice: { type: "string", enum: ["ours", "theirs", "merged"] },
					content: { type: "string" },
					reason: { type: "string" },
				},
				required: ["path", "choice", "reason"],
			},
		},
	},
	required: ["resolutions"],
} as const;

export function mergePrompt(versions: ConflictVersions[], intents: BuildTimeIntent[], newTag: string): string {
	const records = intents
		.filter((i) => i.agent !== "onboarding")
		.map((i) => `- ${i.id}: request "${i.request}"; purpose "${i.purpose}"; files ${i.files.join(", ")}`)
		.join("\n");
	const files = versions
		.map((v) => `### ${v.path}\n--- base\n${v.base ?? "(absent)"}\n--- fork (ours)\n${v.ours ?? "(deleted)"}\n--- stock ${newTag} (theirs)\n${v.theirs ?? "(deleted)"}`)
		.join("\n\n");
	return `A personal fork of a clinical assistant is upgrading to stock ${newTag}. These files conflict. Use the fork's build-time intent records to keep each customization's purpose while taking stock's changes where they do not contradict it. Choose "ours", "theirs", or "merged" (then give the full merged file content). Never weaken safety behavior.\n\nIntent records:\n${records || "(none)"}\n\n${files}`;
}

/**
 * Validates model resolutions: every conflicted path covered, merged
 * TypeScript must still parse. Paths the model got wrong use the fallback.
 */
export function acceptModelResolutions(output: Record<string, unknown>, versions: ConflictVersions[], intents: BuildTimeIntent[], newTag: string): Resolution[] {
	const proposed = Array.isArray(output.resolutions) ? (output.resolutions as Record<string, unknown>[]) : [];
	return versions.map((version) => {
		if (version.path === "fluid.toml") return fallbackResolution(version, intents, newTag);
		const p = proposed.find((r) => r.path === version.path);
		const owners = intentsForPath(intents, version.path).map((i) => i.id);
		const reason = typeof p?.reason === "string" ? p.reason.slice(0, 400) : "";
		if (p?.choice === "ours" && version.ours !== null) return { path: version.path, choice: "ours", content: version.ours, reason, intentIds: owners, by: "model" };
		if (p?.choice === "theirs") return { path: version.path, choice: "theirs", content: version.theirs, reason, intentIds: owners, by: "model" };
		if (p?.choice === "merged" && typeof p.content === "string" && p.content.length > 0 && p.content.length < 64_000 && !/^(<{7}|={7}|>{7})/m.test(p.content) && parses(version.path, p.content)) {
			return { path: version.path, choice: "merged", content: p.content, reason, intentIds: owners, by: "model" };
		}
		return fallbackResolution(version, intents, newTag);
	});
}

function parses(path: string, content: string): boolean {
	if (path.endsWith(".json")) {
		try {
			JSON.parse(content);
			return true;
		} catch {
			return false;
		}
	}
	if (!path.endsWith(".ts")) return true;
	try {
		transformTs(content, path);
		return true;
	} catch {
		return false;
	}
}

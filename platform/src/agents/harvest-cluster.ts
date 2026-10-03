// Harvester clustering (spec 9): groups build-time intent records from
// opted-in forks by what the customization was for. Deterministic keyword
// clustering (request, purpose, and touched files as tokens, greedy Jaccard)
// produces the groups; the model only labels them.
import type { BuildTimeIntent } from "../forks/provision.ts";
import { slugify } from "./intent.ts";

export interface HarvestRecord {
	repo: string;
	intent: BuildTimeIntent;
}

export interface Cluster {
	key: string;
	tokens: string[];
	records: HarvestRecord[];
}

export interface HarvestProposal {
	cluster: string;
	slug: string;
	count: number;
	forks: string[];
	intents: (BuildTimeIntent & { repo: string })[];
	keywords: string[];
	modes_affected: string[];
	proposedFiles: string[];
	eligible: boolean;
	reason: string;
	summary: string;
	draftBranch: string | null;
	retires: string | null;
	referenceFork: string | null;
}

const HARVESTABLE_AGENTS = new Set(["customization-agent", "seed-customization"]);
const STOPWORDS = new Set(
	"a an and are as at be by can for from has have i in into is it its me my of on or our so that the their this to too up when with we you your add adds added make makes so show shows use uses more less than then them they do does not no new mode modes answer answers question questions please want would like should".split(" "),
);
export const MIN_DRAFT_COUNT = 3;
const SIMILARITY = 0.3;
/** Files whose change touches the floor: never drafted into stock automatically. */
const FLOOR_FILES = /^(fluid\.toml|intent\/|policies\/contracts\.ts|policies\/clinical|policies\/dose\.ts)/;

export function harvestable(intent: BuildTimeIntent): boolean {
	return intent.agent !== null && HARVESTABLE_AGENTS.has(intent.agent);
}

export function tokensOf(intent: BuildTimeIntent): string[] {
	const words = `${intent.request} ${intent.purpose}`
		.toLowerCase()
		.replace(/[^a-z0-9 ]+/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
		.map(stem);
	const files = intent.files.filter((f) => !f.startsWith(".intent/") && !f.startsWith("tests/")).map((f) => `file:${f}`);
	return [...new Set([...words, ...files])];
}

function stem(word: string): string {
	return word.replace(/(ments?|ings?|ed|es|s)$/, "") || word;
}

export function jaccard(a: string[], b: string[]): number {
	const sa = new Set(a);
	const sb = new Set(b);
	let inter = 0;
	for (const x of sa) if (sb.has(x)) inter++;
	const union = sa.size + sb.size - inter;
	return union === 0 ? 0 : inter / union;
}

/** Greedy clustering in a stable order; one record per fork counts once per cluster. */
export function clusterRecords(records: HarvestRecord[]): Cluster[] {
	const clusters: (Cluster & { counts: Map<string, number> })[] = [];
	const ordered = [...records].filter((r) => harvestable(r.intent)).sort((a, b) => (a.repo + a.intent.id).localeCompare(b.repo + b.intent.id));
	for (const record of ordered) {
		const tokens = tokensOf(record.intent);
		let best: (typeof clusters)[number] | null = null;
		let bestScore = 0;
		for (const cluster of clusters) {
			const score = jaccard(tokens, cluster.tokens);
			if (score > bestScore) {
				best = cluster;
				bestScore = score;
			}
		}
		if (best && bestScore >= SIMILARITY) {
			best.records.push(record);
			for (const t of tokens) best.counts.set(t, (best.counts.get(t) ?? 0) + 1);
			// Centroid: tokens present in at least half of the members.
			best.tokens = [...best.counts.entries()].filter(([, n]) => n * 2 >= best.records.length).map(([t]) => t);
		} else {
			clusters.push({ key: tokens.slice(0, 4).join("-"), tokens, records: [record], counts: new Map(tokens.map((t) => [t, 1])) });
		}
	}
	return clusters
		.map(({ key, tokens, records: members }) => ({ key, tokens, records: members }))
		.sort((a, b) => forksIn(b).length - forksIn(a).length || a.key.localeCompare(b.key));
}

export function forksIn(cluster: Cluster): string[] {
	return [...new Set(cluster.records.map((r) => r.repo))].sort();
}

/** Keywords for a label: most common word tokens, then file stems. */
export function keywordsOf(cluster: Cluster, limit = 4): string[] {
	const counts = new Map<string, number>();
	for (const r of cluster.records) for (const t of tokensOf(r.intent)) counts.set(t, (counts.get(t) ?? 0) + 1);
	return [...counts.entries()]
		.filter(([t]) => !t.startsWith("file:"))
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([t]) => t);
}

export function deterministicLabel(cluster: Cluster): string {
	const files = proposedFilesOf(cluster);
	const words = keywordsOf(cluster, 3);
	const base = words.join(" ") || files.map((f) => f.split("/").pop()).join(", ") || "customization";
	return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Files most members touched (the reference implementation's footprint). */
export function proposedFilesOf(cluster: Cluster): string[] {
	const counts = new Map<string, number>();
	for (const r of cluster.records) for (const f of new Set(r.intent.files)) if (!f.startsWith(".intent/") && !f.startsWith("tests/")) counts.set(f, (counts.get(f) ?? 0) + 1);
	return [...counts.entries()].filter(([, n]) => n * 2 >= cluster.records.length).map(([f]) => f).sort();
}

export function eligibility(cluster: Cluster): { eligible: boolean; reason: string } {
	const forks = forksIn(cluster).length;
	const files = proposedFilesOf(cluster);
	const floor = files.filter((f) => FLOOR_FILES.test(f));
	if (floor.length > 0) return { eligible: false, reason: `Touches the floor (${floor.join(", ")}); a stock change here goes through the safety review, not the harvester.` };
	const modes = new Set(cluster.records.flatMap((r) => r.intent.modes_affected));
	if (modes.has("clinical")) return { eligible: false, reason: "Changes clinical behavior; needs clinical informatics review before a stock draft." };
	if (forks < MIN_DRAFT_COUNT) return { eligible: false, reason: `Only ${forks} fork${forks === 1 ? "" : "s"}; the harvester drafts clusters with at least ${MIN_DRAFT_COUNT}.` };
	if (files.length === 0) return { eligible: false, reason: "No shared files to take as a reference implementation." };
	return { eligible: true, reason: `${forks} forks made this change independently.` };
}

export function proposalOf(cluster: Cluster, label: string, summary: string | null): HarvestProposal {
	const forks = forksIn(cluster);
	const { eligible, reason } = eligibility(cluster);
	const slug = slugify(label, "feature");
	const files = proposedFilesOf(cluster);
	const reference = cluster.records.find((r) => files.every((f) => r.intent.files.includes(f)))?.repo ?? null;
	const seen = new Set<string>();
	const intents = cluster.records
		.filter((r) => (seen.has(r.repo) ? false : (seen.add(r.repo), true)))
		.map((r) => ({ ...r.intent, repo: r.repo }));
	return {
		cluster: label,
		slug,
		count: forks.length,
		forks,
		intents,
		keywords: keywordsOf(cluster),
		modes_affected: [...new Set(cluster.records.flatMap((r) => r.intent.modes_affected))].sort(),
		proposedFiles: files,
		eligible,
		reason,
		summary: summary ?? `${forks.length} opted-in forks: ${intents[0]?.purpose || intents[0]?.request || label}. ${reason}`,
		draftBranch: null,
		retires: null,
		referenceFork: eligible ? reference : null,
	};
}

export const LABEL_SCHEMA = {
	type: "object",
	properties: { label: { type: "string" }, summary: { type: "string" } },
	required: ["label", "summary"],
} as const;

export function labelPrompt(cluster: Cluster): string {
	const sample = cluster.records.slice(0, 6).map((r) => `- "${r.intent.request}" (purpose: ${r.intent.purpose}; files: ${r.intent.files.join(", ")})`);
	return `These build-time intent records from ${forksIn(cluster).length} forks of a clinical assistant describe similar customizations. Give a short feature label (at most 6 words, no punctuation at the end) and a one-sentence summary of the common need.\n${sample.join("\n")}`;
}

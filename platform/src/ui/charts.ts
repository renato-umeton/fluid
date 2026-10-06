// Chart data for the fork-owned UI tabs (ui/preferences.json). Computed by the
// platform over the session user's own data: run-time ledger records, the
// fork's build-time intent records, and its gate history. Plain aggregates
// only; the browser draws them.
import type { LedgerEntry } from "../durable/user-ledger.ts";
import type { BuildTimeIntent } from "../forks/provision.ts";
import type { GateResult, TierName } from "../gate/tiers.ts";

export const INTENTS = ["clinical", "research", "administrative", "multi"] as const;
export type IntentKey = (typeof INTENTS)[number];
type Counts = Record<IntentKey, number>;

export const CHART_LIMITS = { days: 14, bins: 10, sourceKinds: 8, timeline: 20, gates: 20, ledger: 500 };

export interface ChartData {
	repo: string;
	generatedAt: string;
	answers: number;
	answersByIntent: ({ day: string } & Counts)[];
	confidence: ({ from: number; to: number } & Counts)[];
	overrides: { total: number; overridden: number; byIntent: Record<IntentKey, { total: number; overridden: number }> };
	sourcesByKind: { kind: string; count: number }[];
	intentTimeline: { id: string; at: string | null; agent: string; request: string; files: number }[];
	gateHistory: { at: string; ref: string; commit: string; passed: boolean; tiers: Partial<Record<TierName, { passed: number; total: number }>> }[];
}

function zero(): Counts {
	return { clinical: 0, research: 0, administrative: 0, multi: 0 };
}

function intentOf(value: unknown): IntentKey | null {
	return (INTENTS as readonly unknown[]).includes(value) ? (value as IntentKey) : null;
}

/** Date of a build-time record: created_at or at when present, else the date in an int_YYYY_MM_DD_n id. */
export function intentDate(record: BuildTimeIntent): string | null {
	for (const key of ["created_at", "at"]) {
		const v = record[key];
		if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
	}
	const m = /^int_(\d{4})_(\d{2})_(\d{2})_/.exec(record.id ?? "");
	return m ? `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z` : null;
}

/** The question an answer belongs to: re-asks (override, attestation) name their first answer in reask_of. */
export function questionId(record: LedgerEntry["record"]): string {
	return typeof record.reask_of === "string" && record.reask_of !== "" ? record.reask_of : record.answer_id;
}

/**
 * One group per user question. `first` is the question's first answer, or its oldest
 * re-ask when the first answer is outside the window. Entries arrive newest first.
 */
function groupByQuestion(entries: LedgerEntry[]): { first: LedgerEntry; entries: LedgerEntry[] }[] {
	const groups = new Map<string, LedgerEntry[]>();
	for (const entry of entries) {
		const id = questionId(entry.record);
		if (!groups.has(id)) groups.set(id, []);
		groups.get(id)!.push(entry);
	}
	return [...groups.entries()].map(([id, group]) => ({ first: group.find((e) => e.record.answer_id === id) ?? group[group.length - 1]!, entries: group }));
}

export function aggregateCharts(input: { repo: string; ledger: LedgerEntry[]; intents: BuildTimeIntent[]; gates: GateResult[]; now?: Date }): ChartData {
	const now = input.now ?? new Date();
	const entries = input.ledger.filter((e) => e.repo === input.repo).slice(0, CHART_LIMITS.ledger);

	const days = new Map<string, Counts>();
	const confidence = Array.from({ length: CHART_LIMITS.bins }, (_, i) => ({ from: i / CHART_LIMITS.bins, to: (i + 1) / CHART_LIMITS.bins, ...zero() }));
	const byIntent = Object.fromEntries(INTENTS.map((k) => [k, { total: 0, overridden: 0 }])) as ChartData["overrides"]["byIntent"];
	const kinds = new Map<string, number>();
	let overridden = 0;
	let answers = 0;
	for (const question of groupByQuestion(entries)) {
		const first = question.first;
		const intent = intentOf(first.record.intent);
		if (!intent) continue;
		answers++;
		const day = String(first.at).slice(0, 10);
		if (!days.has(day)) days.set(day, zero());
		days.get(day)![intent]++;
		const c = Number(first.record.confidence);
		if (Number.isFinite(c)) confidence[Math.min(CHART_LIMITS.bins - 1, Math.max(0, Math.floor(c * CHART_LIMITS.bins)))]![intent]++;
		byIntent[intent].total++;
		// Only the first answer's override marks the question: a re-ask carries its explicit mode in
		// `override` too, and an attestation re-ask is not an override at all.
		if (first.record.override && first.record.reask_of === undefined) {
			byIntent[intent].overridden++;
			overridden++;
		}
		const sources = new Set(question.entries.flatMap((e) => (Array.isArray(e.record.sources) ? e.record.sources.map(String) : [])));
		for (const source of sources) {
			const kind = source.split(":")[0] || "other";
			kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
		}
	}

	const sortedKinds = [...kinds.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const sourcesByKind = sortedKinds.slice(0, CHART_LIMITS.sourceKinds - 1).map(([kind, count]) => ({ kind, count }));
	const rest = sortedKinds.slice(CHART_LIMITS.sourceKinds - 1);
	if (rest.length === 1) sourcesByKind.push({ kind: rest[0]![0], count: rest[0]![1] });
	else if (rest.length > 1) sourcesByKind.push({ kind: "other", count: rest.reduce((n, [, c]) => n + c, 0) });

	const intentTimeline = input.intents
		.map((r) => ({ id: String(r.id), at: intentDate(r), agent: r.agent ?? "mothership", request: String(r.request ?? "").slice(0, 120), files: Array.isArray(r.files) ? r.files.length : 0 }))
		.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")) || a.id.localeCompare(b.id))
		.slice(-CHART_LIMITS.timeline);

	const gateHistory = input.gates
		.slice(0, CHART_LIMITS.gates)
		.map((g) => ({
			at: g.at,
			ref: g.ref,
			commit: g.commit,
			passed: g.passed,
			tiers: Object.fromEntries(
				(["invariant", "functional", "user"] as const).filter((t) => g.tiers?.[t]).map((t) => [t, { passed: g.tiers[t]!.total - g.tiers[t]!.failed, total: g.tiers[t]!.total }]),
			),
		}))
		.reverse();

	return {
		repo: input.repo,
		generatedAt: now.toISOString(),
		answers,
		answersByIntent: [...days.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-CHART_LIMITS.days).map(([day, counts]) => ({ day, ...counts })),
		confidence,
		overrides: { total: answers, overridden, byIntent },
		sourcesByKind,
		intentTimeline,
		gateHistory,
	};
}

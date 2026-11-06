// The gate's equivalence check: with GateInput.morph, every probe request goes
// to the plain fork and to its renamed copy, the runner sees the copy's
// answers, and any difference fails tier 1 as "polymorph-equivalence".
// Gates run through the platform's own code on in-memory repos and a fake
// Worker Loader, so each one boots isolates; the timeouts leave room for a
// loaded machine.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runGate, runGateObserved } from "../src/gate/run.ts";
import { deriveSeed, fingerprint, namesHash } from "../src/polymorph/names.ts";
import { BUILD_CARD, LISTED, POLYMORPH_TEST_SECRET, PUBLISHED, REFLECTIVE, patched, polymorphPlatform, type PolymorphPlatform } from "./helpers/polymorph-platform.ts";

const SLOW_MS = 120_000;
const RENAMED = /\$[0-9a-z]{8}/;

// Throws an error naming the decision's keys, several of them listed names, for one question its own test asks.
const WHICH = "Which decision fields are set?";
const throwing = {
	...patched("app/index.ts", BUILD_CARD, `  if (request.question === ${JSON.stringify(WHICH)}) throw new Error("decision fields: " + Object.keys(decision).join(", "));\n${BUILD_CARD}`),
	"tests/user/manifest.json": JSON.stringify({ probes: [{ id: "which-fields", request: { question: WHICH, context: {} }, assert: [{ path: "mode", exists: true }] }] }),
};
// Throws only when renamed: the plain fork has the flag it looks up by computed key, a copy does not.
const strict = patched(
	"app/index.ts",
	BUILD_CARD,
	`  if (!(["research", "NeedsAttestation"].join("") in decision)) throw new Error("the decision has no attestation flag");\n${BUILD_CARD}`,
);

let p: PolymorphPlatform;

beforeAll(() => {
	p = polymorphPlatform({ "user-1": PUBLISHED, "user-reflective": REFLECTIVE, "user-throwing": throwing, "user-strict": strict, "user-observed": PUBLISHED });
});

afterAll(() => {
	p?.cleanup();
	vi.restoreAllMocks();
});

const gateOf = (repo: string, morph?: { epoch: number }) => runGate(p.deps, { repo, ref: "main", mode: "check", samples: 1, ...(morph ? { morph } : {}) });
const equivalenceFailures = (gate: Awaited<ReturnType<typeof gateOf>>) => gate.failures.filter((failure) => failure.probe === "polymorph-equivalence");

describe("runGate with a renamed copy", () => {
	it(
		"passes the stock fork, having compared every probe request with no difference",
		async () => {
			const gate = await gateOf("user-1", { epoch: 1 });
			const print = await fingerprint(await deriveSeed(POLYMORPH_TEST_SECRET, "user-1", p.heads["user-1"]!, 1));
			expect(gate.failures).toEqual([]);
			expect(gate.passed).toBe(true);
			expect(gate.polymorph).toEqual({ epoch: 1, fingerprint: print, namesHash: await namesHash(LISTED), compared: expect.any(Number), mismatches: 0, skipped: [] });
			const compared = gate.polymorph!.compared;
			expect(compared).toBeGreaterThan(0);
			expect(gate.tiers.invariant!.probes).toContainEqual({ id: "polymorph-equivalence", passed: true, samples: compared, passedSamples: compared });
			// The copy ran in the gate's own variant, next to the plain fork's.
			expect(p.loader.built).toContainEqual(expect.stringMatching(new RegExp(`^user-1:${p.heads["user-1"]}:gate-[0-9a-f]{8}:m${print}$`)));
			expect(p.loader.built).toContainEqual(expect.stringMatching(new RegExp(`^user-1:${p.heads["user-1"]}:gate-[0-9a-f]{8}$`)));
		},
		SLOW_MS,
	);

	it(
		"refuses a fork that behaves differently once renamed, recording each difference as a tier 1 failure",
		async () => {
			const plain = await gateOf("user-reflective");
			expect(plain.passed).toBe(true);
			const gate = await gateOf("user-reflective", { epoch: 1 });
			expect(gate.passed).toBe(false);
			expect(gate.polymorph!.mismatches).toBeGreaterThan(0);
			expect(gate.polymorph!.mismatches).toBeLessThan(gate.polymorph!.compared);
			const found = equivalenceFailures(gate);
			expect(found).toHaveLength(10);
			expect(found[0]).toMatchObject({ tier: "invariant", op: "equals", sample: 1, samples: 1 });
			expect(found[0]!.description).toMatch(/renamed copy [0-9a-f]{8} answered ".+" differently from the plain fork/);
			expect(found.at(-1)!.description).toMatch(/ \d+ more differences? (is|are) not shown\.$/);
			// The equivalence failures come first; the suites' own failures on the copy's answers follow.
			expect(gate.failures.slice(0, found.length)).toEqual(found);
			expect(gate.tiers.invariant!.probes).toContainEqual(expect.objectContaining({ id: "polymorph-equivalence", passed: false }));
			expect(JSON.stringify(gate)).not.toMatch(RENAMED);
		},
		SLOW_MS,
	);

	it(
		"compares errors by their message with the copy's names mapped back, so equal errors are no difference",
		async () => {
			const gate = await gateOf("user-throwing", { epoch: 1 });
			expect(gate.polymorph).toMatchObject({ mismatches: 0 });
			expect(equivalenceFailures(gate)).toEqual([]);
			// The fork's own test fails on the error, which names the original properties.
			const failure = gate.failures.find((entry) => entry.probe === "which-fields")!;
			expect(failure.actual).toMatch(/^decision fields: .*researchNeedsAttestation/);
			expect(JSON.stringify(gate)).not.toMatch(RENAMED);
		},
		SLOW_MS,
	);

	it(
		"counts a card from one side and an error from the other as a difference",
		async () => {
			const gate = await gateOf("user-strict", { epoch: 1 });
			expect(gate.passed).toBe(false);
			expect(gate.polymorph!.mismatches).toBeGreaterThan(0);
			const first = equivalenceFailures(gate)[0]!;
			expect(first.path).toBe("");
			expect(first.actual).toBe("threw: the decision has no attestation flag");
			expect(JSON.stringify(first.expected)).toContain("answer_id");
		},
		SLOW_MS,
	);

	it(
		"runs as today and reports no copy when the platform cannot make one",
		async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const gate = await runGate(p.withoutSecret(), { repo: "user-1", ref: "main", mode: "check", samples: 1, morph: { epoch: 1 } });
			expect(gate.passed).toBe(true);
			expect(gate.polymorph).toBeNull();
			expect(gate.tiers.invariant!.probes.map((probe) => probe.id)).not.toContain("polymorph-equivalence");
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^polymorph: user-1@[0-9a-f]{7} runs plain: POLYMORPH_SECRET is not set$/));
			warn.mockRestore();
		},
		SLOW_MS,
	);

	it(
		"leaves a gate that asks for no copy exactly as it was",
		async () => {
			const gate = await gateOf("user-1");
			expect(gate.passed).toBe(true);
			expect("polymorph" in gate).toBe(false);
			expect(gate.tiers.invariant!.probes.map((probe) => probe.id)).not.toContain("polymorph-equivalence");
		},
		SLOW_MS,
	);

	it(
		"still records the cards a contest observes, as the copy answered them",
		async () => {
			const { gate, observations } = await runGateObserved(p.deps, { repo: "user-observed", ref: "main", mode: "check", samples: 1, morph: { epoch: 1 } }, { extraProbes: [], wishKeys: new Map() });
			expect(gate.passed).toBe(true);
			expect(gate.polymorph).toMatchObject({ mismatches: 0 });
			expect(observations.length).toBeGreaterThan(0);
			expect(JSON.stringify(observations)).not.toMatch(RENAMED);
		},
		SLOW_MS,
	);
});

import { describe, expect, it } from "vitest";
// @ts-expect-error plain ES module from the static UI
import { afterRotationLine, equivalenceLine, introLines, outcomeLine, parseDemo, replaySteps, scoreRows, tileStates, validateDemo } from "../public/js/polymorph-replay.js";

type Tile = { state: string; fingerprint: string | null; note: string };
type Step = { at: number; repo: string; tile: Tile };

const ALL = ["user-01", "user-02", "user-03"];

/** A small recording in the shape the end-to-end test writes: 3 forks, the four attacks, and the leaked copy after its fork moved. */
function demo() {
	return {
		version: 1,
		recordedAt: "2026-11-06T18:30:00.000Z",
		release: "v1.15.0-zero-day",
		listSize: 31,
		probes: 71,
		forks: [
			{ repo: "user-01", before: "0a1b2c3d", after: "4e5f6a7b", epochBefore: 1, epochAfter: 2, mismatches: 0 },
			{ repo: "user-02", before: "8c9d0e1f", after: "2a3b4c5d", epochBefore: 1, epochAfter: 2, mismatches: 0 },
			{ repo: "user-03", before: "6e7f8091", after: "a2b3c4d5", epochBefore: 3, epochAfter: 4, mismatches: 0 },
		],
		attacks: [
			{
				id: "A", label: "Built from upstream's source", detail: "Sets display.researchNeedsAttestation to false, the name in upstream's source.", tries: 3, targets: [...ALL],
				plain: { compromised: [...ALL] }, direct: { compromised: [] as string[] }, platform: { compromised: [] as string[], refused: [...ALL], rotated: [...ALL] },
			},
			{
				id: "A2", label: "Built from a leaked copy", detail: "Sends the same key with the renamed name from user-02's copy.", tries: 3, targets: [...ALL],
				plain: { compromised: [] as string[] }, direct: { compromised: ["user-02"] }, platform: { compromised: ["user-02"], refused: ["user-01", "user-03"], rotated: ["user-01", "user-03"] },
			},
			{
				id: "A3", label: "Blind guessing", detail: "Sends 1000 random suffixes for the renamed name to one fork.", tries: 1000, targets: ["user-03"],
				plain: { compromised: [] as string[] }, direct: { compromised: [] as string[] }, platform: { compromised: [] as string[], refused: ["user-03"], rotated: ["user-03"] },
			},
			{
				id: "B", label: "Public field only", detail: "Sets display.preview to true, a public field that skips the attestation hold.", tries: 3, targets: [...ALL],
				plain: { compromised: [...ALL] }, direct: { compromised: [...ALL] }, platform: { compromised: [...ALL], refused: [] as string[], rotated: [] as string[] },
			},
		],
		afterRotation: { attack: "A2", compromised: [] as string[], refused: ["user-02"] },
	};
}

/** A fresh recording with one change made by `edit`. */
function changed(edit: (d: ReturnType<typeof demo>) => unknown) {
	const copy = demo();
	edit(copy);
	return copy;
}

const tile = (state: string, fingerprint: string | null, note: string): Tile => ({ state, fingerprint, note });

describe("validateDemo", () => {
	it("accepts a recording in the documented shape", () => {
		expect(validateDemo(demo())).toEqual([]);
	});

	it("accepts a recording without afterRotation", () => {
		expect(validateDemo(changed((d) => Reflect.deleteProperty(d, "afterRotation")))).toEqual([]);
	});

	it("rejects anything that is not an object", () => {
		for (const value of [null, [], "run", 3]) expect(validateDemo(value)).toEqual(["the recording must be a JSON object"]);
	});

	it("names each missing field", () => {
		expect(validateDemo(changed((d) => Reflect.deleteProperty(d, "release")))).toEqual(["release must be a non-empty string"]);
		expect(validateDemo(changed((d) => Reflect.deleteProperty(d, "forks")))).toEqual(["forks must be a non-empty list"]);
		expect(validateDemo(changed((d) => Reflect.deleteProperty(d, "attacks")))).toEqual(["attacks must be a non-empty list"]);
		expect(validateDemo(changed((d) => Reflect.deleteProperty(d.attacks[0], "platform")))).toEqual(["attacks[0].platform must be an object"]);
		expect(validateDemo(changed((d) => Reflect.deleteProperty(d.attacks[1].platform, "rotated")))).toEqual(["attacks[1].platform.rotated must be a list of repo names"]);
		expect(validateDemo(changed((d) => Reflect.deleteProperty(d.forks[2], "mismatches")))).toEqual(["forks[2].mismatches must be a whole number of 0 or more"]);
	});

	it("rejects wrong types", () => {
		expect(validateDemo(changed((d) => Object.assign(d, { version: 2 })))).toEqual(["version must be 1"]);
		expect(validateDemo(changed((d) => Object.assign(d, { recordedAt: "yesterday" })))).toEqual(["recordedAt must be an ISO time"]);
		expect(validateDemo(changed((d) => Object.assign(d, { probes: "71" })))).toEqual(["probes must be a whole number of 0 or more"]);
		expect(validateDemo(changed((d) => Object.assign(d, { listSize: 2.5 })))).toEqual(["listSize must be a whole number of 0 or more"]);
		expect(validateDemo(changed((d) => Object.assign(d.forks[0], { before: "0A1B2C3D" })))).toEqual(["forks[0].before must be 8 lowercase hex characters"]);
		expect(validateDemo(changed((d) => Object.assign(d.forks[1], { after: "4e5f6a7" })))).toEqual(["forks[1].after must be 8 lowercase hex characters"]);
		expect(validateDemo(changed((d) => Object.assign(d.attacks[2], { tries: -1 })))).toEqual(["attacks[2].tries must be a whole number of 0 or more"]);
		expect(validateDemo(changed((d) => Object.assign(d.attacks[0], { targets: "user-01" })))).toEqual(["attacks[0].targets must be a list of repo names"]);
		expect(validateDemo(changed((d) => Object.assign(d.attacks[3], { label: "" })))).toEqual(["attacks[3].label must be a non-empty string"]);
		expect(validateDemo(changed((d) => Object.assign(d, { afterRotation: "A2" })))).toEqual(["afterRotation must be an object"]);
	});

	it("rejects attack ids it does not know", () => {
		expect(validateDemo(changed((d) => Object.assign(d.attacks[0], { id: "C" })))).toEqual(['attacks[0].id must be one of A, A2, A3, B, not "C"']);
		expect(validateDemo(changed((d) => Object.assign(d.attacks[1], { id: "A" })))).toEqual(['attacks[1].id "A" appears twice', "afterRotation.attack names A2, which is not in attacks"]);
		expect(validateDemo(changed((d) => Object.assign(d.afterRotation, { attack: "A9" })))).toEqual(['afterRotation.attack must be "A2"']);
	});

	it("rejects repos in attack lists that are not in forks", () => {
		expect(validateDemo(changed((d) => d.attacks[2].platform.refused.push("user-99")))).toEqual(['attacks[2].platform.refused names "user-99", which is not in forks']);
		expect(validateDemo(changed((d) => d.attacks[0].targets.push("user-42")))).toEqual(['attacks[0].targets names "user-42", which is not in forks']);
		expect(validateDemo(changed((d) => d.attacks[3].direct.compromised.push("upstream")))).toEqual(['attacks[3].direct.compromised names "upstream", which is not in forks']);
		expect(validateDemo(changed((d) => d.afterRotation.refused.push("user-7")))).toEqual(['afterRotation.refused names "user-7", which is not in forks']);
	});

	it("rejects a fork listed twice", () => {
		expect(validateDemo(changed((d) => Object.assign(d.forks[2], { repo: "user-01" })))).toContain('forks[2].repo "user-01" appears twice');
	});
});

describe("parseDemo", () => {
	it("reads a valid recording", () => {
		expect(parseDemo(JSON.stringify(demo()))).toEqual({ demo: demo(), problems: [] });
	});

	it("has no recording when the file is not JSON, such as a page served in its place", () => {
		const out = parseDemo("<!doctype html><title>Fluid</title>");
		expect(out.demo).toBeNull();
		expect(out.problems).toHaveLength(1);
		expect(out.problems[0]).toMatch(/^the file is not JSON/);
	});

	it("has no recording when the JSON has the wrong shape", () => {
		expect(parseDemo(JSON.stringify({ version: 1 })).demo).toBeNull();
	});
});

describe("tileStates", () => {
	it("starts every tile neutral, with its first copy when the switch is on and plain code when it is off", () => {
		expect(tileStates(demo(), null, true)).toEqual({ "user-01": tile("neutral", "0a1b2c3d", ""), "user-02": tile("neutral", "8c9d0e1f", ""), "user-03": tile("neutral", "6e7f8091", "") });
		expect(tileStates(demo(), null, false)).toEqual({ "user-01": tile("neutral", null, ""), "user-02": tile("neutral", null, ""), "user-03": tile("neutral", null, "") });
	});

	it("attack A: compromises the plain fleet; with the switch on every fork refuses it and moves to a new copy", () => {
		expect(tileStates(demo(), "A", false)).toEqual({ "user-01": tile("compromised", null, "compromised"), "user-02": tile("compromised", null, "compromised"), "user-03": tile("compromised", null, "compromised") });
		expect(tileStates(demo(), "A", true)).toEqual({ "user-01": tile("refused", "4e5f6a7b", "refused, new copy"), "user-02": tile("refused", "2a3b4c5d", "refused, new copy"), "user-03": tile("refused", "a2b3c4d5", "refused, new copy") });
	});

	it("attack A2: does nothing on the plain fleet; with the switch on only the leaked copy's fork is compromised", () => {
		expect(tileStates(demo(), "A2", false)).toEqual({ "user-01": tile("neutral", null, "not compromised"), "user-02": tile("neutral", null, "not compromised"), "user-03": tile("neutral", null, "not compromised") });
		expect(tileStates(demo(), "A2", true)).toEqual({ "user-01": tile("refused", "4e5f6a7b", "refused, new copy"), "user-02": tile("compromised", "8c9d0e1f", "compromised"), "user-03": tile("refused", "a2b3c4d5", "refused, new copy") });
	});

	it("attack A3: leaves forks it did not attack neutral", () => {
		expect(tileStates(demo(), "A3", false)).toEqual({ "user-01": tile("neutral", null, "not attacked"), "user-02": tile("neutral", null, "not attacked"), "user-03": tile("neutral", null, "not compromised") });
		expect(tileStates(demo(), "A3", true)).toEqual({ "user-01": tile("neutral", "0a1b2c3d", "not attacked"), "user-02": tile("neutral", "8c9d0e1f", "not attacked"), "user-03": tile("refused", "a2b3c4d5", "refused, new copy") });
	});

	it("attack B: compromises every fork with the switch on or off", () => {
		expect(tileStates(demo(), "B", false)).toEqual({ "user-01": tile("compromised", null, "compromised"), "user-02": tile("compromised", null, "compromised"), "user-03": tile("compromised", null, "compromised") });
		expect(tileStates(demo(), "B", true)).toEqual({ "user-01": tile("compromised", "0a1b2c3d", "compromised"), "user-02": tile("compromised", "8c9d0e1f", "compromised"), "user-03": tile("compromised", "6e7f8091", "compromised") });
	});

	it("refuses an attack the recording does not have", () => {
		expect(() => tileStates(demo(), "C", true)).toThrow('the recording has no attack "C"');
	});
});

describe("replaySteps", () => {
	const cases = demo().attacks.flatMap((a) => [[a.id, true], [a.id, false]] as [string, boolean][]);

	it.each(cases)("attack %s, switch on: %s, ends on the tile states", (id, on) => {
		const tiles: Record<string, Tile> = tileStates(demo(), null, on);
		for (const step of replaySteps(demo(), id, on) as Step[]) tiles[step.repo] = step.tile;
		expect(tiles).toEqual(tileStates(demo(), id, on));
	});

	it.each(cases)("attack %s, switch on: %s, plays in order within about two seconds", (id, on) => {
		const times = (replaySteps(demo(), id, on) as Step[]).map((s) => s.at);
		expect(times).toEqual([...times].sort((a, b) => a - b));
		expect(Math.min(...times)).toBe(0);
		expect(Math.max(...times)).toBeGreaterThanOrEqual(1000);
		expect(Math.max(...times)).toBeLessThanOrEqual(2500);
	});

	it("shows a refused fork on its old copy first, then on its new copy", () => {
		const steps = (replaySteps(demo(), "A3", true) as Step[]).filter((s) => s.repo === "user-03");
		expect(steps.map((s) => s.tile)).toEqual([tile("refused", "6e7f8091", "refused"), tile("refused", "a2b3c4d5", "refused, new copy")]);
	});

	it("moves no fork to a new copy with the switch off", () => {
		const steps = replaySteps(demo(), "A", false) as Step[];
		expect(steps.map((s) => s.repo)).toEqual(ALL);
		expect(steps.every((s) => s.tile.fingerprint === null)).toBe(true);
	});
});

describe("scoreRows", () => {
	it("counts each attack's forks out of the fleet, in the recording's order", () => {
		expect(scoreRows(demo())).toEqual([
			{ id: "A", label: "Built from upstream's source", detail: "Sets display.researchNeedsAttestation to false, the name in upstream's source.", sent: "3 requests to 3 forks", plain: "3 of 3", direct: "0 of 3", compromised: "0 of 3", refused: "3 of 3", rotated: "3 of 3" },
			{ id: "A2", label: "Built from a leaked copy", detail: "Sends the same key with the renamed name from user-02's copy.", sent: "3 requests to 3 forks", plain: "0 of 3", direct: "1 of 3", compromised: "1 of 3", refused: "2 of 3", rotated: "2 of 3" },
			{ id: "A3", label: "Blind guessing", detail: "Sends 1000 random suffixes for the renamed name to one fork.", sent: "1000 requests to 1 fork", plain: "0 of 3", direct: "0 of 3", compromised: "0 of 3", refused: "1 of 3", rotated: "1 of 3" },
			{ id: "B", label: "Public field only", detail: "Sets display.preview to true, a public field that skips the attestation hold.", sent: "3 requests to 3 forks", plain: "3 of 3", direct: "3 of 3", compromised: "3 of 3", refused: "0 of 3", rotated: "0 of 3" },
		]);
	});
});

describe("the lines around the fleet and the scoreboard", () => {
	it("says what polymorphic installation does, that this is a recorded run, and its limit", () => {
		const [what, replay, limit] = introLines(demo());
		expect(what).toContain("the 31 internal names on upstream's list");
		expect(what).toContain("A request that uses an original name is refused, and that fork moves to a new copy.");
		expect(replay).toBe("This page replays a recorded run of the end-to-end test: 3 forks on release v1.15.0-zero-day, recorded 2026-11-06 at 18:30 UTC.");
		expect(limit).toBe("Renaming cannot stop a bug that public fields alone can reach, as attack B shows.");
	});

	it("states the limit without pointing at attack B when the recording has none", () => {
		const noB = changed((d) => d.attacks.pop());
		expect(introLines(noB)[2]).toBe("Renaming cannot stop a bug that public fields alone can reach.");
	});

	it("sums up an attack after it plays, with the switch on or off", () => {
		expect(outcomeLine(demo(), "A", false)).toBe("Attack A (Built from upstream's source) with polymorphic installation off: 3 of 3 forks compromised.");
		expect(outcomeLine(demo(), "A2", true)).toBe("Attack A2 (Built from a leaked copy) with polymorphic installation on: 1 of 3 forks compromised, 2 refused, 2 moved to a new copy.");
	});

	it("says what the leaked names did after their fork moved to a new copy", () => {
		expect(afterRotationLine(demo())).toBe("After the leaked copy's fork moved to a new copy, the leaked names compromised 0 forks and were refused on 1.");
		expect(afterRotationLine(changed((d) => Reflect.deleteProperty(d, "afterRotation")))).toBeNull();
	});

	it("counts the copies that answered every probe like the plain fork", () => {
		expect(equivalenceLine(demo())).toBe("Equivalence check: every copy answered all 71 probes like the plain fork (3 of 3 copies had 0 differences).");
		const two = changed((d) => { Object.assign(d.forks[0], { mismatches: 2 }); Object.assign(d.forks[2], { mismatches: 1 }); });
		expect(equivalenceLine(two)).toBe("Equivalence check: 1 of 3 copies answered all 71 probes like the plain fork with 0 differences. Copies with differences: user-01 (2), user-03 (1).");
	});
});

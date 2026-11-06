import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ES module from the static UI
import { afterRotationLine, equivalenceLine, introLines, outcomeLine, parseDemo, replaySteps, scoreRows, tileStates, validateDemo } from "../public/js/polymorph-replay.js";
// @ts-expect-error plain ES module from the static UI
import * as view from "../public/js/views/polymorph.js";

type Tile = { state: string; fingerprint: string | null; note: string };
type Step = { at: number; repo: string; tile: Tile };

const ALL = ["user-01", "user-02", "user-03"];

/**
 * A small recording in the shape the end-to-end test writes: 3 forks, the four attacks, and the leaked copy after its fork moved.
 * Attack A refuses user-03 without moving it to a new copy, and attack A2 moves user-03 without refusing it, so the tests tell
 * the refused and rotated lists apart.
 */
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
				plain: { compromised: [...ALL] }, direct: { compromised: [] as string[] }, platform: { compromised: [] as string[], refused: [...ALL], rotated: ["user-01", "user-02"] },
			},
			{
				id: "A2", label: "Built from a leaked copy", detail: "Sends the same key with the renamed name from user-02's copy.", tries: 3, targets: [...ALL],
				plain: { compromised: [] as string[] }, direct: { compromised: ["user-02"] }, platform: { compromised: ["user-02"], refused: ["user-01"], rotated: ["user-01", "user-03"] },
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

/** One change to a recording, made in place. */
type Edit = (d: ReturnType<typeof demo>) => unknown;

/** A fresh recording with one change made by `edit`. */
function changed(edit: Edit) {
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

	it.each([null, [], "run", 3])("rejects %j, which is not an object", (value) => {
		expect(validateDemo(value)).toEqual(["the recording must be a JSON object"]);
	});

	it.each<[string, Edit, string]>([
		["release", (d) => Reflect.deleteProperty(d, "release"), "release must be a non-empty string"],
		["forks", (d) => Reflect.deleteProperty(d, "forks"), "forks must be a non-empty list"],
		["attacks", (d) => Reflect.deleteProperty(d, "attacks"), "attacks must be a non-empty list"],
		["attacks[0].platform", (d) => Reflect.deleteProperty(d.attacks[0], "platform"), "attacks[0].platform must be an object"],
		["attacks[1].platform.rotated", (d) => Reflect.deleteProperty(d.attacks[1].platform, "rotated"), "attacks[1].platform.rotated must be a list of repo names"],
		["forks[2].mismatches", (d) => Reflect.deleteProperty(d.forks[2], "mismatches"), "forks[2].mismatches must be a whole number of 0 or more"],
	])("names the missing field %s", (_field, edit, problem) => {
		expect(validateDemo(changed(edit))).toEqual([problem]);
	});

	it.each<[string, Edit, string[]]>([
		["version 2", (d) => Object.assign(d, { version: 2 }), ["version must be 1"]],
		["probes written as text", (d) => Object.assign(d, { probes: "71" }), ["probes must be a whole number of 0 or more"]],
		["a listSize that is not whole", (d) => Object.assign(d, { listSize: 2.5 }), ["listSize must be a whole number of 0 or more"]],
		["an uppercase fingerprint", (d) => Object.assign(d.forks[0], { before: "0A1B2C3D" }), ["forks[0].before must be 8 lowercase hex characters"]],
		["a short fingerprint", (d) => Object.assign(d.forks[1], { after: "4e5f6a7" }), ["forks[1].after must be 8 lowercase hex characters"]],
		["negative tries", (d) => Object.assign(d.attacks[2], { tries: -1 }), ["attacks[2].tries must be a whole number of 0 or more"]],
		["targets that are not a list", (d) => Object.assign(d.attacks[0], { targets: "user-01" }), ["attacks[0].targets must be a list of repo names"]],
		["an empty label", (d) => Object.assign(d.attacks[3], { label: "" }), ["attacks[3].label must be a non-empty string"]],
		["an afterRotation that is not an object", (d) => Object.assign(d, { afterRotation: "A2" }), ["afterRotation must be an object"]],
		["an attack id it does not know", (d) => Object.assign(d.attacks[0], { id: "C" }), ['attacks[0].id must be one of A, A2, A3, B, not "C"']],
		["an attack id used twice", (d) => Object.assign(d.attacks[1], { id: "A" }), ['attacks[1].id "A" appears twice', "afterRotation.attack names A2, which is not in attacks"]],
		["an afterRotation for another attack", (d) => Object.assign(d.afterRotation, { attack: "A9" }), ['afterRotation.attack must be "A2"']],
		["a target that is not in forks", (d) => d.attacks[0].targets.push("user-42"), ['attacks[0].targets names "user-42", which is not in forks']],
		["an outcome for a fork that is not in forks", (d) => d.attacks[2].platform.refused.push("user-99"), ['attacks[2].platform.refused names "user-99", which is not in forks']],
		["a bypassed-scan outcome for a fork that is not in forks", (d) => d.attacks[3].direct.compromised.push("upstream"), ['attacks[3].direct.compromised names "upstream", which is not in forks']],
		["an afterRotation entry that is not in forks", (d) => d.afterRotation.refused.push("user-7"), ['afterRotation.refused names "user-7", which is not in forks']],
	])("rejects %s", (_what, edit, problems) => {
		expect(validateDemo(changed(edit))).toEqual(problems);
	});

	it("rejects a fork listed twice", () => {
		expect(validateDemo(changed((d) => Object.assign(d.forks[2], { repo: "user-01" })))).toContain('forks[2].repo "user-01" appears twice');
	});

	it.each<[string, Edit, string]>([
		["targets", (d) => d.attacks[0].targets.push("user-01"), 'attacks[0].targets names "user-01" more than once'],
		["plain.compromised", (d) => d.attacks[0].plain.compromised.push("user-02"), 'attacks[0].plain.compromised names "user-02" more than once'],
		["direct.compromised", (d) => d.attacks[1].direct.compromised.push("user-02"), 'attacks[1].direct.compromised names "user-02" more than once'],
		["platform.compromised", (d) => d.attacks[1].platform.compromised.push("user-02"), 'attacks[1].platform.compromised names "user-02" more than once'],
		["platform.refused", (d) => d.attacks[0].platform.refused.push("user-03"), 'attacks[0].platform.refused names "user-03" more than once'],
		["platform.rotated", (d) => d.attacks[0].platform.rotated.push("user-01"), 'attacks[0].platform.rotated names "user-01" more than once'],
		["afterRotation.compromised", (d) => d.afterRotation.compromised.push("user-01", "user-01", "user-01"), 'afterRotation.compromised names "user-01" more than once'],
		["afterRotation.refused", (d) => d.afterRotation.refused.push("user-02"), 'afterRotation.refused names "user-02" more than once'],
	])("rejects a repo named twice in %s, which would count it twice", (_list, edit, problem) => {
		expect(validateDemo(changed(edit))).toEqual([problem]);
	});

	it.each<[string, Edit, string]>([
		["plain.compromised", (d) => d.attacks[2].plain.compromised.push("user-01"), 'attacks[2].plain.compromised names "user-01", which is not in attacks[2].targets'],
		["direct.compromised", (d) => d.attacks[2].direct.compromised.push("user-01"), 'attacks[2].direct.compromised names "user-01", which is not in attacks[2].targets'],
		["platform.compromised", (d) => d.attacks[2].platform.compromised.push("user-02"), 'attacks[2].platform.compromised names "user-02", which is not in attacks[2].targets'],
		["platform.refused", (d) => d.attacks[2].platform.refused.push("user-02"), 'attacks[2].platform.refused names "user-02", which is not in attacks[2].targets'],
		["platform.rotated", (d) => d.attacks[2].platform.rotated.push("user-01"), 'attacks[2].platform.rotated names "user-01", which is not in attacks[2].targets'],
	])("rejects an outcome in %s for a fork the attack did not target", (_list, edit, problem) => {
		expect(validateDemo(changed(edit))).toEqual([problem]);
	});

	it("rejects a fork moved to a new copy whose fingerprint did not change", () => {
		expect(validateDemo(changed((d) => Object.assign(d.forks[0], { after: "0a1b2c3d" })))).toEqual([
			'attacks[0].platform.rotated names "user-01", whose after fingerprint is the same as before',
			'attacks[1].platform.rotated names "user-01", whose after fingerprint is the same as before',
		]);
	});

	it("accepts the same fingerprint before and after for a fork no attack moves", () => {
		expect(validateDemo(changed((d) => { d.attacks[0].platform.rotated = ["user-01"]; Object.assign(d.forks[1], { after: "8c9d0e1f" }); }))).toEqual([]);
	});

	it.each(["yesterday", "2026-11-06T18:30:00Z", "2026-02-30T10:00:00.000Z", "2026-11-06T18:30:00.000+05:30"])("rejects recordedAt %s, which toISOString would not write", (recordedAt) => {
		expect(validateDemo(changed((d) => Object.assign(d, { recordedAt })))).toEqual(["recordedAt must be an ISO time such as 2026-11-06T18:30:00.000Z"]);
	});

	it("accepts forks without epochs, which the page does not show", () => {
		expect(validateDemo(changed((d) => d.forks.forEach((f) => { Reflect.deleteProperty(f, "epochBefore"); Reflect.deleteProperty(f, "epochAfter"); })))).toEqual([]);
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
	it.each<[boolean, Record<string, Tile>]>([
		[true, { "user-01": tile("neutral", "0a1b2c3d", ""), "user-02": tile("neutral", "8c9d0e1f", ""), "user-03": tile("neutral", "6e7f8091", "") }],
		[false, { "user-01": tile("neutral", null, ""), "user-02": tile("neutral", null, ""), "user-03": tile("neutral", null, "") }],
	])("starts every tile neutral (switch on: %s), on its first copy, or on plain code with the switch off", (on, expected) => {
		expect(tileStates(demo(), null, on)).toEqual(expected);
	});

	it.each<[string, boolean, string, Record<string, Tile>]>([
		["A", false, "compromises the plain fleet", { "user-01": tile("compromised", null, "compromised"), "user-02": tile("compromised", null, "compromised"), "user-03": tile("compromised", null, "compromised") }],
		["A", true, "is refused everywhere, and the forks that moved show their new copy", { "user-01": tile("refused", "4e5f6a7b", "refused, new copy"), "user-02": tile("refused", "2a3b4c5d", "refused, new copy"), "user-03": tile("refused", "6e7f8091", "refused") }],
		["A2", false, "does nothing on the plain fleet", { "user-01": tile("neutral", null, "not compromised"), "user-02": tile("neutral", null, "not compromised"), "user-03": tile("neutral", null, "not compromised") }],
		["A2", true, "compromises only the leaked copy's fork", { "user-01": tile("refused", "4e5f6a7b", "refused, new copy"), "user-02": tile("compromised", "8c9d0e1f", "compromised"), "user-03": tile("neutral", "a2b3c4d5", "not compromised, new copy") }],
		["A3", false, "leaves the forks it did not attack neutral", { "user-01": tile("neutral", null, "not attacked"), "user-02": tile("neutral", null, "not attacked"), "user-03": tile("neutral", null, "not compromised") }],
		["A3", true, "is refused on the one fork it attacked", { "user-01": tile("neutral", "0a1b2c3d", "not attacked"), "user-02": tile("neutral", "8c9d0e1f", "not attacked"), "user-03": tile("refused", "a2b3c4d5", "refused, new copy") }],
		["B", false, "compromises every fork", { "user-01": tile("compromised", null, "compromised"), "user-02": tile("compromised", null, "compromised"), "user-03": tile("compromised", null, "compromised") }],
		["B", true, "compromises every fork through the platform too", { "user-01": tile("compromised", "0a1b2c3d", "compromised"), "user-02": tile("compromised", "8c9d0e1f", "compromised"), "user-03": tile("compromised", "6e7f8091", "compromised") }],
	])("attack %s, switch on: %s, %s", (id, on, _why, expected) => {
		expect(tileStates(demo(), id, on)).toEqual(expected);
	});

	it("tells a refused fork from a moved one: refused on its old copy, or moved without a refusal", () => {
		expect(tileStates(demo(), "A", true)["user-03"]).toEqual(tile("refused", "6e7f8091", "refused"));
		expect(tileStates(demo(), "A2", true)["user-03"]).toEqual(tile("neutral", "a2b3c4d5", "not compromised, new copy"));
	});

	it("shows a fork that is both compromised and refused as compromised, since the harm happened", () => {
		const both = changed((d) => d.attacks[1].platform.refused.push("user-02"));
		expect(tileStates(both, "A2", true)["user-02"]).toEqual(tile("compromised", "8c9d0e1f", "compromised"));
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

	it("moves only the forks the platform rotated to a new copy", () => {
		const moved = (id: string) => (replaySteps(demo(), id, true) as Step[]).filter((s) => s.tile.note.endsWith("new copy")).map((s) => s.repo);
		expect(moved("A")).toEqual(["user-01", "user-02"]);
		expect(moved("A2")).toEqual(["user-01", "user-03"]);
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
			{ id: "A", label: "Built from upstream's source", detail: "Sets display.researchNeedsAttestation to false, the name in upstream's source.", sent: "3 requests to 3 forks", plain: "3 of 3", direct: "0 of 3", compromised: "0 of 3", refused: "3 of 3", rotated: "2 of 3" },
			{ id: "A2", label: "Built from a leaked copy", detail: "Sends the same key with the renamed name from user-02's copy.", sent: "3 requests to 3 forks", plain: "0 of 3", direct: "1 of 3", compromised: "1 of 3", refused: "1 of 3", rotated: "2 of 3" },
			{ id: "A3", label: "Blind guessing", detail: "Sends 1000 random suffixes for the renamed name to one fork.", sent: "1000 requests to 1 fork", plain: "0 of 3", direct: "0 of 3", compromised: "0 of 3", refused: "1 of 3", rotated: "1 of 3" },
			{ id: "B", label: "Public field only", detail: "Sets display.preview to true, a public field that skips the attestation hold.", sent: "3 requests to 3 forks", plain: "3 of 3", direct: "3 of 3", compromised: "3 of 3", refused: "0 of 3", rotated: "0 of 3" },
		]);
	});
});

describe("the lines around the fleet and the scoreboard", () => {
	it("says what polymorphic installation does, that this is a recorded run, and its limit", () => {
		const [what, replay, limit] = introLines(demo());
		expect(what).toBe("Polymorphic installation renames the 31 internal names on upstream's list with a secret seed for each fork.");
		expect(replay).toBe("This page replays a recorded run of the end-to-end test: 3 forks on release v1.15.0-zero-day, recorded 2026-11-06 at 18:30 UTC.");
		expect(limit).toBe("Renaming cannot stop a bug that public fields alone can reach, as attack B shows.");
	});

	it("states the limit without pointing at attack B when the recording has none", () => {
		const noB = changed((d) => d.attacks.pop());
		expect(introLines(noB)[2]).toBe("Renaming cannot stop a bug that public fields alone can reach.");
	});

	it("sums up an attack after it plays, with the switch on or off", () => {
		expect(outcomeLine(demo(), "A", false)).toBe("Attack A (Built from upstream's source) with polymorphic installation off: 3 of 3 forks compromised.");
		expect(outcomeLine(demo(), "A2", true)).toBe("Attack A2 (Built from a leaked copy) with polymorphic installation on: 1 of 3 forks compromised, 1 refused, 2 moved to a new copy.");
	});

	it("says what the leaked names did after their fork moved to a new copy", () => {
		expect(afterRotationLine(demo())).toBe("After the leaked copy's fork moved to a new copy, the leaked names compromised 0 forks and were refused on 1 fork.");
		expect(afterRotationLine(changed((d) => d.afterRotation.refused.push("user-01")))).toBe("After the leaked copy's fork moved to a new copy, the leaked names compromised 0 forks and were refused on 2 forks.");
		expect(afterRotationLine(changed((d) => Reflect.deleteProperty(d, "afterRotation")))).toBeNull();
	});

	it("counts the copies that answered every probe like the plain fork", () => {
		expect(equivalenceLine(demo())).toBe("Equivalence check: every copy answered all 71 probes like the plain fork (3 of 3 copies had 0 differences).");
		const two = changed((d) => { Object.assign(d.forks[0], { mismatches: 2 }); Object.assign(d.forks[2], { mismatches: 1 }); });
		expect(equivalenceLine(two)).toBe("Equivalence check: 1 of 3 copies answered all 71 probes like the plain fork with 0 differences. Copies with differences: user-01 (2), user-03 (1).");
	});
});

describe("the Polymorph view is wired in like the others", () => {
	const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
	const app = read("../public/app.js");
	const html = read("../public/index.html");
	const views = (app.match(/const VIEWS = \{([^}]*)\}/)?.[1] ?? "").split(",").map((entry) => entry.split(":")[0].trim());

	it("is imported and registered in app.js", () => {
		expect(app).toContain('import * as polymorph from "./js/views/polymorph.js";');
		expect(views).toContain("polymorph");
	});

	it("has a Polymorph button in the rail right after Fleet", () => {
		const order = [...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
		expect(order[order.indexOf("fleet") + 1]).toBe("polymorph");
		expect(html).toMatch(/<button class="nav-btn" data-view="polymorph">.*Polymorph<\/button>/);
	});

	it("has a section for every registered view, so route() can show it", () => {
		for (const name of views) expect(html).toMatch(new RegExp(`<section class="view" id="view-${name}" aria-labelledby="view-title"( hidden)?></section>`));
		expect(html).toContain('<section class="view" id="view-polymorph" aria-labelledby="view-title" hidden></section>');
	});

	it("exports what route() calls", () => {
		expect(view.title).toBe("Polymorphic installation");
		expect(view.sub).toBe("Every fork runs its own renamed copy of upstream's code.");
		expect(typeof view.render).toBe("function");
		expect(typeof view.leave).toBe("function");
	});

	it("fills every scoreboard column from a field of scoreRows, Sent first", () => {
		const row = scoreRows(demo())[0];
		expect(view.SCORE_COLUMNS.map(([key]: [string, string]) => key)).toEqual(["sent", "plain", "direct", "compromised", "refused", "rotated"]);
		for (const [key] of view.SCORE_COLUMNS as [string, string][]) expect(row).toHaveProperty(key);
	});

	it("reads the recording from public/data, next to the page", () => {
		expect(fileURLToPath(view.DATA_URL)).toBe(fileURLToPath(new URL("../public/data/polymorph-demo.json", import.meta.url)));
	});

	it("builds text only through h(), never by assigning HTML", () => {
		for (const path of ["../public/js/views/polymorph.js", "../public/js/polymorph-replay.js"]) expect(read(path)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
	});
});

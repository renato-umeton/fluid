import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain ES module from the static UI
import { SCORE_COLUMNS, SCORE_NOTE, afterRotationLine, equivalenceLine, introLines, latestOnly, noRecordingMessage, outcomeLine, parseDemo, readRecording, replayer, replaySteps, scoreRows, tileStates, validateDemo } from "../public/js/polymorph-replay.js";
// @ts-expect-error plain ES module from the static UI
import * as view from "../public/js/views/polymorph.js";

type Tile = { state: string; fingerprint: string | null; note: string };
type Step = { at: number; repo: string; tile: Tile };

const ALL = ["user-01", "user-02", "user-03"];

/**
 * A small recording in the shape the end-to-end test writes: 3 forks, the four attacks with their request counts, and the leaked
 * copy after its fork moved. Attack A refuses user-03 without moving it to a new copy, and attack A2 moves user-03 without
 * refusing it, so the tests tell the refused and rotated lists apart.
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
				id: "A", label: "Built from upstream's source", detail: "Sets display.researchNeedsAttestation to false, the name in upstream's source.", targets: [...ALL],
				requests: { sent: 3, plainCompromised: 3, directCompromised: 0, platformCompromised: 0, refused: 3 },
				plain: { compromised: [...ALL] }, direct: { compromised: [] as string[] }, platform: { compromised: [] as string[], refused: [...ALL], rotated: ["user-01", "user-02"] },
			},
			{
				id: "A2", label: "Built from a leaked copy", detail: "Sends the same key with the renamed name from user-02's copy.", targets: [...ALL],
				requests: { sent: 3, plainCompromised: 0, directCompromised: 1, platformCompromised: 1, refused: 1 },
				plain: { compromised: [] as string[] }, direct: { compromised: ["user-02"] }, platform: { compromised: ["user-02"], refused: ["user-01"], rotated: ["user-01", "user-03"] },
			},
			{
				id: "A3", label: "Blind guessing", detail: "Sends 1000 random suffixes for the renamed name to one fork.", targets: ["user-03"],
				requests: { sent: 1000, plainCompromised: 0, directCompromised: 0, platformCompromised: 0, refused: 1000 },
				plain: { compromised: [] as string[] }, direct: { compromised: [] as string[] }, platform: { compromised: [] as string[], refused: ["user-03"], rotated: ["user-03"] },
			},
			{
				id: "B", label: "Public field only", detail: "Sets display.preview to true, a public field that skips the attestation hold.", targets: [...ALL],
				requests: { sent: 3, plainCompromised: 3, directCompromised: 3, platformCompromised: 3, refused: 0 },
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

/** Every attack in the fixture, with the switch on and off. */
const CASES = demo().attacks.flatMap((a) => [[a.id, true], [a.id, false]] as [string, boolean][]);

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
		["attacks[2].requests", (d) => Reflect.deleteProperty(d.attacks[2], "requests"), "attacks[2].requests must be an object"],
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
		["a negative count of requests sent", (d) => Object.assign(d.attacks[2].requests, { sent: -1 }), ["attacks[2].requests.sent must be a whole number of 0 or more"]],
		["targets that are not a list", (d) => Object.assign(d.attacks[0], { targets: "user-01" }), ["attacks[0].targets must be a list of repo names"]],
		["an empty label", (d) => Object.assign(d.attacks[3], { label: "" }), ["attacks[3].label must be a non-empty string"]],
		["an afterRotation that is not an object", (d) => Object.assign(d, { afterRotation: "A2" }), ["afterRotation must be an object"]],
		["an attack id it does not know", (d) => Object.assign(d.attacks[0], { id: "C" }), ['attacks[0].id must be one of A, A2, A3, B, not "C"']],
		["an attack id used twice", (d) => Object.assign(d.attacks[1], { id: "A" }), ['attacks[1].id "A" appears twice', "afterRotation.attack names A2, which is not in attacks"]],
		["an afterRotation for another attack", (d) => Object.assign(d.afterRotation, { attack: "A9" }), ['afterRotation.attack must be "A2"']],
		["a target that is not in forks", (d) => { d.attacks[0].targets.push("user-42"); d.attacks[0].requests.sent = 4; }, ['attacks[0].targets names "user-42", which is not in forks']],
		["an outcome for a fork that is not in forks", (d) => d.attacks[2].platform.refused.push("user-99"), ['attacks[2].platform.refused names "user-99", which is not in forks']],
		["a bypassed-scan outcome for a fork that is not in forks", (d) => { d.attacks[3].direct.compromised.push("upstream"); Object.assign(d.attacks[3].requests, { sent: 4, directCompromised: 4 }); }, ['attacks[3].direct.compromised names "upstream", which is not in forks']],
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
		["plain.compromised", (d) => { d.attacks[2].plain.compromised.push("user-01"); d.attacks[2].requests.plainCompromised = 1; }, 'attacks[2].plain.compromised names "user-01", which is not in attacks[2].targets'],
		["direct.compromised", (d) => { d.attacks[2].direct.compromised.push("user-01"); d.attacks[2].requests.directCompromised = 1; }, 'attacks[2].direct.compromised names "user-01", which is not in attacks[2].targets'],
		["platform.compromised", (d) => { d.attacks[2].platform.compromised.push("user-02"); d.attacks[2].requests.platformCompromised = 1; }, 'attacks[2].platform.compromised names "user-02", which is not in attacks[2].targets'],
		["platform.refused", (d) => d.attacks[2].platform.refused.push("user-02"), 'attacks[2].platform.refused names "user-02", which is not in attacks[2].targets'],
		["platform.rotated", (d) => d.attacks[2].platform.rotated.push("user-01"), 'attacks[2].platform.rotated names "user-01", which is not in attacks[2].targets'],
	])("rejects an outcome in %s for a fork the attack did not target", (_list, edit, problem) => {
		expect(validateDemo(changed(edit))).toEqual([problem]);
	});

	it.each<[string, Edit, string]>([
		["a count that is not whole", (d) => Object.assign(d.attacks[0].requests, { refused: 2.5 }), "attacks[0].requests.refused must be a whole number of 0 or more"],
		["more compromising requests than were sent", (d) => Object.assign(d.attacks[0].requests, { plainCompromised: 4 }), "attacks[0].requests.plainCompromised is 4, more than the 3 requests sent"],
		["fewer requests sent than forks attacked", (d) => Object.assign(d.attacks[1].requests, { sent: 2 }), "attacks[1].requests.sent is 2, but attacks[1].targets names 3 forks"],
		["no compromising request for a fork listed as compromised", (d) => Object.assign(d.attacks[1].requests, { directCompromised: 0 }), "attacks[1].requests.directCompromised is 0, but attacks[1].direct.compromised names 1 fork"],
		["fewer refused requests than forks that refused", (d) => Object.assign(d.attacks[0].requests, { refused: 2 }), "attacks[0].requests.refused is 2, but attacks[0].platform.refused names 3 forks"],
		["compromising requests while no fork is listed as compromised", (d) => Object.assign(d.attacks[1].requests, { plainCompromised: 1 }), "attacks[1].requests.plainCompromised is 1, but attacks[1].plain.compromised names no fork"],
	])("rejects request counts with %s", (_what, edit, problem) => {
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

describe("readRecording", () => {
	const json = { "content-type": "application/json" };
	const answer = (body: string, init: ResponseInit) => async () => new Response(body, init);

	it.each<[string, () => Promise<Response>, boolean, boolean]>([
		["a valid recording", answer(JSON.stringify(demo()), { headers: json }), true, false],
		["no file", answer("not found", { status: 404 }), false, true],
		["a page served in its place", answer("<!doctype html><title>Fluid</title>", { headers: { "content-type": "text/html; charset=utf-8" } }), false, true],
		["a file that is not JSON", answer("version = 1", { headers: json }), false, false],
		["a file of the wrong shape", answer(JSON.stringify({ version: 1 }), { headers: json }), false, false],
		["nothing, when the network fails", async () => { throw new TypeError("Failed to fetch"); }, false, true],
	])("reads %s", async (_what, fetchFn, shown, missing) => {
		const out = await readRecording(fetchFn, "data/polymorph-demo.json");
		expect({ shown: out.demo !== null, missing: out.missing, explained: out.problems.length > 0 }).toEqual({ shown, missing, explained: !shown });
	});

	it("asks for the file past any cached copy, so a new recording shows on reload", async () => {
		const calls: unknown[][] = [];
		await readRecording(async (...args: unknown[]) => { calls.push(args); return new Response(JSON.stringify(demo()), { headers: json }); }, "data/polymorph-demo.json");
		expect(calls).toEqual([["data/polymorph-demo.json", { headers: { accept: "application/json" }, cache: "no-cache" }]]);
	});

	it.each<[boolean, string]>([
		[true, "No recorded run yet. Record one with cd platform && npm run polymorph:record, then reload this page."],
		[false, "The recorded run in data/polymorph-demo.json cannot be shown (the console says why). Record it again with cd platform && npm run polymorph:record, then reload this page."],
	])("when the file is missing: %s, says %j, with the command on its own", (missing, text) => {
		const parts = noRecordingMessage(missing);
		expect(parts.join("")).toBe(text);
		expect(parts[1]).toBe("cd platform && npm run polymorph:record");
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
	it.each(CASES)("attack %s, switch on: %s, ends on the tile states", (id, on) => {
		const tiles: Record<string, Tile> = tileStates(demo(), null, on);
		for (const step of replaySteps(demo(), id, on) as Step[]) tiles[step.repo] = step.tile;
		expect(tiles).toEqual(tileStates(demo(), id, on));
	});

	it.each(CASES)("attack %s, switch on: %s, plays in order within about two seconds", (id, on) => {
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

describe("replayer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** A replayer on the fixture that records what it paints and says. */
	function recorder() {
		const painted: [string, Tile][] = [];
		const said: string[] = [];
		const replay = replayer(demo(), { paint: (repo: string, t: Tile) => { painted.push([repo, t]); }, say: (text: string) => { said.push(text); } });
		return { replay, painted, said };
	}
	/** Each repo's last painted tile. */
	const shown = (painted: [string, Tile][]) => Object.fromEntries(painted);

	it.each<[boolean, string]>([
		[true, "Polymorphic installation is on: every fork runs its own copy. Pick an attack to replay it."],
		[false, "Polymorphic installation is off: every fork runs upstream's plain code. Pick an attack to replay it."],
	])("on reset with the switch on: %s, paints the starting tiles and says %j", (on, line) => {
		const { replay, painted, said } = recorder();
		replay.reset(on);
		expect(shown(painted)).toEqual(tileStates(demo(), null, on));
		expect(said).toEqual([line]);
	});

	it.each(CASES)("plays attack %s, switch on: %s, to its end state within 2.5 seconds, then sums it up", (id, on) => {
		const { replay, painted, said } = recorder();
		replay.play(id, on);
		expect(said).toEqual([`Replaying attack ${id} with polymorphic installation ${on ? "on" : "off"}...`]);
		vi.advanceTimersByTime(2500);
		expect(shown(painted)).toEqual(tileStates(demo(), id, on));
		expect(said.at(-1)).toBe(outcomeLine(demo(), id, on));
		expect(vi.getTimerCount()).toBe(0);
	});

	it("paints nothing after stop() in the middle of a replay", () => {
		const { replay, painted } = recorder();
		replay.play("A", true);
		vi.advanceTimersByTime(800);
		const count = painted.length;
		replay.stop();
		expect(vi.getTimerCount()).toBe(0);
		vi.runAllTimers();
		expect(painted).toHaveLength(count);
	});

	it("cancels the first replay when a second one starts", () => {
		const { replay, painted, said } = recorder();
		replay.play("A", true);
		vi.advanceTimersByTime(800);
		const mark = painted.length;
		replay.play("B", true);
		vi.runAllTimers();
		const onlyB = [...Object.entries(tileStates(demo(), null, true)), ...(replaySteps(demo(), "B", true) as Step[]).map((s) => [s.repo, s.tile])];
		expect(painted.slice(mark)).toEqual(onlyB);
		expect(said.at(-1)).toBe(outcomeLine(demo(), "B", true));
	});

	it("cancels a replay on reset", () => {
		const { replay, painted, said } = recorder();
		replay.play("A3", true);
		vi.advanceTimersByTime(800);
		replay.reset(false);
		expect(vi.getTimerCount()).toBe(0);
		vi.runAllTimers();
		expect(shown(painted)).toEqual(tileStates(demo(), null, false));
		expect(said.at(-1)).toBe("Polymorphic installation is off: every fork runs upstream's plain code. Pick an attack to replay it.");
	});

	it("with reduced motion paints only the end state, at once, and sets no timer", () => {
		const { replay, painted, said } = recorder();
		replay.play("A", true, { reducedMotion: true });
		expect(painted).toEqual(Object.entries(tileStates(demo(), "A", true)));
		expect(said).toEqual([outcomeLine(demo(), "A", true)]);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("latestOnly", () => {
	/** A promise and the function that settles it. */
	function deferred<T>() {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>((r) => { resolve = r; });
		return { promise, resolve };
	}

	it("hands over only the latest of two overlapping loads, even when the older one finishes last", async () => {
		const first = deferred<string>();
		const second = deferred<string>();
		const pending = [first.promise, second.promise];
		const loads = latestOnly(() => pending.shift());
		const shown: string[] = [];
		const older = loads.start((value: string) => shown.push(value));
		const newer = loads.start((value: string) => shown.push(value));
		second.resolve("second");
		first.resolve("first");
		await Promise.all([older, newer]);
		expect(shown).toEqual(["second"]);
	});

	it("hands over nothing once stopped, as when the reader leaves the page during the load", async () => {
		const load = deferred<string>();
		const loads = latestOnly(() => load.promise);
		const shown: string[] = [];
		const started = loads.start((value: string) => shown.push(value));
		loads.stop();
		load.resolve("late");
		await started;
		expect(shown).toEqual([]);
	});
});

describe("scoreRows", () => {
	it("counts requests out of those sent, and the attacked forks moved to a new copy, in the recording's order", () => {
		expect(scoreRows(demo())).toEqual([
			{ id: "A", label: "Built from upstream's source", detail: "Sets display.researchNeedsAttestation to false, the name in upstream's source.", sent: "3 requests to 3 forks", plain: "3 of 3", direct: "0 of 3", compromised: "0 of 3", refused: "3 of 3", rotated: "2 of 3 attacked forks" },
			{ id: "A2", label: "Built from a leaked copy", detail: "Sends the same key with the renamed name from user-02's copy.", sent: "3 requests to 3 forks", plain: "0 of 3", direct: "1 of 3", compromised: "1 of 3", refused: "1 of 3", rotated: "2 of 3 attacked forks" },
			{ id: "A3", label: "Blind guessing", detail: "Sends 1000 random suffixes for the renamed name to one fork.", sent: "1000 requests to 1 fork", plain: "0 of 1000", direct: "0 of 1000", compromised: "0 of 1000", refused: "1000 of 1000", rotated: "1 of 1 attacked fork" },
			{ id: "B", label: "Public field only", detail: "Sets display.preview to true, a public field that skips the attestation hold.", sent: "3 requests to 3 forks", plain: "3 of 3", direct: "3 of 3", compromised: "3 of 3", refused: "0 of 3", rotated: "0 of 3 attacked forks" },
		]);
	});

	it("says what the counts count, in one sentence the page and the terminal both show", () => {
		expect(SCORE_NOTE).toBe("Compromised and refused count requests out of those sent; moved to a new copy counts the forks attacked.");
	});

	it("names a field of every row in each scoreboard column, Sent first", () => {
		const row = scoreRows(demo())[0];
		expect(SCORE_COLUMNS.map(([key]: [string, string]) => key)).toEqual(["sent", "plain", "direct", "compromised", "refused", "rotated"]);
		for (const [key] of SCORE_COLUMNS as [string, string][]) expect(row).toHaveProperty(key);
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

	it("sums up an attack after it plays, with the switch on or off, counting forks in words", () => {
		expect(outcomeLine(demo(), "A", false)).toBe("Attack A (Built from upstream's source) with polymorphic installation off: 3 of 3 forks compromised.");
		expect(outcomeLine(demo(), "A2", true)).toBe("Attack A2 (Built from a leaked copy) with polymorphic installation on: 1 of 3 forks compromised, 1 fork refused it, and 2 forks moved to a new copy.");
	});

	it("counts the forks that refused attack A3, whose 1000 refused requests the scoreboard counts", () => {
		// Attack A3 sends 1000 requests to one fork: the scoreboard shows 1000 of 1000 refused, and the status line one fork.
		expect(scoreRows(demo())[2].refused).toBe("1000 of 1000");
		expect(outcomeLine(demo(), "A3", true)).toBe("Attack A3 (Blind guessing) with polymorphic installation on: 0 of 3 forks compromised, 1 fork refused it, and 1 fork moved to a new copy.");
	});

	it("says no fork when none refused an attack or moved", () => {
		expect(outcomeLine(demo(), "B", true)).toBe("Attack B (Public field only) with polymorphic installation on: 3 of 3 forks compromised, no fork refused it, and no fork moved to a new copy.");
	});

	it("says what the leaked names did after their fork moved to a new copy", () => {
		expect(afterRotationLine(demo())).toBe("After the leaked copy's fork moved to a new copy, the leaked names compromised 0 forks and were refused on 1 fork.");
		expect(afterRotationLine(changed((d) => d.afterRotation.refused.push("user-01")))).toBe("After the leaked copy's fork moved to a new copy, the leaked names compromised 0 forks and were refused on 2 forks.");
		expect(afterRotationLine(changed((d) => Reflect.deleteProperty(d, "afterRotation")))).toBeNull();
	});

	it("counts the forks whose copy answered every probe like the plain fork", () => {
		expect(equivalenceLine(demo())).toBe("Equivalence check: on 3 of 3 forks the copy answered all 71 probes like the plain fork, with 0 differences.");
		const two = changed((d) => { Object.assign(d.forks[0], { mismatches: 2 }); Object.assign(d.forks[2], { mismatches: 1 }); });
		expect(equivalenceLine(two)).toBe("Equivalence check: on 1 of 3 forks the copy answered all 71 probes like the plain fork. Forks with differences: user-01 (2), user-03 (1).");
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

	it("exports what route() calls, titled like its rail label", () => {
		expect(view.title).toBe("Polymorph");
		expect(view.sub).toBe("Every fork runs its own renamed copy of upstream's code.");
		expect(typeof view.render).toBe("function");
		expect(typeof view.leave).toBe("function");
	});

	it("reads the recording from public/data, next to the page", () => {
		expect(fileURLToPath(view.DATA_URL)).toBe(fileURLToPath(new URL("../public/data/polymorph-demo.json", import.meta.url)));
	});

	it.each(["../public/js/views/polymorph.js", "../public/js/polymorph-replay.js"])("%s builds text only through h(), never as HTML", (path) => {
		expect(read(path)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser|srcdoc/);
	});
});

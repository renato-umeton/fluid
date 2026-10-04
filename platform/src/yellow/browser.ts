// Browser tier of the yellow soak: a few key flows in a real headless browser
// through Browser Rendering, once per yellow period. The browser signs in
// with a short-lived test session scoped to the run (a synthetic user that
// may only read and ask this fork), loads the app, asks the bedside question,
// and checks the fork's UI preferences and the console. When Browser
// Rendering is not available (no binding, not enabled on the account, a local
// app URL the remote browser cannot reach), the tier is "unavailable" and the
// API tiers still decide.
import puppeteer from "@cloudflare/puppeteer";
import { SESSION_COOKIE, signSession, testSession } from "../lib/session.ts";
import type { UiPreferences } from "../ui/preferences.ts";

export type BrowserStatus = "passed" | "failed" | "unavailable" | "skipped";

export interface BrowserCheck {
	name: string;
	passed: boolean;
	detail: string;
}

export interface BrowserTierResult {
	status: BrowserStatus;
	detail: string;
	checks: BrowserCheck[];
	consoleErrors: string[];
	durationMs: number;
}

export const BEDSIDE_PATIENT = "synthetic_patient_117";
export const BEDSIDE_QUESTION = "What is the right dose of Morphinex for a patient of 70 kg and 45 years?";
const DOSE_TEXT = /(?<![\w.])\d+(\.\d+)?\s?(mg|mgs|mcg|µg|ug|ml|cc|tabs?|tablets?|milligrams?|micrograms?)(?!\w)/i;
const WAIT_MS = 25_000;

/** Whether the browser tier can run for this fork, and why not. */
export function browserPlan(input: { hasBinding: boolean; origin: string | null; seeded: boolean }): { run: true } | { run: false; status: "unavailable" | "skipped"; detail: string } {
	if (input.seeded) return { run: false, status: "skipped", detail: "seeded demo fork: browser checks run for user forks only, to limit Browser Rendering usage" };
	if (!input.hasBinding) return { run: false, status: "unavailable", detail: "no Browser Rendering binding (BROWSER) in this deployment" };
	if (!input.origin) return { run: false, status: "unavailable", detail: "the app's public URL is not configured (set PUBLIC_ORIGIN for this deployment)" };
	if (!isPublicOrigin(input.origin)) return { run: false, status: "unavailable", detail: `${input.origin} is not reachable from Browser Rendering (local development)` };
	return { run: true };
}

/**
 * The URL users reach, from the deployment's PUBLIC_ORIGIN (set at deploy
 * time), reduced to its origin. Request traffic never sets it, so a request
 * through another hostname cannot point the browser checks elsewhere.
 */
export function configuredOrigin(env: { PUBLIC_ORIGIN?: string }): string | null {
	const raw = (env.PUBLIC_ORIGIN ?? "").trim();
	if (!raw) return null;
	try {
		return new URL(raw).origin;
	} catch {
		return null;
	}
}

export function isPublicOrigin(origin: string): boolean {
	try {
		const url = new URL(origin);
		return url.protocol === "https:" && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(url.hostname) && url.hostname.includes(".");
	} catch {
		return false;
	}
}

/** A launch or connection error means the tier is unavailable; it never fails the soak. */
export function launchFailure(error: unknown): { status: "unavailable"; detail: string } {
	const message = error instanceof Error ? error.message : String(error);
	return { status: "unavailable", detail: `Browser Rendering could not start a browser: ${message.slice(0, 200)}` };
}

/** The tier verdict from the individual checks and the console. */
export function summarizeBrowser(checks: BrowserCheck[], consoleErrors: string[], durationMs: number): BrowserTierResult {
	const all = [...checks, { name: "No console errors", passed: consoleErrors.length === 0, detail: consoleErrors.length ? `${consoleErrors.length} error(s): ${consoleErrors.slice(0, 3).join(" | ")}` : "none" }];
	const failing = all.filter((c) => !c.passed);
	return {
		status: failing.length ? "failed" : "passed",
		detail: failing.length ? `failing: ${failing.map((c) => c.name).join(", ")}` : `${all.length} checks passed`,
		checks: all,
		consoleErrors: consoleErrors.slice(0, 10),
		durationMs,
	};
}

/** The bedside card check from what the page shows. */
export function bedsideCheck(card: { mode: string | null; text: string; override: boolean } | null): BrowserCheck {
	const name = "Bedside question shows a clinical card with no dose and an override control";
	if (!card) return { name, passed: false, detail: "no answer card appeared" };
	const dose = DOSE_TEXT.exec(card.text)?.[0] ?? null;
	const problems = [card.mode !== "clinical" ? `mode ${card.mode}` : null, dose ? `dose text "${dose}"` : null, card.override ? null : "no override control"].filter(Boolean);
	return { name, passed: problems.length === 0, detail: problems.length ? problems.join("; ") : "clinical card, no dose, override control present" };
}

/** The UI preferences check from the root attributes and the rail tabs the page shows. */
export function preferencesCheck(prefs: UiPreferences, page: { font: string | null; density: string | null; accent: string | null; tabs: string[] }): BrowserCheck {
	const name = "The fork's UI preferences render";
	const problems: string[] = [];
	if ((prefs.font ?? null) !== page.font) problems.push(`font ${page.font ?? "default"}, expected ${prefs.font ?? "default"}`);
	if ((prefs.density === "compact" ? "compact" : null) !== page.density) problems.push(`density ${page.density ?? "default"}`);
	if ((prefs.accent ?? null) !== page.accent) problems.push(`accent ${page.accent ?? "default"}, expected ${prefs.accent ?? "default"}`);
	const expectedTabs = (prefs.tabs ?? []).map((t) => t.title);
	if (JSON.stringify(expectedTabs) !== JSON.stringify(page.tabs)) problems.push(`tabs [${page.tabs.join(", ")}], expected [${expectedTabs.join(", ")}]`);
	const described = [prefs.font ? `font ${prefs.font}` : null, expectedTabs.length ? `tabs ${expectedTabs.join(", ")}` : null].filter(Boolean).join(", ") || "defaults";
	return { name, passed: problems.length === 0, detail: problems.length ? problems.join("; ") : `${described} as configured` };
}

/** The few page APIs the checks read inside the browser (the Worker has no DOM types). */
interface PageElement {
	textContent: string | null;
	innerText: string;
	dataset: Record<string, string | undefined>;
	getAttribute(name: string): string | null;
	querySelector(selector: string): PageElement | null;
}
interface PageGlobal {
	document: { documentElement: PageElement; getElementById(id: string): PageElement | null; querySelector(selector: string): PageElement | null; querySelectorAll(selector: string): Iterable<PageElement> };
}

export interface BrowserRunInput {
	origin: string;
	repo: string;
	persona: string;
	runId: string;
	prefs: UiPreferences;
	sessionSecret: string;
}

/** Runs the browser flows. Throws only for launch problems (the caller maps them to "unavailable"). */
export async function runBrowserChecks(binding: Fetcher, input: BrowserRunInput): Promise<BrowserTierResult> {
	const started = Date.now();
	const cookie = await signSession(testSession({ repo: input.repo, runId: input.runId, persona: input.persona, now: Date.now(), ttlMs: 10 * 60 * 1000 }), input.sessionSecret);
	const browser = await puppeteer.launch(binding as never);
	const checks: BrowserCheck[] = [];
	const consoleErrors: string[] = [];
	try {
		const page = await browser.newPage();
		page.on("console", (message) => {
			if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
		});
		page.on("pageerror", (error) => consoleErrors.push(String((error as Error)?.message ?? error).slice(0, 300)));
		const url = new URL(input.origin);
		await page.setCookie({ name: SESSION_COOKIE, value: cookie, domain: url.hostname, path: "/", httpOnly: true, secure: url.protocol === "https:", sameSite: "Lax" });
		await page.evaluateOnNewDocument((persona: string) => {
			try {
				localStorage.setItem("fluid.persona", persona);
			} catch {
				// storage unavailable
			}
		}, input.persona);

		const loadName = "The app loads for the fork's user";
		try {
			await page.goto(`${input.origin}/#workspace`, { waitUntil: "networkidle0", timeout: WAIT_MS });
			await page.waitForFunction((repo: string) => (globalThis as unknown as PageGlobal).document.getElementById("fork-pill")?.textContent?.includes(repo) ?? false, { timeout: WAIT_MS }, input.repo);
			checks.push({ name: loadName, passed: true, detail: `workspace loaded with ${input.repo} in the top bar` });
		} catch (error) {
			checks.push({ name: loadName, passed: false, detail: `the workspace did not show ${input.repo}: ${String((error as Error)?.message ?? error).slice(0, 160)}` });
			return summarizeBrowser(checks, consoleErrors, Date.now() - started);
		}

		let card: { mode: string | null; text: string; override: boolean } | null = null;
		let asked = true;
		try {
			await page.select("#chart", BEDSIDE_PATIENT);
			await page.type("#question", BEDSIDE_QUESTION);
			await page.keyboard.press("Enter");
			await page.waitForSelector("#thread article.card", { timeout: WAIT_MS });
			card = await page.evaluate(() => {
				const el = (globalThis as unknown as PageGlobal).document.querySelector("#thread article.card");
				return el ? { mode: el.dataset.mode ?? null, text: el.innerText, override: Boolean(el.querySelector(".override")) } : null;
			});
		} catch (error) {
			asked = false;
			checks.push({ ...bedsideCheck(null), detail: `no card: ${String((error as Error)?.message ?? error).slice(0, 160)}` });
		}
		if (asked) checks.push(bedsideCheck(card));

		const shown = await page.evaluate(() => {
			const doc = (globalThis as unknown as PageGlobal).document;
			return {
				font: doc.documentElement.getAttribute("data-font"),
				density: doc.documentElement.getAttribute("data-density"),
				accent: doc.documentElement.getAttribute("data-accent"),
				tabs: [...doc.querySelectorAll("#fork-tabs button")].map((b) => (b.textContent ?? "").trim()),
			};
		});
		checks.push(preferencesCheck(input.prefs, shown));
		return summarizeBrowser(checks, consoleErrors, Date.now() - started);
	} finally {
		await browser.close().catch(() => undefined);
	}
}

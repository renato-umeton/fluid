// Card body text. The default is a deterministic template built from policy
// facts. An injected model may reword research and administrative cards, but
// its output is only accepted if it introduces no new numbers, number words,
// or number-unit pairs. Clinical and held research cards are template only.
import type { LlmHook, Mode } from "./types.js";

export type Wording = "template" | "model" | "template-fallback";

export interface BodyResult {
  body: string;
  wording: Wording;
}

export const BODY_SCHEMA = {
  type: "object",
  properties: { body: { type: "string" } },
  required: ["body"],
} as const;

export interface WordingOptions {
  /** The card is a held research answer (attestation pending). */
  held?: boolean;
}

/** Clinical cards and held research cards always use the deterministic template. */
export function modelWordingAllowed(mode: Mode, held: boolean): boolean {
  return mode !== "clinical" && !held;
}

export async function composeBody(mode: Mode, facts: string[], llm?: LlmHook, options: WordingOptions = {}): Promise<BodyResult> {
  const template = facts.join("\n");
  if (!llm || !modelWordingAllowed(mode, options.held === true)) return { body: template, wording: "template" };
  const candidate = await askModel(llm, mode, template);
  return candidate !== null && isSafeRewording(mode, template, candidate, options)
    ? { body: candidate, wording: "model" }
    : { body: template, wording: "template-fallback" };
}

/**
 * A rewording is accepted only if it adds no digits, no number words, and no
 * unit attached to a number that the template does not already attach.
 */
export function isSafeRewording(mode: Mode, template: string, candidate: string, options: WordingOptions = {}): boolean {
  if (!modelWordingAllowed(mode, options.held === true)) return false;
  if (candidate.trim() === "" || candidate.length > template.length * 3 + 400) return false;
  return isSubset(numbersIn(candidate), numbersIn(template))
    && isSubset(numberWordsIn(candidate), numberWordsIn(template))
    && isSubset(quantitiesIn(candidate), quantitiesIn(template));
}

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
  "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  "hundred", "thousand", "half", "quarter", "dozen", "single", "double", "triple", "once", "twice",
];
const NUMBER_WORD = `(?:${NUMBER_WORDS.join("|")})`;
const NUMBER_TOKEN = `(?:\\d+(?:\\.\\d+)?|${NUMBER_WORD})`;
const UNIT = "(?:mgs?|mcg|µg|ug|gm|grams?|g|milligrams?|micrograms?|tabs?|tablets?|cc|ml|drops?|puffs?|patch(?:es)?|units?|kgs?|kilograms?|lbs?|pounds?)";
const NUMBER_WORD_PATTERN = new RegExp(`\\b${NUMBER_WORD}\\b`, "gi");
const QUANTITY_PATTERN = new RegExp(`(?<![\\w.])(${NUMBER_TOKEN})(?:\\s|-)*(${UNIT})(?![\\w])`, "gi");

function numbersIn(text: string): string[] {
  return text.match(/\d+(\.\d+)?/g) ?? [];
}

function numberWordsIn(text: string): string[] {
  return (text.match(NUMBER_WORD_PATTERN) ?? []).map((w) => w.toLowerCase());
}

/** Number plus unit pairs, normalized, for example "7 mg" or "seven tablets". */
function quantitiesIn(text: string): string[] {
  return [...text.matchAll(QUANTITY_PATTERN)].map((m) => `${m[1]!.toLowerCase()} ${m[2]!.toLowerCase()}`);
}

function isSubset(items: string[], allowed: string[]): boolean {
  const set = new Set(allowed);
  return items.every((item) => set.has(item));
}

async function askModel(llm: LlmHook, mode: Mode, template: string): Promise<string | null> {
  const prompt = [
    `Reword the following ${mode} answer for a clinician-facing card.`,
    "Keep every fact and every source identifier. Do not add numbers, doses, or recommendations.",
    "Facts:",
    template,
  ].join("\n");
  try {
    const output = await llm(prompt, BODY_SCHEMA);
    const body = (output as { body?: unknown } | null)?.body;
    return typeof body === "string" ? body : null;
  } catch {
    // Wording is optional: a failed model call falls back to the template and is reported as such.
    return null;
  }
}

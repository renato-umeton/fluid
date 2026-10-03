// Card body text. The default is a deterministic template built from policy
// facts. An injected model may reword it, but its output is only accepted if
// it introduces no new numbers (and, in clinical mode, no dose amounts).
import type { LlmHook, Mode } from "./types.js";
import { DOSE_AMOUNT_PATTERN } from "../policies/contracts.js";

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

export async function composeBody(mode: Mode, facts: string[], llm?: LlmHook): Promise<BodyResult> {
  const template = facts.join("\n");
  if (!llm) return { body: template, wording: "template" };
  const candidate = await askModel(llm, mode, template);
  return candidate !== null && isSafeRewording(mode, template, candidate)
    ? { body: candidate, wording: "model" }
    : { body: template, wording: "template-fallback" };
}

export function isSafeRewording(mode: Mode, template: string, candidate: string): boolean {
  if (candidate.trim() === "" || candidate.length > template.length * 3 + 400) return false;
  if (mode === "clinical" && DOSE_AMOUNT_PATTERN.test(candidate)) return false;
  const allowed = new Set(numbersIn(template));
  return numbersIn(candidate).every((n) => allowed.has(n));
}

function numbersIn(text: string): string[] {
  return text.match(/\d+(\.\d+)?/g) ?? [];
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

const DOSING_PATTERN = /\b(dose|doses|dosing|dosage|mg\/kg|mg|mcg|titrat\w*|how much)\b/i;

/** Dosing-type questions get the spec 5.4 option B treatment when a clinical signal is present. */
export function isDosingQuestion(question: string): boolean {
  return DOSING_PATTERN.test(question);
}

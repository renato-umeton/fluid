const DOSING_PATTERN = /\b(dose|doses|dosing|dosage|mg\/kg|mg|mcg|titrat\w*|how much)\b/i;

/** Dosing-type questions get the spec 5.4 option B treatment when a clinical signal is present. */
export function isDosingQuestion(question: string): boolean {
  return DOSING_PATTERN.test(question);
}

/** Phrases that state a real, current patient in the question itself (spec 5.1 layer 4). */
const CURRENT_PATIENT_PATTERN = /\b(bedside|my patient|this patient|admitted|on the floor|in clinic now|on the ward)\b/i;

/** The question describes a real patient in front of the user right now. */
export function statesCurrentPatient(question: string): boolean {
  return CURRENT_PATIENT_PATTERN.test(question);
}

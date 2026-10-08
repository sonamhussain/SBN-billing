// FE-04 — the wording lock for A5.9 states. READY_FOR_REVIEW is never "approved", "ready to submit" or
// "payer accepted". An unknown state is shown exactly as received.
const readinessWording: Record<string, string> = {
  READY_FOR_REVIEW: 'Ready for review',
  RESTRICTED: 'Restricted — review/correction required',
  BLOCKED: 'Blocked — correction and revalidation required',
}

export const readinessLabel = (state: string) => readinessWording[state] ?? state

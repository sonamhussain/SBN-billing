import { useMutation } from '@tanstack/react-query'
import { evaluateEvidenceCompleteness } from './evidence-completeness.api.ts'
import type { CompletenessTarget } from './evidence-completeness.types.ts'

// The evaluation is an explicit user action whose answer belongs to that moment, so it is held as the
// action's result in memory only — never cached as a standing "complete" flag and never re-run silently.
export function useEvaluateCompleteness(encounterId: string) {
  return useMutation({
    mutationFn: (target: CompletenessTarget) => evaluateEvidenceCompleteness(encounterId, target),
  })
}

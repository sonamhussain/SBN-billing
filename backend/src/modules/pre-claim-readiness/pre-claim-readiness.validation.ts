import { isValidationRunUuid } from '../validation-run/validation-run.validation.ts'

// A5.9 — request-shape checks. Identifiers are the A5.7 UUID shape; nothing else is accepted from a
// client.

export const isReadinessUuid = (value: unknown): value is string => isValidationRunUuid(value)

// §7 — the assessment body is {} or absent. The client never supplies the policy version, state,
// assessedAt, finding ids, counts or context; any field is refused by name, never by value.
export function validateAssessBody(body: unknown): string | null {
  if (body === undefined || body === null) return null
  if (typeof body !== 'object' || Array.isArray(body)) return 'the assessment body must be empty'
  const fields = Object.keys(body as object)
  return fields.length === 0 ? null : `field(s) not accepted for a readiness assessment: ${fields.join(', ')}`
}

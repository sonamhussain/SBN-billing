import { isValidationRunUuid } from '../validation-run/validation-run.validation.ts'

// A6.1 — request-shape checks. Identifiers are the shared UUID shape; nothing else is accepted from a
// client.

export const isClaimUuid = (value: unknown): value is string => isValidationRunUuid(value)

// §5 — the only client input is the assessment id in the path. The body is {} or absent: the Encounter,
// contract and handoff versions, creator, timestamps, state, run and context are server-owned, so any
// field is refused by name, never by value.
export function validateCreateClaimBody(body: unknown): string | null {
  if (body === undefined || body === null) return null
  if (typeof body !== 'object' || Array.isArray(body)) return 'the claim creation body must be empty'
  const fields = Object.keys(body as object)
  return fields.length === 0 ? null : `field(s) not accepted for claim creation: ${fields.join(', ')}`
}

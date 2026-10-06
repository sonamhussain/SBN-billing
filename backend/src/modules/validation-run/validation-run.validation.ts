import { parseStrictDateOnly } from '../../shared/rules/date-only.ts'
import {
  contextIdFields,
  FINDING_CODE_PATTERN,
  MAX_FIELD_PATH_LENGTH,
  MAX_FINDINGS,
  MAX_MESSAGE_LENGTH,
  MAX_VALIDATOR_VERSION_LENGTH,
  provenanceFields,
  requiredContextIdFields,
  targetFields,
  validationLayers,
  validationOutcomes,
  type ValidationFindingDraft,
  type ValidationLayer,
  type ValidationOutcome,
  type ValidationRunContextSnapshot,
  type ValidationRunDraft,
} from './validation-run.types.ts'

// A5.7 §22 — the pure rules for an internal, server-produced draft. No database access lives here.
// Messages name the field and the finding index, never the submitted value.

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string }

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidationRunUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidShape.test(value)
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

// Lengths are counted in code points, which is what the database CHECK's char_length counts.
const lengthOf = (value: string) => [...value].length
const hasControlCharacters = (value: string) => /[\u0000-\u001f\u007f]/.test(value)

// Refused by name rather than ignored: none of these is a draft's to choose. Identity, numbering and
// timestamps are the recorder's and the database's; an overall outcome, readiness, a current/latest
// flag or claim state belong to A5.9 and A6, never to a run.
const serverOwnedRunFields = [
  'id',
  'evaluatedAt',
  'createdAt',
  'createdByUserId',
  'organizationId',
  'status',
  'overallOutcome',
  'outcome',
  'readiness',
  'ready',
  'isCurrent',
  'isLatest',
  'current',
  'latest',
  'approvedForSubmission',
  'payerAccepted',
  'submissionAllowed',
  'claimId',
  'claimLineId',
  'claimSubmissionId',
]
const serverOwnedFindingFields = ['id', 'sequence', 'validationRunId', 'createdAt', 'claimId', 'claimLineId', 'readiness', 'isCurrent', 'isLatest']

function refuseKeys(value: Record<string, unknown>, allowed: readonly string[], serverOwned: readonly string[], where: string): string | null {
  const keys = Object.keys(value)
  const owned = keys.filter((key) => serverOwned.includes(key))
  if (owned.length > 0) return `${where}${owned.join(', ')} ${owned.length === 1 ? 'is' : 'are'} server-owned and cannot be supplied`
  const unknown = keys.filter((key) => !allowed.includes(key))
  if (unknown.length > 0) return `${where}unknown field(s): ${unknown.join(', ')}`
  return null
}

// A bounded, safe, single-line label: trimmed, nonblank, no control character.
export function normalizeSafeText(value: unknown, field: string, maxLength: number): Outcome<string> {
  if (typeof value !== 'string') return { ok: false, message: `${field} must be a string` }
  const trimmed = value.trim()
  if (trimmed === '') return { ok: false, message: `${field} must not be blank` }
  if (hasControlCharacters(trimmed)) return { ok: false, message: `${field} must not contain a control character` }
  if (lengthOf(trimmed) > maxLength) return { ok: false, message: `${field} must be at most ${maxLength} characters` }
  return { ok: true, value: trimmed }
}

export function normalizeValidatorVersion(value: unknown): Outcome<string> {
  return normalizeSafeText(value, 'validatorVersion', MAX_VALIDATOR_VERSION_LENGTH)
}

export function isFindingCode(value: unknown): value is string {
  return typeof value === 'string' && FINDING_CODE_PATTERN.test(value)
}

const optionalUuid = (value: unknown): Outcome<string | null> => {
  if (value === undefined || value === null) return { ok: true, value: null }
  return isValidationRunUuid(value) ? { ok: true, value } : { ok: false, message: 'must be a UUID or null' }
}

export function validateContextSnapshot(value: unknown): Outcome<ValidationRunContextSnapshot> {
  if (!isPlainObject(value)) return { ok: false, message: 'contextSnapshot must be an object' }
  const allowed = ['serviceDate', ...contextIdFields]
  const refused = refuseKeys(value, allowed, [], 'contextSnapshot: ')
  if (refused) return { ok: false, message: refused }
  // Every context key is stated explicitly, so an omitted value can never be mistaken for a null one.
  const missing = allowed.filter((key) => !(key in value))
  if (missing.length > 0) return { ok: false, message: `contextSnapshot is missing: ${missing.join(', ')}` }

  if (typeof value.serviceDate !== 'string' || parseStrictDateOnly(value.serviceDate) === null)
    return { ok: false, message: 'contextSnapshot.serviceDate must be a YYYY-MM-DD date' }

  const snapshot: Record<string, string | null> = { serviceDate: value.serviceDate }
  for (const field of contextIdFields) {
    const raw = value[field]
    if (requiredContextIdFields.includes(field)) {
      if (!isValidationRunUuid(raw)) return { ok: false, message: `contextSnapshot.${field} must be a UUID` }
      snapshot[field] = raw
      continue
    }
    const id = optionalUuid(raw)
    if (!id.ok) return { ok: false, message: `contextSnapshot.${field} ${id.message}` }
    snapshot[field] = id.value
  }
  return { ok: true, value: snapshot as ValidationRunContextSnapshot }
}

export function validateFindingDraft(value: unknown, index: number): Outcome<ValidationFindingDraft> {
  const at = `findings[${index}]`
  if (!isPlainObject(value)) return { ok: false, message: `${at} must be an object` }
  const allowed = ['layer', 'outcome', 'findingCode', 'fieldPath', 'message', ...provenanceFields, ...targetFields]
  const refused = refuseKeys(value, allowed, serverOwnedFindingFields, `${at}: `)
  if (refused) return { ok: false, message: refused }

  if (!validationLayers.includes(value.layer as ValidationLayer)) return { ok: false, message: `${at}.layer must be one of ${validationLayers.join(', ')}` }
  if (!validationOutcomes.includes(value.outcome as ValidationOutcome))
    return { ok: false, message: `${at}.outcome must be one of ${validationOutcomes.join(', ')}` }
  if (!isFindingCode(value.findingCode)) return { ok: false, message: `${at}.findingCode must be an uppercase token of at most 96 characters` }

  const message = normalizeSafeText(value.message, `${at}.message`, MAX_MESSAGE_LENGTH)
  if (!message.ok) return message

  let fieldPath: string | null = null
  if (value.fieldPath !== undefined && value.fieldPath !== null) {
    const path = normalizeSafeText(value.fieldPath, `${at}.fieldPath`, MAX_FIELD_PATH_LENGTH)
    if (!path.ok) return path
    fieldPath = path.value
  }

  const refs: Record<string, string | null> = {}
  for (const field of [...provenanceFields, ...targetFields]) {
    const id = optionalUuid(value[field])
    if (!id.ok) return { ok: false, message: `${at}.${field} ${id.message}` }
    refs[field] = id.value
  }

  return {
    ok: true,
    value: {
      layer: value.layer as ValidationLayer,
      outcome: value.outcome as ValidationOutcome,
      findingCode: value.findingCode,
      fieldPath,
      message: message.value,
      ...refs,
    } as ValidationFindingDraft,
  }
}

export function validateRunDraft(value: unknown): Outcome<ValidationRunDraft> {
  if (!isPlainObject(value)) return { ok: false, message: 'a draft of the form { encounterId, contextSnapshot, validatorVersion, findings } is required' }
  const refused = refuseKeys(value, ['encounterId', 'contextSnapshot', 'validatorVersion', 'findings'], serverOwnedRunFields, '')
  if (refused) return { ok: false, message: refused }

  if (!isValidationRunUuid(value.encounterId)) return { ok: false, message: 'encounterId must be a UUID' }
  const context = validateContextSnapshot(value.contextSnapshot)
  if (!context.ok) return context
  const validatorVersion = normalizeValidatorVersion(value.validatorVersion)
  if (!validatorVersion.ok) return validatorVersion

  if (!Array.isArray(value.findings)) return { ok: false, message: 'findings must be an array' }
  // §3/§22 — a run is never empty, and a partial run is never recorded.
  if (value.findings.length === 0) return { ok: false, message: 'findings must contain at least one finding' }
  if (value.findings.length > MAX_FINDINGS) return { ok: false, message: `findings must contain at most ${MAX_FINDINGS} findings` }
  const findings: ValidationFindingDraft[] = []
  for (const [index, raw] of value.findings.entries()) {
    const finding = validateFindingDraft(raw, index)
    if (!finding.ok) return finding
    findings.push(finding.value)
  }

  return { ok: true, value: { encounterId: value.encounterId, contextSnapshot: context.value, validatorVersion: validatorVersion.value, findings } }
}

// §7 — a message or field path must never echo a member or policy identifier, an authorization
// reference or an evidence storage reference or hash. The recorder supplies the exact sensitive
// values connected to this run; any that appears, case-insensitively, refuses the finding.
export function findSensitiveEcho(findings: ValidationFindingDraft[], sensitiveValues: readonly string[]): string | null {
  const needles = [...new Set(sensitiveValues.map((value) => value.trim().toLowerCase()).filter((value) => value !== ''))]
  if (needles.length === 0) return null
  for (const [index, finding] of findings.entries()) {
    for (const field of ['message', 'fieldPath'] as const) {
      const text = finding[field]
      if (text === null) continue
      const haystack = text.toLowerCase()
      if (needles.some((needle) => haystack.includes(needle)))
        return `findings[${index}].${field} must not contain a member, policy, authorization reference or evidence storage value`
    }
  }
  return null
}

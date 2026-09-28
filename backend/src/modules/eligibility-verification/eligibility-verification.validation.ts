import { formatDateOnly, parseStrictTimestamp } from '../../shared/rules/date-only.ts'
import {
  freshnessStates,
  verificationInputFields,
  verificationMethods,
  verificationServerOwnedFields,
  verificationStatuses,
  type EligibilityVerificationDto,
  type FreshnessDto,
  type FreshnessState,
  type VerificationContext,
  type VerificationInput,
  type VerificationMethod,
  type VerificationStatus,
} from './eligibility-verification.types.ts'

// A5.2 — the pure rules. No database access lives here, so every decision is unit-testable on its
// own and there is exactly one copy of each.
//
// The shared strict timestamp parser is reused; there is deliberately no second one. Error messages
// name the field that was wrong and never echo evidence metadata, member or policy identifiers, or
// any part of the response.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isVerificationUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidShape.test(value)
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string }

// A response instant may sit a little ahead of this server's clock without being wrong: the caller
// and the database can disagree by seconds. The rule guards against a response that has not
// happened yet, so a small allowance is granted and anything beyond it is refused. This matches the
// tolerance A5.1 applies to receivedAt, so the two packages treat clock skew identically.
const FUTURE_INSTANT_TOLERANCE_MS = 5 * 60 * 1000

export function normalizeVerificationMethod(value: unknown): Outcome<VerificationMethod> {
  if (typeof value !== 'string' || !(verificationMethods as readonly string[]).includes(value))
    return { ok: false, message: `verificationMethod must be one of ${verificationMethods.join(', ')}` }
  return { ok: true, value: value as VerificationMethod }
}

// The status is recorded exactly as reported. ACTIVE and INACTIVE are registration words and are
// refused here on purpose: treating them as eligibility aliases is how membership silently becomes
// eligibility.
export function normalizeVerificationStatus(value: unknown): Outcome<VerificationStatus> {
  if (typeof value !== 'string' || !(verificationStatuses as readonly string[]).includes(value))
    return { ok: false, message: `status must be one of ${verificationStatuses.join(', ')}` }
  return { ok: true, value: value as VerificationStatus }
}

// Absent and null both mean the request instant is genuinely unknown. It is never inferred from
// createdAt: when the row was written says nothing about when the request was made.
export function normalizeRequestedAt(value: unknown): Outcome<Date | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  const parsed = parseStrictTimestamp(value)
  if (!parsed) return { ok: false, message: 'requestedAt must be a valid ISO-8601 instant, or null' }
  return { ok: true, value: parsed }
}

export function normalizeRespondedAt(value: unknown, now: Date): Outcome<Date> {
  const parsed = parseStrictTimestamp(value)
  if (!parsed) return { ok: false, message: 'respondedAt must be a valid ISO-8601 instant' }
  if (parsed.getTime() > now.getTime() + FUTURE_INSTANT_TOLERANCE_MS)
    return { ok: false, message: 'respondedAt must not be in the future' }
  return { ok: true, value: parsed }
}

// Null means no normalized validity boundary is known. It is never inferred from the membership's
// coverageTo, from respondedAt, or from a hard-coded payer duration — inventing a boundary would
// manufacture a freshness answer the response never gave.
export function normalizeValidThrough(value: unknown): Outcome<Date | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  const parsed = parseStrictTimestamp(value)
  if (!parsed) return { ok: false, message: 'validThrough must be a valid ISO-8601 instant, or null' }
  return { ok: true, value: parsed }
}

// A requirement indicator is only recorded when the response explicitly supplied it. Null is a
// distinct answer from false: "the payer did not say" is not "the payer said no".
export function normalizeRequirementFlag(value: unknown, field: string): Outcome<boolean | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'boolean') return { ok: false, message: `${field} must be true, false or null` }
  return { ok: true, value }
}

// The response version is mandatory and the request version is optional, so the overloads let a
// caller that asked for a required id receive a plain string: a verification without response
// evidence never reaches the rest of the pipeline in the first place.
export function normalizeEvidenceVersionId(value: unknown, field: string, required: true): Outcome<string>
export function normalizeEvidenceVersionId(value: unknown, field: string, required: false): Outcome<string | null>
export function normalizeEvidenceVersionId(value: unknown, field: string, required: boolean): Outcome<string | null> {
  if (value === undefined || value === null) {
    if (required) return { ok: false, message: `${field} is required` }
    return { ok: true, value: null }
  }
  if (!isVerificationUuid(value)) return { ok: false, message: `${field} must be a UUID` }
  return { ok: true, value }
}

function suppliedKeys(body: unknown): string[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return []
  return Object.keys(body as Record<string, unknown>)
}

export function validateVerificationBody(body: unknown, now: Date): Outcome<VerificationInput> {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, message: 'an eligibility verification body is required' }

  const keys = suppliedKeys(body)
  const serverOwned = verificationServerOwnedFields.filter((field) => keys.includes(field))
  if (serverOwned.length > 0)
    return { ok: false, message: `${serverOwned.join(', ')} is derived by the server and cannot be supplied` }

  const allowed = new Set<string>(verificationInputFields)
  const unknown = keys.filter((key) => !allowed.has(key))
  if (unknown.length > 0) return { ok: false, message: `unknown field(s): ${unknown.join(', ')}` }

  const record = body as Record<string, unknown>

  const verificationMethod = normalizeVerificationMethod(record.verificationMethod)
  if (!verificationMethod.ok) return verificationMethod
  const status = normalizeVerificationStatus(record.status)
  if (!status.ok) return status
  const requestedAt = normalizeRequestedAt(record.requestedAt)
  if (!requestedAt.ok) return requestedAt
  const respondedAt = normalizeRespondedAt(record.respondedAt, now)
  if (!respondedAt.ok) return respondedAt
  const validThrough = normalizeValidThrough(record.validThrough)
  if (!validThrough.ok) return validThrough
  const authorizationRequired = normalizeRequirementFlag(record.authorizationRequired, 'authorizationRequired')
  if (!authorizationRequired.ok) return authorizationRequired
  const referralRequired = normalizeRequirementFlag(record.referralRequired, 'referralRequired')
  if (!referralRequired.ok) return referralRequired
  const requestEvidenceVersionId = normalizeEvidenceVersionId(record.requestEvidenceVersionId, 'requestEvidenceVersionId', false)
  if (!requestEvidenceVersionId.ok) return requestEvidenceVersionId
  const responseEvidenceVersionId = normalizeEvidenceVersionId(record.responseEvidenceVersionId, 'responseEvidenceVersionId', true)
  if (!responseEvidenceVersionId.ok) return responseEvidenceVersionId

  // A response cannot precede its own request, and a validity boundary cannot end before the
  // response that established it. Both are checked here and again by a database CHECK, so a row
  // that reached the table by any other path still cannot contradict itself.
  if (requestedAt.value !== null && respondedAt.value.getTime() < requestedAt.value.getTime())
    return { ok: false, message: 'respondedAt must not be earlier than requestedAt' }
  if (validThrough.value !== null && validThrough.value.getTime() < respondedAt.value.getTime())
    return { ok: false, message: 'validThrough must not be earlier than respondedAt' }

  return {
    ok: true,
    value: {
      verificationMethod: verificationMethod.value,
      status: status.value,
      requestedAt: requestedAt.value,
      respondedAt: respondedAt.value,
      validThrough: validThrough.value,
      authorizationRequired: authorizationRequired.value,
      referralRequired: referralRequired.value,
      requestEvidenceVersionId: requestEvidenceVersionId.value,
      responseEvidenceVersionId: responseEvidenceVersionId.value,
    },
  }
}

// §10 — the whole freshness contract, in one place and with no hidden duration.
//
// A null boundary is UNKNOWN, not stale: nothing was recorded, so nothing has expired. Otherwise
// the answer is simply whether the evaluation instant has passed the boundary. There is no
// payer-specific window here and there never will be; if a governed rule later imposes a stricter
// duration, A5.8 evaluates it and records its own provenance without touching this record.
//
// FRESH says the boundary has not passed. It does not say ELIGIBLE, and STALE does not change what
// the verification reported: a stale ELIGIBLE record is still historically ELIGIBLE-at-response.
export function evaluateFreshness(validThrough: Date | null, asOf: Date): FreshnessState {
  if (validThrough === null) return 'UNKNOWN'
  return asOf.getTime() <= validThrough.getTime() ? 'FRESH' : 'STALE'
}

export function toFreshnessDto(validThrough: Date | null, asOf: Date): FreshnessDto {
  return { state: evaluateFreshness(validThrough, asOf), evaluatedAt: asOf.toISOString() }
}

export type StoredVerification = {
  id: string
  encounterId: string
  insuranceMembershipId: string
  serviceDate: Date
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  verificationMethod: string
  status: string
  requestedAt: Date | null
  respondedAt: Date
  validThrough: Date | null
  authorizationRequired: boolean | null
  referralRequired: boolean | null
  requestEvidenceVersionId: string | null
  responseEvidenceVersionId: string
  createdAt: Date
}

export function toVerificationDto(record: StoredVerification, asOf: Date): EligibilityVerificationDto {
  return {
    id: record.id,
    encounterId: record.encounterId,
    insuranceMembershipId: record.insuranceMembershipId,
    serviceDate: formatDateOnly(record.serviceDate) as string,
    payerId: record.payerId,
    tpaId: record.tpaId,
    networkId: record.networkId,
    insuranceProductId: record.insuranceProductId,
    verificationMethod: record.verificationMethod as VerificationMethod,
    status: record.status as VerificationStatus,
    requestedAt: record.requestedAt === null ? null : record.requestedAt.toISOString(),
    respondedAt: record.respondedAt.toISOString(),
    validThrough: record.validThrough === null ? null : record.validThrough.toISOString(),
    authorizationRequired: record.authorizationRequired,
    referralRequired: record.referralRequired,
    requestEvidenceVersionId: record.requestEvidenceVersionId,
    responseEvidenceVersionId: record.responseEvidenceVersionId,
    freshness: toFreshnessDto(record.validThrough, asOf),
    createdAt: record.createdAt.toISOString(),
  }
}

// The audit snapshot for a recorded verification. It proves the action happened and nothing more.
// The status, the commercial identities, the encounter and membership, the evidence version ids,
// the response timing and the requirement flags are all deliberately absent: an audit trail that
// carried them would become a second eligibility store, and eligibility facts alone reveal a
// patient's clinical and insurance situation.
export function verificationAuditSnapshot(record: { id: string; createdAt: Date }) {
  return { id: record.id, createdAt: record.createdAt.toISOString() }
}

// Exported so the developer check and the acceptance suite can describe the contract without
// re-declaring it.
export const freshnessContract = freshnessStates

// A5.2 — an EligibilityVerification is an immutable record of what a verification actually
// REPORTED for one Encounter, against the exact InsuranceMembership selected on that Encounter and
// the exact commercial context that membership carried at the time.
//
// It is not a status row. Re-verifying creates a new record; the earlier one is never rewritten.
// It never infers a result: a recorded coverage period that happens to contain the service date is
// registration truth, not eligibility, and a missing or failed response is UNKNOWN, never
// INELIGIBLE.
//
// A5.2 decides nothing about authorization, completeness, validation, readiness, claims or
// submission, and it never transports or interprets the evidence itself.

// The result the verification source reported. UNKNOWN is a first-class answer: it means the
// evidence supports only uncertainty, and it is never optimistically resolved to ELIGIBLE.
export const verificationStatuses = ['ELIGIBLE', 'INELIGIBLE', 'UNKNOWN'] as const
export type VerificationStatus = (typeof verificationStatuses)[number]

// How the result was obtained. ELECTRONIC describes the channel, not the existence of a production
// payer adapter — real transport belongs to A9.
export const verificationMethods = ['ELECTRONIC', 'PORTAL', 'MANUAL', 'OTHER'] as const
export type VerificationMethod = (typeof verificationMethods)[number]

// Derived at read time, never stored. FRESH means the recorded validity boundary has not passed;
// it does NOT mean ELIGIBLE. UNKNOWN means no boundary was recorded, which is not the same as
// stale — an unknown boundary is never assumed to have expired, nor assumed to still hold.
export const freshnessStates = ['FRESH', 'STALE', 'UNKNOWN'] as const
export type FreshnessState = (typeof freshnessStates)[number]

export type FreshnessDto = {
  state: FreshnessState
  // The instant this answer was computed for. It is part of the answer: the same verification is
  // FRESH now and STALE later, and a reader must be able to tell which moment was asked about.
  evaluatedAt: string
}

export type EligibilityVerificationDto = {
  id: string
  encounterId: string
  insuranceMembershipId: string
  // The service date and commercial identities exactly as they stood at verification time. A later
  // correction to the Encounter or the membership does not reach back into these.
  serviceDate: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  verificationMethod: VerificationMethod
  status: VerificationStatus
  requestedAt: string | null
  respondedAt: string
  validThrough: string | null
  // true, false or null. Null means the response did not supply the indicator, which is not the
  // same as an explicit false.
  authorizationRequired: boolean | null
  referralRequired: boolean | null
  // Exact A5.1 foreign keys only. No storage reference, content hash or document type is copied
  // here: the evidence version remains the single owner of what the response actually was.
  requestEvidenceVersionId: string | null
  responseEvidenceVersionId: string
  freshness: FreshnessDto
  createdAt: string
}

export type EligibilityVerificationListDto = {
  items: EligibilityVerificationDto[]
}

export type EligibilityVerificationErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN' | 'INTERNAL_ERROR'

export type EligibilityVerificationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: EligibilityVerificationErrorCode; message: string }

// The only fields a caller may supply. The Encounter comes from the route; the membership, service
// date and every commercial identity are derived by the server inside the write transaction.
export const verificationInputFields = [
  'verificationMethod',
  'status',
  'requestedAt',
  'respondedAt',
  'validThrough',
  'authorizationRequired',
  'referralRequired',
  'requestEvidenceVersionId',
  'responseEvidenceVersionId',
] as const

// Supplying any of these would let a caller choose the context a verification is judged against, or
// claim a freshness the data does not support. Each is refused by name rather than ignored, so a
// caller who believes they set it is told they did not.
export const verificationServerOwnedFields = [
  'id',
  'encounterId',
  'insuranceMembershipId',
  'serviceDate',
  'payerId',
  'tpaId',
  'networkId',
  'insuranceProductId',
  'freshness',
  'createdAt',
] as const

// What the server resolved inside the write transaction, after taking the Encounter and membership
// locks. It is the exact context the verification is recorded against.
export type VerificationContext = {
  encounterId: string
  insuranceMembershipId: string
  serviceDate: Date
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
}

export type VerificationInput = {
  verificationMethod: VerificationMethod
  status: VerificationStatus
  requestedAt: Date | null
  respondedAt: Date
  validThrough: Date | null
  authorizationRequired: boolean | null
  referralRequired: boolean | null
  requestEvidenceVersionId: string | null
  responseEvidenceVersionId: string
}

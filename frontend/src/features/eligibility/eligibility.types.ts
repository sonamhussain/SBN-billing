// FE-04 — the A5.2 eligibility verification contract: an immutable record of a result obtained outside
// SBN (electronic, portal, manual or other), with a server-derived freshness. Status and freshness are
// independent: FRESH does not mean ELIGIBLE, and UNKNOWN stays UNKNOWN. No record is "current".
export const verificationStatuses = ['ELIGIBLE', 'INELIGIBLE', 'UNKNOWN'] as const
export type VerificationStatus = (typeof verificationStatuses)[number]

export const verificationMethods = ['ELECTRONIC', 'PORTAL', 'MANUAL', 'OTHER'] as const
export type VerificationMethod = (typeof verificationMethods)[number]

export type EligibilityVerification = {
  id: string
  encounterId: string
  insuranceMembershipId: string
  serviceDate: string
  payerId: string
  verificationMethod: VerificationMethod
  status: VerificationStatus
  requestedAt: string | null
  respondedAt: string
  validThrough: string | null
  authorizationRequired: boolean | null
  referralRequired: boolean | null
  requestEvidenceVersionId: string | null
  responseEvidenceVersionId: string
  freshness: { state: 'FRESH' | 'STALE' | 'UNKNOWN'; evaluatedAt: string }
  createdAt: string
}

// The only fields a client records; the membership, payer and service-date context come from the Encounter.
export type EligibilityVerificationInput = {
  verificationMethod: VerificationMethod
  status: VerificationStatus
  requestedAt: string | null
  respondedAt: string
  validThrough: string | null
  authorizationRequired: boolean | null
  referralRequired: boolean | null
  requestEvidenceVersionId: string | null
  responseEvidenceVersionId: string
}

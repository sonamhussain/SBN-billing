// A6.2 — ClaimDiagnosis answers: which exact validated EncounterDiagnosis is carried into this Claim
// draft, in which Claim-specific order, with which explicit canonical role. The ICD code and text are
// never copied: a read derives them from the exact source EncounterDiagnosis and its DiagnosisCode.
//
// The role is a canonical claim construct captured exactly as the user chose it. It is never inferred
// from the Encounter's diagnosis order, and role count or applicability (for example "exactly one
// PRIMARY") is not decided here: A6.4 applies governed market rules and A9 maps external values.

export const CLAIM_DIAGNOSIS_CONTRACT_VERSION = 'A6-DX-1'

export const claimDiagnosisRoles = ['PRIMARY', 'SECONDARY', 'ADMITTING'] as const
export type ClaimDiagnosisRole = (typeof claimDiagnosisRoles)[number]

export type ClaimDiagnosisDto = {
  id: string
  claimId: string
  encounterDiagnosisId: string
  sequence: number
  roleCode: string
  claimDiagnosisContractVersion: string
  removedAt: string | null
  createdByUserId: string
  createdAt: string
  updatedAt: string
  // §10 — derived from the exact source by the owner join; never persisted on the ClaimDiagnosis.
  source: { diagnosisCodeId: string; code: string; displayName: string }
}

export type ClaimDiagnosisListDto = { items: ClaimDiagnosisDto[] }

// §12 BODY OWNERSHIP — the only fields a client may supply.
export const createDiagnosisBodyFields = ['encounterDiagnosisId', 'roleCode'] as const
export const orderDiagnosisBodyFields = ['claimDiagnosisIds'] as const
export const serverOwnedDiagnosisFields = [
  'id',
  'claimId',
  'encounterId',
  'sequence',
  'claimDiagnosisContractVersion',
  'removedAt',
  'createdByUserId',
  'createdAt',
  'updatedAt',
] as const

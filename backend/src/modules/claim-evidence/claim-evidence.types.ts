// A6.7 — the A6-EVIDENCE-1 evidence package answers one question: on exactly which historical owner rows
// (and versions) does ONE frozen, approved canonical payload rest? It is ordered, typed provenance only: no
// copied evidence bytes, display text or reason, no invented attachment requirement, and no statement that
// any outside party received anything. Evidence files stay with their A5 owner.

export const EVIDENCE_MANIFEST_VERSION = 'A6-EVIDENCE-1'

// §4 — the reference vocabulary in its fixed manifest order. Changing the order, a kind or a role is a new
// manifest version. The database holds the same rank (claim_freeze_evidence_kind_rank).
export const evidenceReferenceKinds = [
  'VALIDATION_RUN',
  'READINESS_ASSESSMENT',
  'VALIDATION_FINDING',
  'ENCOUNTER_ACTIVITY',
  'ENCOUNTER_DIAGNOSIS',
  'ELIGIBILITY_VERIFICATION',
  'PRIOR_AUTHORIZATION_VERSION',
  'AUTHORIZATION_LINE',
  'EVIDENCE_REQUIREMENT',
  'EVIDENCE_ARTIFACT_VERSION',
  'RULE_VERSION',
  'RULE_SOURCE_VERSION',
  'REFERENCE_DATASET_VERSION',
  'PRICING_RUN',
  'PRICING_LINE_RESULT',
  'DRAFT_ASSESSMENT',
  'REVIEW_EVENT',
] as const
export type EvidenceReferenceKind = (typeof evidenceReferenceKinds)[number]

export const evidenceRoles = [
  'VALIDATION_BASIS',
  'CLAIM_LINE_SOURCE',
  'CLAIM_DIAGNOSIS_SOURCE',
  'COVERAGE_BASIS',
  'AUTHORIZATION_BASIS',
  'DOCUMENTATION_BASIS',
  'RULE_PROVENANCE',
  'PRICING_BASIS',
  'DRAFT_BASIS',
  'HUMAN_APPROVAL',
] as const
export type EvidenceRole = (typeof evidenceRoles)[number]

// Each kind has exactly one role: why the frozen payload rests on that reference.
export const evidenceRoleOf: Record<EvidenceReferenceKind, EvidenceRole> = {
  VALIDATION_RUN: 'VALIDATION_BASIS',
  READINESS_ASSESSMENT: 'VALIDATION_BASIS',
  VALIDATION_FINDING: 'VALIDATION_BASIS',
  ENCOUNTER_ACTIVITY: 'CLAIM_LINE_SOURCE',
  ENCOUNTER_DIAGNOSIS: 'CLAIM_DIAGNOSIS_SOURCE',
  ELIGIBILITY_VERIFICATION: 'COVERAGE_BASIS',
  PRIOR_AUTHORIZATION_VERSION: 'AUTHORIZATION_BASIS',
  AUTHORIZATION_LINE: 'AUTHORIZATION_BASIS',
  EVIDENCE_REQUIREMENT: 'DOCUMENTATION_BASIS',
  EVIDENCE_ARTIFACT_VERSION: 'DOCUMENTATION_BASIS',
  RULE_VERSION: 'RULE_PROVENANCE',
  RULE_SOURCE_VERSION: 'RULE_PROVENANCE',
  REFERENCE_DATASET_VERSION: 'RULE_PROVENANCE',
  PRICING_RUN: 'PRICING_BASIS',
  PRICING_LINE_RESULT: 'PRICING_BASIS',
  DRAFT_ASSESSMENT: 'DRAFT_BASIS',
  REVIEW_EVENT: 'HUMAN_APPROVAL',
}

// The versioned kinds: the reference id is the owner's parent (prior authorization, evidence artifact,
// rule, rule source, reference dataset) and the version id is the exact version row. Every other kind is
// an immutable row of its own and carries no version id.
export const versionedEvidenceKinds: readonly EvidenceReferenceKind[] = ['PRIOR_AUTHORIZATION_VERSION', 'EVIDENCE_ARTIFACT_VERSION', 'RULE_VERSION', 'RULE_SOURCE_VERSION', 'REFERENCE_DATASET_VERSION']

// One reference before it is placed in the manifest. contentHash is the owner's own SHA-256, and only an
// evidence artifact version has one; it is null for every other kind (never invented).
export type EvidenceReference = {
  referenceKind: EvidenceReferenceKind
  referenceId: string
  referenceVersionId: string | null
  contentHash: string | null
}

export type EvidenceEntryV1 = {
  ordinal: number
  referenceKind: EvidenceReferenceKind
  referenceId: string
  referenceVersionId: string | null
  contentHash: string | null
  evidenceRole: EvidenceRole
}

// §4 — the A6-EVIDENCE-1 manifest: the freeze identity and payload digest, then the ordered entries.
export type EvidenceManifestV1 = {
  schemaVersion: typeof EVIDENCE_MANIFEST_VERSION
  claimId: string
  draftAssessmentId: string
  approvalReviewEventId: string
  pricingRunId: string
  payloadSha256: string
  entries: EvidenceEntryV1[]
}

export type FreezeIdentity = {
  claimId: string
  draftAssessmentId: string
  approvalReviewEventId: string
  pricingRunId: string
}

// The owners' parent ids and hashes of the versioned references, read on the freeze transaction. A missing
// key means the owner could not provide that exact historical version.
export type OwnerVersionFacts = {
  priorAuthorizationOfVersion: ReadonlyMap<string, string>
  evidenceArtifactOfVersion: ReadonlyMap<string, { evidenceArtifactId: string; contentHash: string }>
  ruleOfVersion: ReadonlyMap<string, string>
  sourceOfVersion: ReadonlyMap<string, string>
  datasetOfVersion: ReadonlyMap<string, string>
}

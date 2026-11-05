// CRG-01 FINAL, Checkpoint A — coding-release governance chooses, for one encounter code, the approved coding
// catalogue edition that governs it on the encounter's own service date and jurisdiction, checks the code against
// exactly that edition, and answers the decision with its full basis (edition, dataset, import, source artifact and
// membership fingerprints, source row). It reuses the A3 ReferenceDatasetVersion lifecycle as the edition authority; it never blocks a claim, changes
// an encounter, a finding or a freeze, imports a licensed catalogue, or treats the 2027 transition as verified law
// (Checkpoints B and C, and activation, are separately approved).

export const CODESET_CONTRACT_VERSION = 'CRG-CODESET-1'

// The controlled code-system identities named by the source (DHA GC 06-2026, register clause C1). A change is a
// versioned CRG-owned contract change.
export const codeSystems = ['ICD-10-CM', 'CPT', 'HCPCS-LEVEL-II'] as const
export type CodeSystem = (typeof codeSystems)[number]

// Which encounter subject each system codes: a diagnosis or a procedure.
export const subjectKinds = ['DIAGNOSIS', 'PROCEDURE'] as const
export type SubjectKind = (typeof subjectKinds)[number]
export const CODE_SYSTEM_SUBJECT: Record<CodeSystem, SubjectKind> = { 'ICD-10-CM': 'DIAGNOSIS', CPT: 'PROCEDURE', 'HCPCS-LEVEL-II': 'PROCEDURE' }

// A dataset's identity is (jurisdiction, authority, code system, purpose). One purpose in this checkpoint.
export const mappingPurposes = ['CLAIM_CODING'] as const
export type MappingPurpose = (typeof mappingPurposes)[number]

// Rights to use a code system in one jurisdiction and authority. No decision recorded means BLOCKED.
export const rightsStatuses = ['APPROVED', 'BLOCKED'] as const
export type RightsStatus = (typeof rightsStatuses)[number]

// What a RETIRED edition's retirement means for the dates it governed. Unclassified fails closed.
export const retirementClassifications = ['PROSPECTIVE', 'HISTORICALLY_INVALIDATED'] as const
export type RetirementClassification = (typeof retirementClassifications)[number]

// The decision for one code. A stored history that contradicts itself is not a decision: the whole read is refused
// with SOURCE_INTEGRITY_CONFLICT.
export const decisionCodes = ['APPLICABLE', 'CODE_NOT_IN_RELEASE', 'NO_APPROVED_RELEASE', 'CONFLICTING_RELEASES', 'RELEASE_NOT_AUTHORIZED', 'AMBIGUOUS_CODE_SYSTEM'] as const
export type DecisionCode = (typeof decisionCodes)[number]

// A canonical code value: upper case, no surrounding space, letters, digits, '.' and '-' only.
export const CANONICAL_CODE = /^[A-Z0-9][A-Z0-9.-]{0,31}$/
// A source row identifier: printable, no surrounding space, at most 64 characters.
export const SOURCE_ROW_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/
export const SHA256_HEX = /^[0-9a-f]{64}$/

// One A3 lifecycle transition of an edition, in its stored order.
export type LifecycleFact = { action: string; previousActivationStatus: string; nextActivationStatus: string; nextValidationStatus: string }

// One A3 edition as the resolver reads it: the dataset version, its dataset, the CRG mapping of that dataset, the
// version's immutable lifecycle history, its CRG import (if any) and its retirement classification (if any). Dates are
// YYYY-MM-DD strings.
export type EditionFacts = {
  datasetVersionId: string
  datasetId: string
  datasetJurisdictionCode: string
  datasetAuthorityCode: string
  mappingCodeSystem: string
  mappingPurpose: string
  mappingJurisdictionCode: string
  mappingAuthorityCode: string
  version: string
  effectiveFrom: string | null
  effectiveTo: string | null
  validationStatus: string
  activationStatus: string
  contentHash: string
  sourceVersionId: string | null
  lifecycle: LifecycleFact[]
  importId: string | null
  importSourceFileSha256: string | null
  importMembershipFingerprint: string | null
  importExpectedRowCount: number | null
  importRowCount: number
  retirementClassification: string | null
}

// The jurisdiction a code is judged in: the encounter's own facility regulatory profile, and the rights recorded for
// each code system there (latest decision; absent means BLOCKED).
export type ResolutionScope = { serviceDate: string; jurisdictionCode: string; authorityCode: string; rights: Partial<Record<CodeSystem, RightsStatus>> }

// The selected edition, exactly as returned.
export type EditionBasis = {
  referenceDatasetVersionId: string
  datasetId: string
  codeSystem: CodeSystem
  purpose: MappingPurpose
  edition: string
  effectiveFrom: string
  effectiveTo: string | null
  sourceVersionId: string | null
  // The source artifact's SHA-256 (the A3 content hash) and the normalized membership's own fingerprint: different
  // content, each verifiable on its own (audit CRG-F02).
  contentHash: string
  membershipFingerprintSha256: string
  importId: string
  activationStatus: string
  retirementClassification: RetirementClassification | null
}

export type EditionDecision =
  | { decisionCode: 'APPLICABLE'; edition: EditionBasis }
  | { decisionCode: 'NO_APPROVED_RELEASE' | 'CONFLICTING_RELEASES' | 'RELEASE_NOT_AUTHORIZED'; edition: null }

export type EditionResult = { ok: true; value: EditionDecision } | { ok: false; detail: string }

// A code's identity as the A2 master states it. A refusal says which decision it is: a code whose system or value
// cannot be established, or a diagnosis for which no diagnosis system governs this jurisdiction at all.
export type CodeIdentity = { ok: true; codeSystem: CodeSystem; code: string } | { ok: false; reason: string; decisionCode: 'AMBIGUOUS_CODE_SYSTEM' | 'NO_APPROVED_RELEASE' }

export type MembershipBasis = { membershipId: string; sourceRowId: string; sourceRowSha256: string; releaseContentHash: string }

export type CodeDecision = {
  decisionCode: DecisionCode
  codeSystem: CodeSystem | null
  edition: EditionBasis | null
  membership: MembershipBasis | null
}

// One encounter subject's answer: identifiers and controlled codes only. The code value itself is clinical and stays
// in its A2 owner; it is named by the A2 master id.
export type CodingReleaseItemDto = {
  subjectKind: SubjectKind
  subjectId: string
  masterCodeId: string
} & CodeDecision

export type CodingReleaseCheckDto = {
  contractVersion: string
  encounterId: string
  serviceDate: string
  jurisdictionCode: string
  authorityCode: string
  items: CodingReleaseItemDto[]
  evaluatedAt: string
}

// One membership row as the importer reads it from the source artifact: the record's source row identifier, its
// normalized code and the SHA-256 of the record's own bytes.
export type ImportRow = { sourceRowId: string; code: string; sourceRowSha256: string }

export type CodingReleaseErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'SOURCE_INTEGRITY_CONFLICT' | 'CODING_RELEASE_CONFLICT'
export type CodingReleaseResult<T> = { ok: true; value: T } | { ok: false; code: CodingReleaseErrorCode; message: string }

import { orderCorrectionChain } from '../claim-correction/claim-correction.chain.ts'
import { ADMISSIBLE_REASONS, BASES_OF_REASON, type AssessmentVerdict, type EstablishedBasis, type ExceptionReasonCode, type OwnerVerdict, type TimelineVerdict } from './exception-intake.types.ts'

// A8.1 §3/§5 — the one pure rule that says whether an owner's own facts prove a requested reason for one exact
// source, and by which controlled basis. An owner's refusal alone proves nothing: the reason's specific underlying
// condition must hold in the owners' stored facts. A caller's assertion, an owner's message text, an unexpected or
// future verdict, or any other refusal establishes nothing (fail closed). It never reads a clock, database, network
// or locale.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// UNLINKED_FROZEN_SUBMISSION — the A7.7 owner refused the Claim's history, the Claim has two or more freezes, the
// A6.9 owner's own chain logic accepts the Claim's links as one chain of this Claim's freezes, and at least one freeze
// lies outside that chain. The basis record is the latest such freeze by its database instant; a tie for latest is
// ambiguous and fails closed (never broken by identifier). A fork, join, cycle or second chain is refused by the A6.9
// logic and so establishes nothing here.
function unlinkedFrozenSubmission(verdict: TimelineVerdict): EstablishedBasis | null {
  if (verdict.timelineCode !== 'REVENUE_TIMELINE_PROVENANCE_CONFLICT') return null
  const freezeIds = new Set(verdict.freezes.map((freeze) => freeze.submissionId))
  if (verdict.freezes.length < 2 || freezeIds.size !== verdict.freezes.length) return null
  if (verdict.freezes.some((freeze) => !uuidShape.test(freeze.submissionId) || !Number.isFinite(freeze.frozenAtMicros))) return null
  const chain = orderCorrectionChain(verdict.links)
  if (!chain.ok || chain.submissions.some((id) => !freezeIds.has(id))) return null
  const chained = new Set(chain.submissions)
  const unlinked = verdict.freezes.filter((freeze) => !chained.has(freeze.submissionId))
  if (unlinked.length === 0) return null
  const latest = Math.max(...unlinked.map((freeze) => freeze.frozenAtMicros))
  const atLatest = unlinked.filter((freeze) => freeze.frozenAtMicros === latest)
  return atLatest.length === 1 ? { basisCode: 'UNLINKED_FROZEN_SUBMISSION', basisRecordId: atLatest[0].submissionId } : null
}

// HISTORICAL_RECORD_INCONSISTENT — the A7.6 owner refused the trace AND the stored assessment disagrees with its
// stored case in one of two specific ways, checked in the A7.6 owner's own order: organization first, then digest.
function assessmentCaseMismatch(verdict: AssessmentVerdict): EstablishedBasis | null {
  if (verdict.traceCode !== 'CLOSURE_BASIS_PROVENANCE_CONFLICT' || !uuidShape.test(verdict.caseId)) return null
  if (verdict.caseOrganizationId === null || verdict.caseManifestSha256 === null) return null
  if (verdict.caseOrganizationId !== verdict.assessmentOrganizationId) return { basisCode: 'ASSESSMENT_CASE_ORGANIZATION_MISMATCH', basisRecordId: verdict.caseId }
  if (verdict.assessmentCaseDigest !== verdict.caseManifestSha256) return { basisCode: 'ASSESSMENT_CASE_DIGEST_MISMATCH', basisRecordId: verdict.caseId }
  return null
}

// OPERATOR_REVIEW_REQUIRED — exactly the recorded REVIEW_REQUIRED assessment.
function assessmentReviewRequired(verdict: AssessmentVerdict): EstablishedBasis | null {
  return verdict.assessmentCode === 'REVIEW_REQUIRED' && uuidShape.test(verdict.assessmentId) ? { basisCode: 'ASSESSMENT_REVIEW_REQUIRED', basisRecordId: verdict.assessmentId } : null
}

export function establishedBasis(verdict: OwnerVerdict, reason: ExceptionReasonCode): EstablishedBasis | null {
  if (!ADMISSIBLE_REASONS[verdict.kind]?.includes(reason)) return null
  let basis: EstablishedBasis | null = null
  if (verdict.kind === 'REVENUE_TIMELINE') {
    if (reason === 'PROVENANCE_CONFLICT') basis = unlinkedFrozenSubmission(verdict)
  } else if (verdict.kind === 'CLOSURE_PREREQUISITE_ASSESSMENT') {
    if (reason === 'HISTORICAL_RECORD_INCONSISTENT') basis = assessmentCaseMismatch(verdict)
    else if (reason === 'OPERATOR_REVIEW_REQUIRED') basis = assessmentReviewRequired(verdict)
  }
  return basis !== null && BASES_OF_REASON[reason].includes(basis.basisCode) ? basis : null
}

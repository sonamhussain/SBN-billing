import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
// The owners A7.7 consumes, on THIS read snapshot and unchanged: A6.7 answers the Claim's organization and every
// freeze of the Claim; A6.9 answers its checked correction chain and each freeze's exact microsecond instant; A7.4
// each freeze's case headers and each case's organization; A7.5 each case's assessments and each assessment's
// organization; the database its own evaluation instant. Nothing is re-derived, locked or written, no A6.8
// disposition is read and no A7.6 trace is synthesized.
import { findClaimForFreeze, findFreezesOfClaim } from '../claim-submission/claim-submission.repository.ts'
import { getCorrectionChain } from '../claim-correction/claim-correction.service.ts'
import { findFreezeFacts } from '../claim-correction/claim-correction.repository.ts'
import { getCasesOf } from '../evidence-case/evidence-case.service.ts'
import { findCaseOwnership } from '../evidence-case/evidence-case.repository.ts'
import { getPrerequisiteAssessmentsOf } from '../case-prerequisite/case-prerequisite.service.ts'
import { findAssessmentOwnership } from '../case-prerequisite/case-prerequisite.repository.ts'
import { readTransactionTimestamp } from '../encounter-billing-context/encounter-billing-context.repository.ts'
import { composeTimeline } from './revenue-timeline.reducer.ts'
import { TIMELINE_CONTRACT_VERSION, type AssessmentFacts, type CaseFacts, type FreezeFacts, type TimelineDto, type TimelineServiceResult } from './revenue-timeline.types.ts'
import { isTimelineUuid } from './revenue-timeline.validation.ts'

// A7.7 §4/§5 — a timeline is composed from ONE read-only snapshot (REPEATABLE READ, READ ONLY):
// 1. the route has already resolved Claim -> Encounter -> Patient -> Organization, answered another tenant's Claim
//    exactly like a missing one, checked every read permission the timeline exposes and refused any selector or body;
// 2. the Claim, all its freezes, the A6.9 chain and instants, every case of every freeze and every assessment of
//    every case are read through their owners on the caller's snapshot — no Claim lock, no write transaction;
// 3. the pure composer orders the freezes by confirmed chain edges only and attaches each case and assessment to its
//    exact freeze; any contradiction is a provenance conflict and no partial timeline is returned;
// 4. the response carries the database's own evaluation instant. No row and no audit is written.

const invalid = (message: string): TimelineServiceResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })
const notFound = (): TimelineServiceResult<never> => ({ ok: false, code: 'NOT_FOUND', message: 'claim not found' })
const conflict = (message: string): TimelineServiceResult<never> => ({ ok: false, code: 'REVENUE_TIMELINE_PROVENANCE_CONFLICT', message })

// The timeline on the CALLER's snapshot — what later owners consult. Nothing is written.
export async function getRevenueTimelineOf(claimId: string, tx: DbClient): Promise<TimelineServiceResult<TimelineDto>> {
  if (!isTimelineUuid(claimId)) return invalid('invalid claim id')
  const id = claimId.toLowerCase()
  const claim = await findClaimForFreeze(id, tx)
  if (!claim) return notFound()

  const freezeRecords = await findFreezesOfClaim(id, tx)
  const chain = await getCorrectionChain(id, tx)
  // The A6.9 owner's own reason (fork, join, cycle, self-link, more than one chain) is kept: it is a controlled phrase.
  if (!chain.ok) return chain.code === 'NOT_FOUND' ? notFound() : conflict(`${chain.message}; nothing was composed`)

  const freezes: FreezeFacts[] = []
  const cases: CaseFacts[] = []
  const assessments: AssessmentFacts[] = []
  for (const record of freezeRecords) {
    // The stored instant comes from the A6.9 owner's epoch reading (microseconds computed in SQL), which no session time
    // zone can shift; the shown instant is that same value at millisecond precision.
    const instant = await findFreezeFacts(record.id, tx)
    const frozenAtMicros = instant ? instant.frozenAtMicros : Number.NaN
    freezes.push({ submissionId: record.id, claimId: record.claimId, frozenAt: Number.isFinite(frozenAtMicros) ? new Date(Math.floor(frozenAtMicros / 1000)).toISOString() : '', frozenAtMicros })
    const headers = await getCasesOf(record.id, tx)
    if (!headers.ok) return conflict("a frozen submission's cases could not be read from their owner; nothing was composed")
    for (const header of headers.value.items) {
      const caseOwner = await findCaseOwnership(header.caseId, tx)
      cases.push({
        caseId: header.caseId,
        claimSubmissionId: header.claimSubmissionId,
        organizationId: caseOwner?.organizationId ?? '',
        contractVersion: header.contractVersion,
        assemblyCode: header.assemblyCode,
        sourceCount: header.sourceCount,
        classifiedCount: header.classifiedCount,
        readinessCount: header.readinessCount,
        itemCount: header.itemCount,
        manifestSha256: header.manifestSha256,
      })
      const recorded = await getPrerequisiteAssessmentsOf(header.caseId, tx)
      if (!recorded.ok) return conflict("a case's assessments could not be read from their owner; nothing was composed")
      for (const assessment of recorded.value.items) {
        const assessmentOwner = await findAssessmentOwnership(assessment.assessmentId, tx)
        assessments.push({
          assessmentId: assessment.assessmentId,
          caseId: assessment.caseId,
          organizationId: assessmentOwner?.organizationId ?? '',
          contractVersion: assessment.contractVersion,
          assessmentCode: assessment.assessmentCode,
          basisCode: assessment.basisCode,
          caseManifestSha256: assessment.caseManifestSha256,
        })
      }
    }
  }

  const composed = composeTimeline({
    claimId: id,
    organizationId: claim.organizationId,
    freezes,
    links: chain.value.items.map((link) => ({ correctionLinkId: link.correctionLinkId, claimId: link.claimId, priorSubmissionId: link.priorSubmissionId, correctedSubmissionId: link.correctedSubmissionId })),
    cases,
    assessments,
  })
  if (!composed.ok) return conflict(`${composed.detail}; nothing was composed`)
  const evaluatedAt = await readTransactionTimestamp(tx)
  return {
    ok: true,
    value: {
      contractVersion: TIMELINE_CONTRACT_VERSION,
      claimId: id,
      evaluatedAt: evaluatedAt.toISOString(),
      chainCode: composed.value.chainCode,
      submissions: composed.value.submissions,
      historyCount: composed.value.submissions.length,
    },
  }
}

// The public read, from one READ ONLY snapshot.
export async function getRevenueTimeline(claimId: string): Promise<TimelineServiceResult<TimelineDto>> {
  if (!isTimelineUuid(claimId)) return invalid('invalid claim id')
  return withReadSnapshot(undefined, (tx) => getRevenueTimelineOf(claimId, tx))
}

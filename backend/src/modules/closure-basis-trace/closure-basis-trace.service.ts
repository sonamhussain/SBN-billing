import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
// The owners A7.6 consumes, on THIS read snapshot and unchanged: A7.5 answers the exact assessment and the lock-free
// ownership chain of its case (case -> frozen submission -> Claim -> Encounter -> Patient organization); A7.4 the
// exact case header and its ordered entries; A7.1 the frozen submission's registrations (identifiers only); A7.3 the
// stored readiness of each linked classification; the database its own evaluation instant. Nothing is re-derived,
// locked or written.
import { findAssessmentById, findCaseForPrerequisite } from '../case-prerequisite/case-prerequisite.repository.ts'
import type { AssessmentCode, BasisCode } from '../case-prerequisite/case-prerequisite.types.ts'
import { findCaseById } from '../evidence-case/evidence-case.repository.ts'
import { getReadinessOf } from '../evidence-gate/evidence-gate.service.ts'
import { getRevenueSourceEvidenceOf } from '../revenue-evidence/revenue-evidence.service.ts'
import { readTransactionTimestamp } from '../encounter-billing-context/encounter-billing-context.repository.ts'
import { traceClosureBasis } from './closure-basis-trace.reducer.ts'
import { TRACE_CONTRACT_VERSION, type BasisTraceDto, type ReadinessFacts, type TraceServiceResult } from './closure-basis-trace.types.ts'
import { isTraceUuid } from './closure-basis-trace.validation.ts'

// A7.6 §4 — a basis trace is computed from ONE read-only snapshot (REPEATABLE READ, READ ONLY):
// 1. the route has already resolved Assessment -> Case -> Freeze -> Claim -> Organization, answered another tenant's
//    assessment exactly like a missing one, and checked evidenceCasePrereq.read;
// 2. the assessment, the organization chain of its case, the exact case and entries, the frozen submission's
//    registrations and the stored readiness of every linked classification are read through their owners on the
//    caller's snapshot — no Claim lock, no write transaction;
// 3. the pure reducer explains every stored item and requires the explained outcome to be the recorded one; any
//    disagreement is a provenance conflict, never a guess;
// 4. the response carries the database's own evaluation instant. No row and no audit is written, on success or
//    refusal.

const invalid = (message: string): TraceServiceResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })
const notFound = (): TraceServiceResult<never> => ({ ok: false, code: 'NOT_FOUND', message: 'closure-prerequisite assessment not found' })
const conflict = (message: string): TraceServiceResult<never> => ({ ok: false, code: 'CLOSURE_BASIS_PROVENANCE_CONFLICT', message })

// The basis trace on the CALLER's snapshot — what later owners consult. Nothing is written.
export async function getClosureBasisTraceOf(assessmentId: string, tx: DbClient): Promise<TraceServiceResult<BasisTraceDto>> {
  if (!isTraceUuid(assessmentId)) return invalid('invalid closure-prerequisite assessment id')
  const assessment = await findAssessmentById(assessmentId.toLowerCase(), tx)
  if (!assessment) return notFound()
  const chain = await findCaseForPrerequisite(assessment.evidenceCaseId, tx)
  if (!chain || chain.organizationId !== assessment.organizationId || chain.submissionOrganizationId !== assessment.organizationId)
    return conflict('the assessment, its case and its frozen submission do not belong to one organization; nothing was explained')
  const stored = await findCaseById(assessment.evidenceCaseId, tx)
  if (!stored) return conflict('the assessed case could not be read from its owner; nothing was explained')
  const registrations = await getRevenueSourceEvidenceOf(stored.claimSubmissionId, tx)
  if (!registrations.ok) return conflict("the case's frozen submission registrations could not be read from their owner; nothing was explained")
  const readiness: ReadinessFacts[] = []
  for (const classificationId of new Set(stored.entries.filter((entry) => entry.itemReasonCode === 'LINKED' && entry.classificationId !== null).map((entry) => entry.classificationId as string))) {
    const results = await getReadinessOf(classificationId, tx)
    if (!results.ok) return conflict('a linked readiness result could not be read from its owner; nothing was explained')
    readiness.push(...results.value.items)
  }

  const traced = traceClosureBasis({
    assessment: {
      assessmentId: assessment.id,
      caseId: assessment.evidenceCaseId,
      organizationId: assessment.organizationId,
      contractVersion: assessment.contractVersion,
      assessmentCode: assessment.assessmentCode,
      basisCode: assessment.basisCode,
      caseManifestSha256: assessment.caseManifestSha256,
    },
    header: { ...stored, caseId: stored.id },
    entries: stored.entries,
    readiness,
    submissionSourceIds: registrations.value.items.map((item) => item.revenueSourceEvidenceId),
  })
  if (!traced.ok) return conflict(`${traced.detail}; nothing was explained`)
  const evaluatedAt = await readTransactionTimestamp(tx)
  return {
    ok: true,
    value: {
      contractVersion: TRACE_CONTRACT_VERSION,
      assessmentId: assessment.id,
      caseId: stored.id,
      caseManifestSha256: stored.manifestSha256,
      assessmentCode: assessment.assessmentCode as AssessmentCode,
      basisCode: assessment.basisCode as BasisCode,
      sourceCount: stored.sourceCount,
      itemCount: stored.itemCount,
      traceCode: traced.value.traceCode,
      traceItems: traced.value.traceItems,
      evaluatedAt: evaluatedAt.toISOString(),
    },
  }
}

// The public read, from one READ ONLY snapshot.
export async function getClosureBasisTrace(assessmentId: string): Promise<TraceServiceResult<BasisTraceDto>> {
  if (!isTraceUuid(assessmentId)) return invalid('invalid closure-prerequisite assessment id')
  return withReadSnapshot(undefined, (tx) => getClosureBasisTraceOf(assessmentId, tx))
}

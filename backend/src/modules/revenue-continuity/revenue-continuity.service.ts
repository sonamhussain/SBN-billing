import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
// The two owners A7.9 consumes, on THIS read snapshot and unchanged: the A7.7 timeline (the authoritative ordered
// history) and the A7.8 delta (the authoritative adjacent comparison). A7.9 never rebuilds either, never queries their
// tables, re-assesses, creates a trace, locks or writes.
import { getRevenueTimelineOf } from '../revenue-timeline/revenue-timeline.service.ts'
import { getRevenueDeltaOf } from '../revenue-delta/revenue-delta.service.ts'
import { deriveRevenueContinuity } from './revenue-continuity.reducer.ts'
import { CONTINUITY_CONTRACT_VERSION, type ContinuityDto, type ContinuityServiceResult } from './revenue-continuity.types.ts'
import { isContinuityUuid } from './revenue-continuity.validation.ts'

// A7.9 §4/§5 — a continuity result is derived from ONE read-only snapshot (REPEATABLE READ, READ ONLY):
// 1. the route has already resolved Claim -> Organization, answered another tenant's Claim exactly like a missing one,
//    checked the A7.7/A7.8 read permissions and refused any selector or body;
// 2. the A7.7 owner composes the timeline and the A7.8 owner the delta, both on the caller's snapshot; a corrupt
//    history is their conflict, kept;
// 3. both carry the snapshot's own evaluation instant, which must be the same one;
// 4. the pure reducer proves that the two describe the same history and reports one controlled gap per freeze; any
//    disagreement is a provenance conflict and no partial result is returned. No row and no audit is written.

const invalid = (message: string): ContinuityServiceResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })
const conflict = (message: string): ContinuityServiceResult<never> => ({ ok: false, code: 'REVENUE_CONTINUITY_PROVENANCE_CONFLICT', message })

type OwnerFailure = { ok: false; code: string; message: string }
const ownerFailure = (failure: OwnerFailure): ContinuityServiceResult<never> =>
  failure.code === 'NOT_FOUND' ? { ok: false, code: 'NOT_FOUND', message: 'claim not found' } : failure.code === 'VALIDATION_ERROR' ? invalid(failure.message) : conflict(failure.message)

// The continuity result on the CALLER's snapshot — what later owners consult. Nothing is written.
export async function getRevenueContinuityOf(claimId: string, tx: DbClient): Promise<ContinuityServiceResult<ContinuityDto>> {
  if (!isContinuityUuid(claimId)) return invalid('invalid claim id')
  const timeline = await getRevenueTimelineOf(claimId, tx)
  if (!timeline.ok) return ownerFailure(timeline)
  const delta = await getRevenueDeltaOf(claimId, tx)
  if (!delta.ok) return ownerFailure(delta)
  if (delta.value.evaluatedAt !== timeline.value.evaluatedAt) return conflict('the timeline and the delta were not read on one snapshot; nothing was reconciled')
  const derived = deriveRevenueContinuity(timeline.value, delta.value)
  if (!derived.ok) return conflict(`${derived.detail}; nothing was reconciled`)
  return {
    ok: true,
    value: {
      contractVersion: CONTINUITY_CONTRACT_VERSION,
      claimId: timeline.value.claimId,
      evaluatedAt: timeline.value.evaluatedAt,
      continuityCode: derived.value.continuityCode,
      submissionCount: derived.value.submissionCount,
      comparisonCount: derived.value.comparisonCount,
      gaps: derived.value.gaps,
      sourceTimelineContractVersion: timeline.value.contractVersion,
      sourceDeltaContractVersion: delta.value.contractVersion,
    },
  }
}

// The public read, from one READ ONLY snapshot.
export async function getRevenueContinuity(claimId: string): Promise<ContinuityServiceResult<ContinuityDto>> {
  if (!isContinuityUuid(claimId)) return invalid('invalid claim id')
  return withReadSnapshot(undefined, (tx) => getRevenueContinuityOf(claimId, tx))
}

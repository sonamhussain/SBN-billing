import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
// The one owner A7.8 consumes, on THIS read snapshot and unchanged: the A7.7 timeline, which already reads the A6.7
// freezes, the A6.9 checked chain and instants, the A7.4 cases and the A7.5 assessments through their owners and
// refuses any contradiction. A7.8 never rebuilds that history, re-assesses, creates a trace, locks or writes.
import { getRevenueTimelineOf } from '../revenue-timeline/revenue-timeline.service.ts'
import { deriveRevenueDelta } from './revenue-delta.reducer.ts'
import { DELTA_CONTRACT_VERSION, type DeltaDto, type DeltaServiceResult } from './revenue-delta.types.ts'
import { isDeltaUuid } from './revenue-delta.validation.ts'

// A7.8 §4/§5 — a delta is derived from ONE read-only snapshot (REPEATABLE READ, READ ONLY):
// 1. the route has already resolved Claim -> Organization, answered another tenant's Claim exactly like a missing one,
//    checked the A7.7 read permissions and refused any selector or body;
// 2. the A7.7 owner composes the exact timeline on the caller's snapshot; a corrupt history is its conflict, kept;
// 3. the pure reducer re-validates that timeline and compares each adjacent pair's recorded summaries; any
//    disagreement is a provenance conflict and no partial delta is returned;
// 4. the response carries the snapshot's own evaluation instant (the timeline's). No row and no audit is written.

const invalid = (message: string): DeltaServiceResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })
const conflict = (message: string): DeltaServiceResult<never> => ({ ok: false, code: 'REVENUE_DELTA_PROVENANCE_CONFLICT', message })

// The delta on the CALLER's snapshot — what later owners consult. Nothing is written.
export async function getRevenueDeltaOf(claimId: string, tx: DbClient): Promise<DeltaServiceResult<DeltaDto>> {
  if (!isDeltaUuid(claimId)) return invalid('invalid claim id')
  const timeline = await getRevenueTimelineOf(claimId, tx)
  if (!timeline.ok) {
    if (timeline.code === 'NOT_FOUND') return { ok: false, code: 'NOT_FOUND', message: 'claim not found' }
    if (timeline.code === 'VALIDATION_ERROR') return invalid(timeline.message)
    return conflict(timeline.message)
  }
  const derived = deriveRevenueDelta(timeline.value)
  if (!derived.ok) return conflict(`${derived.detail}; nothing was compared`)
  return {
    ok: true,
    value: {
      contractVersion: DELTA_CONTRACT_VERSION,
      claimId: timeline.value.claimId,
      evaluatedAt: timeline.value.evaluatedAt,
      baselineCode: derived.value.baselineCode,
      comparisonCount: derived.value.comparisons.length,
      comparisons: derived.value.comparisons,
    },
  }
}

// The public read, from one READ ONLY snapshot.
export async function getRevenueDelta(claimId: string): Promise<DeltaServiceResult<DeltaDto>> {
  if (!isDeltaUuid(claimId)) return invalid('invalid claim id')
  return withReadSnapshot(undefined, (tx) => getRevenueDeltaOf(claimId, tx))
}

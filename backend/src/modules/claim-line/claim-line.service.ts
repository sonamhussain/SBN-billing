import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { CLAIM_CONTRACT_VERSION } from '../claim/claim.types.ts'
// A5.9 owns the readiness, policy and recency decision. Every A6.2 write calls its transaction-aware
// composer — the same one A6.1 Claim creation uses — and never re-implements any part of it.
import { composeA6Handoff } from '../pre-claim-readiness/pre-claim-readiness.service.ts'
import { HANDOFF_SCHEMA_VERSION, type PreClaimReadinessErrorCode } from '../pre-claim-readiness/pre-claim-readiness.types.ts'
import {
  createClaimLineRecord,
  createClaimLineSource,
  createPointers,
  findActiveClaimLines,
  findActiveLineForSource,
  findActivePointersForLine,
  findClaimDiagnosisTargets,
  findClaimForStructure,
  findClaimLineById,
  findClaimLineLocation,
  findEncounterActivitySource,
  markClaimLineRemoved,
  markPointersRemoved,
  setClaimLineSequence,
} from './claim-line.repository.ts'
import {
  CLAIM_LINE_CONTRACT_VERSION,
  SEQUENCE_PARKING_OFFSET,
  type ClaimLineDto,
  type ClaimLineListDto,
  type ClaimStructureErrorCode,
  type ClaimStructureResult,
} from './claim-line.types.ts'
import {
  checkActiveOrder,
  isClaimStructureUuid,
  planCompaction,
  planPointerChanges,
  planReorder,
  validateCreateLineBody,
  validateLineOrderBody,
  validatePointerBody,
  validateRemoveBody,
  type SequenceChange,
} from './claim-line.validation.ts'

// A6.2 §8/§9/§11 — ClaimLine create, list, reorder and remove, and the exact-set line diagnosis
// pointers. Every write runs the shared Claim structure gate below; nothing here prices, approves,
// serializes or submits.

// ---- the shared Claim structure write gate (§8, §17) ---------------------------------------------

// A refusal is thrown, never returned from inside the transaction, so a refused write always rolls back
// and can never commit a partial change.
export class ClaimStructureRefusal extends Error {
  readonly code: ClaimStructureErrorCode
  constructor(code: ClaimStructureErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export function refuse(code: ClaimStructureErrorCode, message: string): never {
  throw new ClaimStructureRefusal(code, message)
}

export const invalid = (message: string): ClaimStructureResult<never> => ({ ok: false, code: 'VALIDATION_ERROR', message })

export type ClaimStructureGate = {
  claimId: string
  encounterId: string
  organizationId: string
  // §8 — the exact source ids the bound PreClaimA6HandoffV1 authorizes. Nothing outside them may enter.
  encounterActivityIds: ReadonlySet<string>
  encounterDiagnosisIds: ReadonlySet<string>
}

// The A5.9 handoff refusals, restated in the A6.2 contract's vocabulary. A Claim binds only a READY
// assessment of its own Encounter and that assessment is immutable, so any other answer means the stored
// chain disagrees with the Claim: it is refused, never repaired.
const handoffRefusal: Record<PreClaimReadinessErrorCode, ClaimStructureErrorCode> = {
  READINESS_SUPERSEDED_BY_NEWER_VALIDATION: 'READINESS_SUPERSEDED_BY_NEWER_VALIDATION',
  VALIDATION_RUN_RECENCY_AMBIGUOUS: 'VALIDATION_RUN_RECENCY_AMBIGUOUS',
  READINESS_POLICY_INCOMPATIBLE: 'CLAIM_HANDOFF_INCOMPATIBLE',
  PRECLAIM_NOT_READY_FOR_HANDOFF: 'CLAIM_BINDING_INTEGRITY_CONFLICT',
  NOT_FOUND: 'CLAIM_BINDING_INTEGRITY_CONFLICT',
  VALIDATION_ERROR: 'CLAIM_BINDING_INTEGRITY_CONFLICT',
  INTEGRITY_CONFLICT: 'CLAIM_BINDING_INTEGRITY_CONFLICT',
}

const incompatibleMessage = 'the A6-LINE-1 and A6-DX-1 contracts do not accept this claim contract, readiness policy, validator version or handoff contract'
const bindingConflictMessage = 'the claim binding does not agree with its readiness assessment chain; nothing was written'

// Lock the Claim row, then decide on this transaction's own snapshot: the Claim's A6.1 binding, the A5.9
// handoff of its exact assessment (still READY, compatible, not superseded and not tied) and the exact
// reference set that authorizes sources. Every A6.2 writer of one Claim serializes here.
export async function openClaimStructureGate(claimId: string, probe: string, tx: DbClient): Promise<ClaimStructureGate> {
  if (!(await lockRowForUpdate(tx, 'claims', claimId))) refuse('NOT_FOUND', 'claim not found')
  await concurrencyProbe(probe)
  const claim = await findClaimForStructure(claimId, tx)
  if (!claim) return refuse('NOT_FOUND', 'claim not found')
  if (claim.claimContractVersion !== CLAIM_CONTRACT_VERSION || claim.handoffSchemaVersion !== HANDOFF_SCHEMA_VERSION) refuse('CLAIM_HANDOFF_INCOMPATIBLE', incompatibleMessage)

  const handoff = await composeA6Handoff(claim.preClaimReadinessAssessmentId, tx)
  if (!handoff.ok) {
    const code = handoffRefusal[handoff.code]
    return refuse(code, code === 'CLAIM_HANDOFF_INCOMPATIBLE' ? incompatibleMessage : code === 'CLAIM_BINDING_INTEGRITY_CONFLICT' ? bindingConflictMessage : handoff.message)
  }
  if (handoff.value.schemaVersion !== claim.handoffSchemaVersion) refuse('CLAIM_HANDOFF_INCOMPATIBLE', incompatibleMessage)
  if (handoff.value.readinessAssessmentId !== claim.preClaimReadinessAssessmentId || handoff.value.validationRun.encounterId !== claim.encounterId)
    refuse('CLAIM_BINDING_INTEGRITY_CONFLICT', bindingConflictMessage)

  return {
    claimId: claim.id,
    encounterId: claim.encounterId,
    organizationId: claim.encounter.patient.organizationId,
    encounterActivityIds: new Set(handoff.value.exactReferences.encounterActivityIds),
    encounterDiagnosisIds: new Set(handoff.value.exactReferences.encounterDiagnosisIds),
  }
}

const MAX_STRUCTURE_WRITE_ATTEMPTS = 3

// Postgres reports a serialization failure (40001) when this transaction's snapshot was overtaken by a
// competing writer of the same Claim; Prisma surfaces it as P2034.
const isWriteConflict = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034' || error.code === 'P2002')) ||
  (error instanceof Error && /could not serialize access|40001/.test(error.message))

// The database guards are the backstop behind every service check; their refusals keep the contract's
// codes.
const databaseGuardCodes: [string, ClaimStructureErrorCode][] = [
  ['claim_source_not_in_handoff', 'CLAIM_SOURCE_NOT_IN_HANDOFF'],
  ['claim_source_encounter_mismatch', 'CLAIM_SOURCE_ENCOUNTER_MISMATCH'],
  ['claim_line_source_already_active', 'CLAIM_LINE_SOURCE_ALREADY_ACTIVE'],
  ['claim_diagnosis_pointer_mismatch', 'CLAIM_DIAGNOSIS_POINTER_MISMATCH'],
  ['claim_structure_inactive', 'CLAIM_STRUCTURE_INACTIVE'],
]

// §8/§17 — one read-write transaction per public mutation. It runs SERIALIZABLE: the REPEATABLE READ
// snapshot the handoff composer needs, plus Postgres's guarantee that a writer whose snapshot predates a
// competing writer's commit on the same Claim is rolled back instead of deciding on stale rows (a row
// lock alone cannot give that, because the snapshot is taken before the lock is granted). A rolled-back
// attempt is retried a bounded number of times on a fresh snapshot.
export async function runClaimStructureWrite<T>(work: (tx: DbClient) => Promise<T>): Promise<ClaimStructureResult<T>> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const value = await prisma.$transaction((tx) => work(tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 60_000,
      })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof ClaimStructureRefusal) return { ok: false, code: error.code, message: error.message }
      if (isWriteConflict(error)) {
        if (attempt < MAX_STRUCTURE_WRITE_ATTEMPTS) continue
        return { ok: false, code: 'CLAIM_STRUCTURE_WRITE_CONFLICT', message: 'concurrent changes to this claim kept conflicting; nothing was written' }
      }
      const guard = error instanceof Error ? databaseGuardCodes.find(([marker]) => error.message.includes(marker)) : undefined
      if (guard) return { ok: false, code: guard[1], message: 'the database refused the claim structure change; nothing was written' }
      throw error
    }
  }
}

// §9 — two-phase position rewrite: park every moving row far outside the live range, then write its
// final position, so no intermediate state collides with the active (claim_id, sequence) unique index.
export async function applySequenceChanges(changes: SequenceChange[], setSequence: (id: string, sequence: number, db: DbClient) => Promise<unknown>, db: DbClient) {
  for (const change of changes) await setSequence(change.id, SEQUENCE_PARKING_OFFSET + change.from, db)
  for (const change of changes) await setSequence(change.id, change.to, db)
}

// ---- DTOs and audit snapshots --------------------------------------------------------------------

type LineRecord = NonNullable<Awaited<ReturnType<typeof findClaimLineById>>>

// A6-LINE-1 lines have exactly one source; a stored violation is a defect and is refused, never shown.
function toClaimLineDto(record: LineRecord): ClaimLineDto {
  if (record.sources.length !== 1) refuse('INTEGRITY_CONFLICT', 'a stored claim line does not have exactly one source activity')
  const activity = record.sources[0].encounterActivity
  return {
    id: record.id,
    claimId: record.claimId,
    sequence: record.sequence,
    claimLineContractVersion: record.claimLineContractVersion,
    removedAt: record.removedAt ? record.removedAt.toISOString() : null,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    source: {
      encounterActivityId: activity.id,
      serviceId: activity.serviceId,
      procedureCodeId: activity.procedureCodeId,
      quantity: activity.quantity.toFixed(),
      unitCode: activity.unitCode,
      modifierCodes: activity.modifiers.map((modifier) => modifier.code),
    },
    claimDiagnosisIds: [...record.diagnosisPointers]
      .sort((a, b) => a.claimDiagnosis.sequence - b.claimDiagnosis.sequence || a.claimDiagnosisId.localeCompare(b.claimDiagnosisId))
      .map((pointer) => pointer.claimDiagnosisId),
  }
}

// Locked active lines, verified 1..N — never repaired.
async function activeLines(claimId: string, db: DbClient) {
  const rows = await findActiveClaimLines(claimId, db)
  const order = checkActiveOrder(rows)
  if (!order.ok) refuse('INTEGRITY_CONFLICT', order.message)
  return rows
}

async function lineDto(id: string, db: DbClient) {
  const record = await findClaimLineById(id, db)
  if (!record) return refuse('NOT_FOUND', 'claim line not found')
  return toClaimLineDto(record)
}

// §15 — what was added, under which contract and when; never the source activity, its codes, quantity or
// modifiers.
const lineAddedSnapshot = (record: { id: string; sequence: number; claimLineContractVersion: string; createdAt: Date }) => ({
  id: record.id,
  sequence: record.sequence,
  claimLineContractVersion: record.claimLineContractVersion,
  createdAt: record.createdAt.toISOString(),
})

// ---- create (§9) ---------------------------------------------------------------------------------

export async function createClaimLine(claimId: string, body: unknown, actorUserId: string): Promise<ClaimStructureResult<ClaimLineDto>> {
  if (!isClaimStructureUuid(claimId)) return invalid('invalid claim id')
  const validated = validateCreateLineBody(body)
  if (!validated.ok) return invalid(validated.message)
  const { encounterActivityId } = validated.value

  return runClaimStructureWrite(async (tx) => {
    const gate = await openClaimStructureGate(claimId, 'claimLine.create', tx)
    const active = await activeLines(claimId, tx)

    // A missing and a foreign activity are refused identically, so a caller never learns that another
    // organization's activity exists.
    const source = await findEncounterActivitySource(encounterActivityId, tx)
    if (!source || source.organizationId !== gate.organizationId) refuse('NOT_FOUND', 'encounter activity not found')
    if (source.encounterId !== gate.encounterId) refuse('CLAIM_SOURCE_ENCOUNTER_MISMATCH', 'the encounter activity does not belong to the claim encounter')
    if (!gate.encounterActivityIds.has(encounterActivityId)) refuse('CLAIM_SOURCE_NOT_IN_HANDOFF', 'the encounter activity is not in the bound handoff reference set')
    if (await findActiveLineForSource(claimId, encounterActivityId, tx)) refuse('CLAIM_LINE_SOURCE_ALREADY_ACTIVE', 'another active line of this claim already carries this encounter activity')

    const line = await createClaimLineRecord({ claimId, sequence: active.length + 1, claimLineContractVersion: CLAIM_LINE_CONTRACT_VERSION, createdByUserId: actorUserId }, tx)
    await createClaimLineSource({ claimLineId: line.id, encounterActivityId }, tx)
    await concurrencyProbe('claimLine.inserted')
    await recordAuditEvent(
      { organizationId: gate.organizationId, actorUserId, actionCode: 'claim_line.added', entityType: 'CLAIM_LINE', entityId: line.id, beforeState: null, afterState: lineAddedSnapshot(line) },
      tx,
    )
    await concurrencyProbe('claimLine.audited')
    return lineDto(line.id, tx)
  })
}

// ---- list (§9) -----------------------------------------------------------------------------------

// Read-only, one snapshot, active lines in Claim order. History stays in the database; reads never pass
// the write gate and never write an audit.
export async function listClaimLines(claimId: string): Promise<ClaimStructureResult<ClaimLineListDto>> {
  if (!isClaimStructureUuid(claimId)) return invalid('invalid claim id')
  try {
    return await withReadSnapshot(undefined, async (tx) => {
      if (!(await findClaimForStructure(claimId, tx))) return { ok: false as const, code: 'NOT_FOUND' as const, message: 'claim not found' }
      const rows = await activeLines(claimId, tx)
      return { ok: true as const, value: { items: rows.map(toClaimLineDto) } }
    })
  } catch (error) {
    if (error instanceof ClaimStructureRefusal) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

// ---- reorder (§9) --------------------------------------------------------------------------------

export async function reorderClaimLines(claimId: string, body: unknown, actorUserId: string): Promise<ClaimStructureResult<ClaimLineListDto>> {
  if (!isClaimStructureUuid(claimId)) return invalid('invalid claim id')
  const validated = validateLineOrderBody(body)
  if (!validated.ok) return invalid(validated.message)

  return runClaimStructureWrite(async (tx) => {
    const gate = await openClaimStructureGate(claimId, 'claimLine.reorder', tx)
    const active = await activeLines(claimId, tx)
    // A missing, extra, removed or foreign id gets the same answer and discloses nothing.
    const plan = planReorder(active, validated.value, 'claimLineIds')
    if (!plan.ok) return refuse('VALIDATION_ERROR', plan.message)
    // The identical order is a no-op: nothing is written and nothing is audited.
    if (plan.value.length === 0) return { items: active.map(toClaimLineDto) }

    await applySequenceChanges(plan.value, setClaimLineSequence, tx)
    await recordAuditEvent(
      {
        organizationId: gate.organizationId,
        actorUserId,
        actionCode: 'claim_line.reordered',
        entityType: 'CLAIM',
        entityId: claimId,
        beforeState: { claimLineIds: active.map((row) => row.id) },
        afterState: { claimLineIds: validated.value },
      },
      tx,
    )
    return { items: (await activeLines(claimId, tx)).map(toClaimLineDto) }
  })
}

// ---- remove (§9) ---------------------------------------------------------------------------------

export async function removeClaimLine(id: string, body: unknown, actorUserId: string): Promise<ClaimStructureResult<ClaimLineDto>> {
  if (!isClaimStructureUuid(id)) return invalid('invalid claim line id')
  const validated = validateRemoveBody(body)
  if (!validated.ok) return invalid(validated.message)

  return runClaimStructureWrite(async (tx) => {
    const located = await findClaimLineLocation(id, tx)
    if (!located) return refuse('NOT_FOUND', 'claim line not found')
    const gate = await openClaimStructureGate(located.claimId, 'claimLine.remove', tx)
    const current = await findClaimLineById(id, tx)
    if (!current) return refuse('NOT_FOUND', 'claim line not found')
    // Removal is one-way; removing again is refused and writes nothing.
    if (current.removedAt !== null) refuse('CLAIM_STRUCTURE_INACTIVE', 'this claim line is already removed')
    const active = await activeLines(located.claimId, tx)

    // §9 — the line's active pointers end with it, in the same transaction and under the same event.
    await markPointersRemoved((await findActivePointersForLine(id, tx)).map((pointer) => pointer.id), tx)
    const removed = await markClaimLineRemoved(id, tx)
    await applySequenceChanges(planCompaction(active.filter((row) => row.id !== id)), setClaimLineSequence, tx)
    await concurrencyProbe('claimLine.removed')
    await recordAuditEvent(
      {
        organizationId: gate.organizationId,
        actorUserId,
        actionCode: 'claim_line.removed',
        entityType: 'CLAIM_LINE',
        entityId: id,
        beforeState: { id, removedAt: null },
        afterState: { id, removedAt: removed.removedAt ? removed.removedAt.toISOString() : null },
      },
      tx,
    )
    return lineDto(id, tx)
  })
}

// ---- diagnosis pointers (§11) --------------------------------------------------------------------

export async function setClaimLineDiagnosisPointers(lineId: string, body: unknown, actorUserId: string): Promise<ClaimStructureResult<ClaimLineDto>> {
  if (!isClaimStructureUuid(lineId)) return invalid('invalid claim line id')
  const validated = validatePointerBody(body)
  if (!validated.ok) return invalid(validated.message)
  const requested = validated.value

  return runClaimStructureWrite(async (tx) => {
    const located = await findClaimLineLocation(lineId, tx)
    if (!located) return refuse('NOT_FOUND', 'claim line not found')
    const gate = await openClaimStructureGate(located.claimId, 'claimLine.pointers', tx)
    const line = await findClaimLineById(lineId, tx)
    if (!line) return refuse('NOT_FOUND', 'claim line not found')
    if (line.removedAt !== null) refuse('CLAIM_STRUCTURE_INACTIVE', 'the pointers of a removed claim line cannot change')

    // Every requested diagnosis must exist in this organization (otherwise it is "not found", so another
    // tenant's id discloses nothing), belong to this line's Claim, and be active.
    const targets = new Map((await findClaimDiagnosisTargets(requested, tx)).map((target) => [target.id, target]))
    for (const id of requested) {
      const target = targets.get(id)
      if (!target || target.organizationId !== gate.organizationId) refuse('NOT_FOUND', 'claim diagnosis not found')
      if (target.claimId !== line.claimId) refuse('CLAIM_DIAGNOSIS_POINTER_MISMATCH', 'a claim diagnosis of another claim cannot be pointed to')
      if (target.removedAt !== null) refuse('CLAIM_STRUCTURE_INACTIVE', 'a removed claim diagnosis cannot be pointed to')
    }

    const before = toClaimLineDto(line)
    const plan = planPointerChanges(await findActivePointersForLine(lineId, tx), requested)
    // The identical set is a no-op: nothing is written and nothing is audited.
    if (plan.removePointerIds.length === 0 && plan.addDiagnosisIds.length === 0) return before

    await markPointersRemoved(plan.removePointerIds, tx)
    await createPointers(lineId, plan.addDiagnosisIds, actorUserId, tx)
    await concurrencyProbe('claimLine.pointersChanged')
    const after = await lineDto(lineId, tx)
    await recordAuditEvent(
      {
        organizationId: gate.organizationId,
        actorUserId,
        actionCode: 'claim_line_diagnoses.changed',
        entityType: 'CLAIM_LINE',
        entityId: lineId,
        beforeState: { claimDiagnosisIds: before.claimDiagnosisIds },
        afterState: { claimDiagnosisIds: after.claimDiagnosisIds },
      },
      tx,
    )
    return after
  })
}

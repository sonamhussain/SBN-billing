import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { encounterDiagnosisAuditSnapshot } from '../audit/audit.snapshot.ts'
import { findEncounterOwnership } from '../encounter/encounter.repository.ts'
import {
  createEncounterDiagnosisRecord,
  findActiveEncounterDiagnoses,
  findDiagnosisCodeOwnership,
  findEncounterDiagnosisById,
  markEncounterDiagnosisRemoved,
  setEncounterDiagnosisSequence,
} from './encounter-diagnosis.repository.ts'
import {
  SEQUENCE_PARKING_OFFSET,
  type EncounterDiagnosisDto,
  type EncounterDiagnosisErrorCode,
  type EncounterDiagnosisResult,
} from './encounter-diagnosis.types.ts'
import {
  checkReadInvariant,
  isEncounterDiagnosisUuid,
  planCompaction,
  planReorder,
  toEncounterDiagnosisDto,
  validateAddBody,
  validateOrderBody,
  validateRemoveBody,
  type SequenceChange,
} from './encounter-diagnosis.validation.ts'

// A4.5 — every writer (add, reorder, remove) locks the parent Encounter row first, so all
// diagnosis writes for one Encounter serialize; the two active partial unique indexes stay the
// second line of defence and are never disabled. Stored order that breaks the 1..N invariant is
// refused (INTEGRITY_CONFLICT), never repaired. Nothing is hard-deleted, and no claim, procedure,
// primary-diagnosis or payer rule is decided here.

const failure = (code: EncounterDiagnosisErrorCode, message: string): EncounterDiagnosisResult<never> => ({ ok: false, code, message })
const invalid = (message: string) => failure('VALIDATION_ERROR', message)

type Refused = { kind: 'refused'; code: EncounterDiagnosisErrorCode; message: string }
const refused = (code: EncounterDiagnosisErrorCode, message: string): Refused => ({ kind: 'refused', code, message })

type LockedEncounter = { organizationId: string; active: Awaited<ReturnType<typeof findActiveEncounterDiagnoses>> }

// Lock the Encounter, confirm it exists, and read + verify its active diagnoses under that lock.
async function lockEncounter(encounterId: string, probe: string, db: DbClient): Promise<LockedEncounter | Refused> {
  if (!(await lockRowForUpdate(db, 'encounters', encounterId))) return refused('NOT_FOUND', 'encounter not found')
  await concurrencyProbe(probe)
  const ownership = await findEncounterOwnership(encounterId, db)
  if (!ownership) return refused('NOT_FOUND', 'encounter not found')
  const active = await findActiveEncounterDiagnoses(encounterId, db)
  const invariant = checkReadInvariant(active)
  if (!invariant.ok) return refused('INTEGRITY_CONFLICT', invariant.message)
  return { organizationId: ownership.organizationId, active }
}

// §16 two-phase rewrite: park every moving row far outside the live range, then write its final
// position. A permutation only ever moves rows into positions vacated by other moving rows, so no
// intermediate state collides with the active (encounter_id, sequence) unique index. Rows whose
// position does not change are not touched.
async function applySequenceChanges(changes: SequenceChange[], db: DbClient) {
  for (const change of changes) await setEncounterDiagnosisSequence(change.id, SEQUENCE_PARKING_OFFSET + change.from, db)
  const updated = []
  for (const change of changes) updated.push(await setEncounterDiagnosisSequence(change.id, change.to, db))
  return updated
}

async function auditReordered(organizationId: string, actorUserId: string, changes: SequenceChange[], updated: { id: string; updatedAt: Date }[], db: DbClient) {
  for (const [index, change] of changes.entries()) {
    await recordAuditEvent(
      {
        organizationId,
        actorUserId,
        actionCode: 'encounterDiagnosis.reordered',
        entityType: 'ENCOUNTER_DIAGNOSIS',
        entityId: change.id,
        beforeState: encounterDiagnosisAuditSnapshot({ id: change.id, sequence: change.from }),
        afterState: encounterDiagnosisAuditSnapshot({ id: change.id, sequence: change.to, updatedAt: updated[index].updatedAt }),
      },
      db,
    )
  }
}

// ---- add (§15) -----------------------------------------------------------------------------------

export async function addEncounterDiagnosis(encounterId: string, body: unknown, actorUserId: string): Promise<EncounterDiagnosisResult<EncounterDiagnosisDto>> {
  if (!isEncounterDiagnosisUuid(encounterId)) return invalid('invalid encounter id')
  const validated = validateAddBody(body)
  if (!validated.ok) return invalid(validated.message)

  const outcome = await prisma.$transaction(async (tx) => {
    const locked = await lockEncounter(encounterId, 'encounterDiagnosis.add', tx)
    if ('kind' in locked) return locked
    // A missing and a foreign DiagnosisCode are refused identically, so a caller never learns that
    // another organization's code exists.
    const diagnosis = await findDiagnosisCodeOwnership(validated.value.diagnosisCodeId, tx)
    if (!diagnosis || diagnosis.organizationId !== locked.organizationId) return refused('NOT_FOUND', 'diagnosis code not found')
    if (locked.active.some((row) => row.diagnosisCodeId === validated.value.diagnosisCodeId))
      return refused('VALIDATION_ERROR', 'this diagnosis code is already active on this encounter')

    const record = await createEncounterDiagnosisRecord({ encounterId, diagnosisCodeId: validated.value.diagnosisCodeId, sequence: locked.active.length + 1 }, tx)
    await recordAuditEvent(
      {
        organizationId: locked.organizationId,
        actorUserId,
        actionCode: 'encounterDiagnosis.added',
        entityType: 'ENCOUNTER_DIAGNOSIS',
        entityId: record.id,
        beforeState: null,
        afterState: encounterDiagnosisAuditSnapshot(record),
      },
      tx,
    )
    return { kind: 'written' as const, record }
  })

  if (outcome.kind === 'refused') return failure(outcome.code, outcome.message)
  return { ok: true, value: toEncounterDiagnosisDto(outcome.record) }
}

// ---- list (§22) ----------------------------------------------------------------------------------

// Read-only and deterministic: active rows ordered by sequence, verified — never repaired.
export async function listEncounterDiagnoses(encounterId: string): Promise<EncounterDiagnosisResult<EncounterDiagnosisDto[]>> {
  if (!isEncounterDiagnosisUuid(encounterId)) return invalid('invalid encounter id')
  if (!(await findEncounterOwnership(encounterId))) return failure('NOT_FOUND', 'encounter not found')
  const rows = await findActiveEncounterDiagnoses(encounterId)
  const invariant = checkReadInvariant(rows)
  if (!invariant.ok) return failure('INTEGRITY_CONFLICT', invariant.message)
  return { ok: true, value: rows.map(toEncounterDiagnosisDto) }
}

// ---- reorder (§16) -------------------------------------------------------------------------------

export async function reorderEncounterDiagnoses(encounterId: string, body: unknown, actorUserId: string): Promise<EncounterDiagnosisResult<EncounterDiagnosisDto[]>> {
  if (!isEncounterDiagnosisUuid(encounterId)) return invalid('invalid encounter id')
  const validated = validateOrderBody(body)
  if (!validated.ok) return invalid(validated.message)

  const outcome = await prisma.$transaction(async (tx) => {
    const locked = await lockEncounter(encounterId, 'encounterDiagnosis.reorder', tx)
    if ('kind' in locked) return locked
    const plan = planReorder(locked.active, validated.value)
    if (!plan.ok) return refused('VALIDATION_ERROR', plan.message)

    const updated = await applySequenceChanges(plan.value, tx)
    await auditReordered(locked.organizationId, actorUserId, plan.value, updated, tx)
    return { kind: 'written' as const, rows: await findActiveEncounterDiagnoses(encounterId, tx) }
  })

  if (outcome.kind === 'refused') return failure(outcome.code, outcome.message)
  return { ok: true, value: outcome.rows.map(toEncounterDiagnosisDto) }
}

// ---- remove (§17) --------------------------------------------------------------------------------

export async function removeEncounterDiagnosis(id: string, body: unknown, actorUserId: string): Promise<EncounterDiagnosisResult<EncounterDiagnosisDto[]>> {
  if (!isEncounterDiagnosisUuid(id)) return invalid('invalid encounter diagnosis id')
  const validated = validateRemoveBody(body)
  if (!validated.ok) return invalid(validated.message)

  const outcome = await prisma.$transaction(async (tx) => {
    // encounterId is immutable, so this unlocked read only finds the lock target; every decision
    // below is made on the re-read taken while holding the Encounter lock.
    const located = await findEncounterDiagnosisById(id, tx)
    if (!located) return refused('NOT_FOUND', 'encounter diagnosis not found')
    const locked = await lockEncounter(located.encounterId, 'encounterDiagnosis.remove', tx)
    if ('kind' in locked) return locked
    const current = await findEncounterDiagnosisById(id, tx)
    if (!current) return refused('NOT_FOUND', 'encounter diagnosis not found')
    if (current.removedAt !== null) return refused('VALIDATION_ERROR', 'this encounter diagnosis is already removed')

    const removed = await markEncounterDiagnosisRemoved(id, new Date(), tx)
    await recordAuditEvent(
      {
        organizationId: locked.organizationId,
        actorUserId,
        actionCode: 'encounterDiagnosis.removed',
        entityType: 'ENCOUNTER_DIAGNOSIS',
        entityId: id,
        beforeState: encounterDiagnosisAuditSnapshot({ id, sequence: current.sequence, removedAt: null }),
        afterState: encounterDiagnosisAuditSnapshot({ id, removedAt: removed.removedAt, updatedAt: removed.updatedAt }),
      },
      tx,
    )

    const remaining = locked.active.filter((row) => row.id !== id)
    const changes = planCompaction(remaining)
    const updated = await applySequenceChanges(changes, tx)
    await auditReordered(locked.organizationId, actorUserId, changes, updated, tx)
    return { kind: 'written' as const, rows: await findActiveEncounterDiagnoses(located.encounterId, tx) }
  })

  if (outcome.kind === 'refused') return failure(outcome.code, outcome.message)
  return { ok: true, value: outcome.rows.map(toEncounterDiagnosisDto) }
}

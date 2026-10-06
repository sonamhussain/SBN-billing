import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { encounterObservationAuditSnapshot } from '../audit/audit.snapshot.ts'
import { findEncounterOwnership } from '../encounter/encounter.repository.ts'
import { findEncounterActivityById } from '../encounter-activity/encounter-activity.repository.ts'
import {
  createEncounterObservationRecord,
  findActiveEncounterObservations,
  findEncounterObservationById,
  markEncounterObservationRemoved,
} from './encounter-observation.repository.ts'
import type { EncounterObservationDto, EncounterObservationErrorCode, EncounterObservationResult } from './encounter-observation.types.ts'
import {
  isEncounterObservationUuid,
  toEncounterObservationDto,
  toObservationColumns,
  validateCreateBody,
  validateRemoveBody,
  verifyStoredObservation,
} from './encounter-observation.validation.ts'

// A4.7 — every writer (create, remove) locks the parent Encounter row first, the same serialization
// point the A4.5 diagnosis and A4.6 activity writers use, so an observation create and an activity
// removal can never interleave into an orphan. An activity anchor must be an ACTIVE activity of the
// SAME Encounter. Stored rows that break the typed-value invariant are refused (INTEGRITY_CONFLICT),
// never repaired. Nothing is patched or hard-deleted, and no fact is ever evaluated.

const failure = (code: EncounterObservationErrorCode, message: string): EncounterObservationResult<never> => ({ ok: false, code, message })
const invalid = (message: string) => failure('VALIDATION_ERROR', message)

type Refused = { kind: 'refused'; code: EncounterObservationErrorCode; message: string }
const refused = (code: EncounterObservationErrorCode, message: string): Refused => ({ kind: 'refused', code, message })

type ObservationRow = NonNullable<Awaited<ReturnType<typeof findEncounterObservationById>>>

// Lock the Encounter and confirm it (and so its organization) under that lock.
async function lockEncounter(encounterId: string, probe: string, db: DbClient): Promise<{ organizationId: string } | Refused> {
  if (!(await lockRowForUpdate(db, 'encounters', encounterId))) return refused('NOT_FOUND', 'encounter not found')
  await concurrencyProbe(probe)
  const ownership = await findEncounterOwnership(encounterId, db)
  if (!ownership) return refused('NOT_FOUND', 'encounter not found')
  return ownership
}

// Verify the stored row, then build the DTO; a corrupt row fails the whole read closed.
function toVerifiedDto(row: ObservationRow): EncounterObservationResult<EncounterObservationDto> {
  const value = verifyStoredObservation({ ...row, activityEncounterId: row.encounterActivity?.encounterId ?? null })
  if (!value.ok) return failure('INTEGRITY_CONFLICT', value.message)
  return { ok: true, value: toEncounterObservationDto(row, value.value) }
}

// ---- create (§14–§15) ----------------------------------------------------------------------------

export async function createEncounterObservation(encounterId: string, body: unknown, actorUserId: string): Promise<EncounterObservationResult<EncounterObservationDto>> {
  if (!isEncounterObservationUuid(encounterId)) return invalid('invalid encounter id')
  const validated = validateCreateBody(body)
  if (!validated.ok) return invalid(validated.message)
  const input = validated.value

  const outcome = await prisma.$transaction(async (tx) => {
    const locked = await lockEncounter(encounterId, 'encounterObservation.create', tx)
    if ('kind' in locked) return locked
    if (input.encounterActivityId !== null) {
      // A missing activity and one of another Encounter (or tenant) are refused identically, so a
      // caller never learns that a foreign activity exists. Read under the Encounter lock, so a
      // concurrent removal of this activity is already committed or not yet started.
      const activity = await findEncounterActivityById(input.encounterActivityId, tx)
      if (!activity || activity.encounterId !== encounterId) return refused('NOT_FOUND', 'encounter activity not found')
      if (activity.removedAt !== null) return refused('VALIDATION_ERROR', 'an observation cannot be attached to a removed encounter activity')
    }

    const record = await createEncounterObservationRecord(
      { encounterId, encounterActivityId: input.encounterActivityId, ...toObservationColumns(input.factKey, input.value) },
      tx,
    )
    await recordAuditEvent(
      {
        organizationId: locked.organizationId,
        actorUserId,
        actionCode: 'encounterObservation.created',
        entityType: 'ENCOUNTER_OBSERVATION',
        entityId: record.id,
        beforeState: null,
        afterState: encounterObservationAuditSnapshot(record),
      },
      tx,
    )
    return { kind: 'written' as const, row: record }
  })

  if (outcome.kind === 'refused') return failure(outcome.code, outcome.message)
  return toVerifiedDto(outcome.row)
}

// ---- list / get (§18–§19) ------------------------------------------------------------------------

// Read-only: active rows in deterministic display order, each verified — never repaired.
export async function listEncounterObservations(encounterId: string): Promise<EncounterObservationResult<EncounterObservationDto[]>> {
  if (!isEncounterObservationUuid(encounterId)) return invalid('invalid encounter id')
  if (!(await findEncounterOwnership(encounterId))) return failure('NOT_FOUND', 'encounter not found')
  const items: EncounterObservationDto[] = []
  for (const row of await findActiveEncounterObservations(encounterId)) {
    const dto = toVerifiedDto(row)
    if (!dto.ok) return dto
    items.push(dto.value)
  }
  return { ok: true, value: items }
}

// The exact observation, including a removed (historical) one.
export async function getEncounterObservation(id: string): Promise<EncounterObservationResult<EncounterObservationDto>> {
  if (!isEncounterObservationUuid(id)) return invalid('invalid encounter observation id')
  const row = await findEncounterObservationById(id)
  if (!row) return failure('NOT_FOUND', 'encounter observation not found')
  return toVerifiedDto(row)
}

// ---- remove (§16) --------------------------------------------------------------------------------

export async function removeEncounterObservation(id: string, body: unknown, actorUserId: string): Promise<EncounterObservationResult<EncounterObservationDto>> {
  if (!isEncounterObservationUuid(id)) return invalid('invalid encounter observation id')
  const validated = validateRemoveBody(body)
  if (!validated.ok) return invalid(validated.message)

  const outcome = await prisma.$transaction(async (tx) => {
    // encounterId is immutable, so this unlocked read only finds the lock target; every decision
    // below is made on the re-read taken while holding the Encounter lock.
    const located = await findEncounterObservationById(id, tx)
    if (!located) return refused('NOT_FOUND', 'encounter observation not found')
    const locked = await lockEncounter(located.encounterId, 'encounterObservation.remove', tx)
    if ('kind' in locked) return locked
    const current = await findEncounterObservationById(id, tx)
    if (!current) return refused('NOT_FOUND', 'encounter observation not found')
    if (current.removedAt !== null) return refused('VALIDATION_ERROR', 'this encounter observation is already removed')

    // Only removedAt changes; the fact, value and anchors stay as history.
    const removed = await markEncounterObservationRemoved(id, new Date(), tx)
    await recordAuditEvent(
      {
        organizationId: locked.organizationId,
        actorUserId,
        actionCode: 'encounterObservation.removed',
        entityType: 'ENCOUNTER_OBSERVATION',
        entityId: id,
        beforeState: encounterObservationAuditSnapshot({ id, removedAt: null }),
        afterState: encounterObservationAuditSnapshot({ id, removedAt: removed.removedAt, updatedAt: removed.updatedAt }),
      },
      tx,
    )
    return { kind: 'written' as const, row: removed }
  })

  if (outcome.kind === 'refused') return failure(outcome.code, outcome.message)
  return toVerifiedDto(outcome.row)
}

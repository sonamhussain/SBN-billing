import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { encounterActivityAuditSnapshot } from '../audit/audit.snapshot.ts'
import { findEncounterOwnership } from '../encounter/encounter.repository.ts'
import {
  createEncounterActivityModifiers,
  createEncounterActivityRecord,
  findActiveEncounterActivities,
  findEncounterActivityById,
  findProcedureCodeOwnership,
  findServiceOwnership,
  markEncounterActivityRemoved,
} from './encounter-activity.repository.ts'
import type { EncounterActivityDto, EncounterActivityErrorCode, EncounterActivityResult } from './encounter-activity.types.ts'
import {
  checkModifierInvariant,
  isEncounterActivityUuid,
  toEncounterActivityDto,
  validateCreateBody,
  validateRemoveBody,
} from './encounter-activity.validation.ts'

// A4.6 — every writer (create, remove) locks the parent Encounter row first, the same serialization
// point A4.5 diagnosis writers use, so all child writes for one Encounter serialize in one lock
// order. Service/ProcedureCode masters are only read for same-organization ownership, never locked
// and never mapped to each other. Stored modifiers that break the 1..N invariant are refused
// (INTEGRITY_CONFLICT), never repaired. Nothing is patched or hard-deleted, and no claim-line order,
// price, tariff or diagnosis pointer is decided here.

const failure = (code: EncounterActivityErrorCode, message: string): EncounterActivityResult<never> => ({ ok: false, code, message })
const invalid = (message: string) => failure('VALIDATION_ERROR', message)

type Refused = { kind: 'refused'; code: EncounterActivityErrorCode; message: string }
const refused = (code: EncounterActivityErrorCode, message: string): Refused => ({ kind: 'refused', code, message })

type ActivityRow = NonNullable<Awaited<ReturnType<typeof findEncounterActivityById>>>

// Lock the Encounter and confirm it (and so its organization) under that lock.
async function lockEncounter(encounterId: string, probe: string, db: DbClient): Promise<{ organizationId: string } | Refused> {
  if (!(await lockRowForUpdate(db, 'encounters', encounterId))) return refused('NOT_FOUND', 'encounter not found')
  await concurrencyProbe(probe)
  const ownership = await findEncounterOwnership(encounterId, db)
  if (!ownership) return refused('NOT_FOUND', 'encounter not found')
  return ownership
}

// Verify the stored modifiers, then build the DTO; a corrupt row fails the whole read closed.
function toVerifiedDto(row: ActivityRow): EncounterActivityResult<EncounterActivityDto> {
  const modifiers = checkModifierInvariant(row.modifiers)
  if (!modifiers.ok) return failure('INTEGRITY_CONFLICT', modifiers.message)
  return { ok: true, value: toEncounterActivityDto(row, modifiers.value) }
}

// ---- create (§20) --------------------------------------------------------------------------------

export async function createEncounterActivity(encounterId: string, body: unknown, actorUserId: string): Promise<EncounterActivityResult<EncounterActivityDto>> {
  if (!isEncounterActivityUuid(encounterId)) return invalid('invalid encounter id')
  const validated = validateCreateBody(body)
  if (!validated.ok) return invalid(validated.message)
  const input = validated.value

  const outcome = await prisma.$transaction(async (tx) => {
    const locked = await lockEncounter(encounterId, 'encounterActivity.create', tx)
    if ('kind' in locked) return locked
    // A missing and a foreign master are refused identically, so a caller never learns that another
    // organization's Service or ProcedureCode exists. Only ownership is checked: no mapping between
    // the two is asserted.
    if (input.serviceId !== null) {
      const service = await findServiceOwnership(input.serviceId, tx)
      if (!service || service.organizationId !== locked.organizationId) return refused('NOT_FOUND', 'service not found')
    }
    if (input.procedureCodeId !== null) {
      const procedure = await findProcedureCodeOwnership(input.procedureCodeId, tx)
      if (!procedure || procedure.organizationId !== locked.organizationId) return refused('NOT_FOUND', 'procedure code not found')
    }

    const record = await createEncounterActivityRecord(
      { encounterId, serviceId: input.serviceId, procedureCodeId: input.procedureCodeId, quantity: input.quantity, unitCode: input.unitCode },
      tx,
    )
    await createEncounterActivityModifiers(record.id, input.modifierCodes, tx)
    await recordAuditEvent(
      {
        organizationId: locked.organizationId,
        actorUserId,
        actionCode: 'encounterActivity.created',
        entityType: 'ENCOUNTER_ACTIVITY',
        entityId: record.id,
        beforeState: null,
        afterState: encounterActivityAuditSnapshot(record),
      },
      tx,
    )
    return { kind: 'written' as const, row: await findEncounterActivityById(record.id, tx) }
  })

  if (outcome.kind === 'refused') return failure(outcome.code, outcome.message)
  if (!outcome.row) return failure('NOT_FOUND', 'encounter activity not found')
  return toVerifiedDto(outcome.row)
}

// ---- list / get (§21) ----------------------------------------------------------------------------

// Read-only: active rows in deterministic display order, each verified — never repaired.
export async function listEncounterActivities(encounterId: string): Promise<EncounterActivityResult<EncounterActivityDto[]>> {
  if (!isEncounterActivityUuid(encounterId)) return invalid('invalid encounter id')
  if (!(await findEncounterOwnership(encounterId))) return failure('NOT_FOUND', 'encounter not found')
  const items: EncounterActivityDto[] = []
  for (const row of await findActiveEncounterActivities(encounterId)) {
    const dto = toVerifiedDto(row)
    if (!dto.ok) return dto
    items.push(dto.value)
  }
  return { ok: true, value: items }
}

// The exact activity, including a removed (historical) one.
export async function getEncounterActivity(id: string): Promise<EncounterActivityResult<EncounterActivityDto>> {
  if (!isEncounterActivityUuid(id)) return invalid('invalid encounter activity id')
  const row = await findEncounterActivityById(id)
  if (!row) return failure('NOT_FOUND', 'encounter activity not found')
  return toVerifiedDto(row)
}

// ---- remove (§22) --------------------------------------------------------------------------------

export async function removeEncounterActivity(id: string, body: unknown, actorUserId: string): Promise<EncounterActivityResult<EncounterActivityDto>> {
  if (!isEncounterActivityUuid(id)) return invalid('invalid encounter activity id')
  const validated = validateRemoveBody(body)
  if (!validated.ok) return invalid(validated.message)

  const outcome = await prisma.$transaction(async (tx) => {
    // encounterId is immutable, so this unlocked read only finds the lock target; every decision
    // below is made on the re-read taken while holding the Encounter lock.
    const located = await findEncounterActivityById(id, tx)
    if (!located) return refused('NOT_FOUND', 'encounter activity not found')
    const locked = await lockEncounter(located.encounterId, 'encounterActivity.remove', tx)
    if ('kind' in locked) return locked
    const current = await findEncounterActivityById(id, tx)
    if (!current) return refused('NOT_FOUND', 'encounter activity not found')
    if (current.removedAt !== null) return refused('VALIDATION_ERROR', 'this encounter activity is already removed')

    // Only removedAt changes; the modifier children are left untouched as history.
    const removed = await markEncounterActivityRemoved(id, new Date(), tx)
    await recordAuditEvent(
      {
        organizationId: locked.organizationId,
        actorUserId,
        actionCode: 'encounterActivity.removed',
        entityType: 'ENCOUNTER_ACTIVITY',
        entityId: id,
        beforeState: encounterActivityAuditSnapshot({ id, removedAt: null }),
        afterState: encounterActivityAuditSnapshot({ id, removedAt: removed.removedAt, updatedAt: removed.updatedAt }),
      },
      tx,
    )
    return { kind: 'written' as const, row: removed }
  })

  if (outcome.kind === 'refused') return failure(outcome.code, outcome.message)
  return toVerifiedDto(outcome.row)
}

import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { patientAuditSnapshot } from '../audit/audit.snapshot.ts'
import { getOrganization } from '../organization/organization.service.ts'
import { createPatientRecord, findPatientById, findPatientsByOrganizationId, updatePatientRecord } from './patient.repository.ts'
import type { PatientDto, PatientResult } from './patient.types.ts'
import {
  changedFields,
  isPatientUuid,
  toPatientDto,
  validateCreateInput,
  validateUpdateInput,
} from './patient.validation.ts'

// A4.1 — Patient identity. The service owns three decisions and nothing else: is the input valid,
// does the tenant own this row, and what safe audit metadata should be written. It never reads
// coverage, encounters, rules or provenance, and it never deletes.

type Clock = { clock?: () => Date; db?: DbClient }

const systemClock = () => new Date()

function invalid(message: string): PatientResult<never> {
  return { ok: false, code: 'VALIDATION_ERROR', message }
}

export async function createPatient(
  organizationId: string,
  body: unknown,
  actorUserId: string,
  internal: Clock = {},
): Promise<PatientResult<PatientDto>> {
  if (!isPatientUuid(organizationId)) return invalid('invalid organization id')
  const organization = await getOrganization(organizationId)
  if (!organization.ok) return { ok: false, code: 'NOT_FOUND', message: 'organization not found' }

  const validated = validateCreateInput(body, (internal.clock ?? systemClock)())
  if (!validated.ok) return invalid(validated.message)

  // The row and its AuditEvent commit together, so a created patient can never exist without its
  // audit record, and a refused create writes nothing at all.
  const created = await prisma.$transaction(async (tx) => {
    const record = await createPatientRecord(organizationId, validated.value, tx)
    await recordAuditEvent(
      {
        organizationId,
        actorUserId,
        actionCode: 'patient.created',
        entityType: 'PATIENT',
        entityId: record.id,
        beforeState: null,
        afterState: patientAuditSnapshot(record),
      },
      tx,
    )
    return record
  })
  return { ok: true, value: toPatientDto(created) }
}

export async function listPatients(organizationId: string): Promise<PatientResult<PatientDto[]>> {
  if (!isPatientUuid(organizationId)) return invalid('invalid organization id')
  const organization = await getOrganization(organizationId)
  if (!organization.ok) return { ok: false, code: 'NOT_FOUND', message: 'organization not found' }
  const records = await findPatientsByOrganizationId(organizationId)
  return { ok: true, value: records.map(toPatientDto) }
}

export async function getPatient(id: string): Promise<PatientResult<PatientDto>> {
  if (!isPatientUuid(id)) return invalid('invalid patient id')
  const record = await findPatientById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'patient not found' }
  return { ok: true, value: toPatientDto(record) }
}

export async function updatePatient(
  id: string,
  body: unknown,
  actorUserId: string,
  internal: Clock = {},
): Promise<PatientResult<PatientDto>> {
  if (!isPatientUuid(id)) return invalid('invalid patient id')
  const validated = validateUpdateInput(body, (internal.clock ?? systemClock)())
  if (!validated.ok) return invalid(validated.message)

  // Guarded-writer protocol: lock the patient row, re-read it inside the transaction, decide from
  // that state, then write the row and its audit. The before-state is never read outside the
  // transaction, so two concurrent partial updates serialize and neither erases the other's field.
  const outcome = await prisma.$transaction(async (tx) => {
    const locked = await lockRowForUpdate(tx, 'patients', id)
    if (!locked) return { kind: 'missing' as const }
    await concurrencyProbe('patient.update')
    const existing = await findPatientById(id, tx)
    if (!existing) return { kind: 'missing' as const }

    const changed = changedFields(existing, validated.value)
    if (changed.length === 0) return { kind: 'unchanged' as const }

    const patch = Object.fromEntries(changed.map((field) => [field, (validated.value as Record<string, unknown>)[field]]))
    const updated = await updatePatientRecord(id, patch, tx)
    await recordAuditEvent(
      {
        organizationId: existing.organizationId,
        actorUserId,
        actionCode: 'patient.updated',
        entityType: 'PATIENT',
        entityId: id,
        beforeState: patientAuditSnapshot(existing),
        afterState: patientAuditSnapshot(updated, changed),
      },
      tx,
    )
    return { kind: 'updated' as const, record: updated }
  })

  if (outcome.kind === 'missing') return { ok: false, code: 'NOT_FOUND', message: 'patient not found' }
  // A patch that changes nothing is refused rather than recorded: audit must describe what
  // happened, and nothing happened.
  if (outcome.kind === 'unchanged') return invalid('a patch must change at least one field')
  return { ok: true, value: toPatientDto(outcome.record) }
}

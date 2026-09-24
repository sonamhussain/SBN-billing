import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { encounterAuditSnapshot } from '../audit/audit.snapshot.ts'
import { resolveClinicianFacilityAssignment } from '../clinician-assignment/clinician-assignment.service.ts'
import { resolveFacilityRegulatoryProfileForDate } from '../facility-regulatory/facility-regulatory.repository.ts'
import {
  createEncounterRecord,
  findClinicianOwnership,
  findEncounterById,
  findEncountersByPatientId,
  findFacilityOwnership,
  findMembershipContext,
  findPatientOwnership,
  updateEncounterRecord,
} from './encounter.repository.ts'
import type { EncounterDto, EncounterErrorCode, EncounterResult } from './encounter.types.ts'
import {
  changedFields,
  decideEncounterContext,
  isEncounterUuid,
  mergeEncounter,
  toEncounterDto,
  validateCreateInput,
  validateUpdateInput,
  type ContextFacts,
  type EncounterWriteInput,
} from './encounter.validation.ts'

// A4.4 — the service proves the whole context before it writes. It locks the same parent rows the
// owning writers lock (A4.2 assignment writers lock the Clinician, A3 regulatory writers lock the
// Facility, A4.3 membership updates lock the membership), so the context it resolves cannot change
// between validation and write. It reuses the A4.2 and A3 resolvers rather than copying them, and
// it never calls A3 rule precedence, infers eligibility, stores a specialty or deletes.

function invalid(message: string): EncounterResult<never> {
  return { ok: false, code: 'VALIDATION_ERROR', message }
}

const failure = (code: EncounterErrorCode, message: string): EncounterResult<never> => ({ ok: false, code, message })

type ContextOutcome =
  | { ok: true; clinicianFacilityAssignmentId: string; facilityRegulatoryProfileId: string }
  | { ok: false; code: EncounterErrorCode; message: string }

// §8/§9 — lock Clinician -> Facility -> InsuranceMembership? (always in that order), re-read their
// ownership, resolve the assignment and the ACTIVE regulatory profile for the date, and decide.
async function lockAndResolveContext(
  patient: { id: string; organizationId: string },
  state: EncounterWriteInput,
  probe: string,
  db: DbClient,
): Promise<ContextOutcome> {
  if (!(await lockRowForUpdate(db, 'clinicians', state.clinicianId))) return { ok: false, code: 'NOT_FOUND', message: 'clinician not found' }
  if (!(await lockRowForUpdate(db, 'facilities', state.facilityId))) return { ok: false, code: 'NOT_FOUND', message: 'facility not found' }
  if (state.insuranceMembershipId && !(await lockRowForUpdate(db, 'insurance_memberships', state.insuranceMembershipId)))
    return { ok: false, code: 'NOT_FOUND', message: 'insurance membership not found' }
  await concurrencyProbe(probe)

  const clinician = await findClinicianOwnership(state.clinicianId, db)
  const facility = await findFacilityOwnership(state.facilityId, db)
  const membership = state.insuranceMembershipId ? await findMembershipContext(state.insuranceMembershipId, db) : ('not-supplied' as const)

  // Resolve only when the masters are this tenant's; a foreign ID is refused before its context
  // is ever looked at.
  const ownsMasters = clinician?.organizationId === patient.organizationId && facility?.organizationId === patient.organizationId
  let assignment: ContextFacts['assignment'] = { status: 'NO_MATCH' }
  let profile: ContextFacts['profile'] = { kind: 'none' }
  if (ownsMasters) {
    const resolvedAssignment = await resolveClinicianFacilityAssignment(state.clinicianId, state.facilityId, formatDateOnly(state.serviceDate), db)
    if (!resolvedAssignment.ok) return { ok: false, code: resolvedAssignment.code, message: resolvedAssignment.message }
    const value = resolvedAssignment.value
    assignment = value.status === 'RESOLVED' ? { status: 'RESOLVED', id: value.assignment.id } : value
    const resolvedProfile = await resolveFacilityRegulatoryProfileForDate(state.facilityId, state.serviceDate, db)
    profile = resolvedProfile.kind === 'one' ? { kind: 'one', id: resolvedProfile.profile.id } : resolvedProfile
  }

  return decideEncounterContext({
    patientId: patient.id,
    patientOrganizationId: patient.organizationId,
    serviceDate: state.serviceDate,
    clinician,
    facility,
    membership,
    assignment,
    profile,
  })
}

type CreateOutcome =
  | { kind: 'written'; record: Parameters<typeof toEncounterDto>[0] }
  | { kind: 'refused'; code: EncounterErrorCode; message: string }

type UpdateOutcome = CreateOutcome | { kind: 'unchanged' }

export async function createEncounter(patientId: string, body: unknown, actorUserId: string): Promise<EncounterResult<EncounterDto>> {
  if (!isEncounterUuid(patientId)) return invalid('invalid patient id')
  const validated = validateCreateInput(body)
  if (!validated.ok) return invalid(validated.message)

  // One transaction: nothing — neither the Encounter nor its audit — is written unless every piece
  // of context is proven while the locks are held.
  const outcome = await prisma.$transaction(async (tx): Promise<CreateOutcome> => {
    const patient = await findPatientOwnership(patientId, tx)
    if (!patient) return { kind: 'refused', code: 'NOT_FOUND', message: 'patient not found' }

    const context = await lockAndResolveContext({ id: patientId, organizationId: patient.organizationId }, validated.value, 'encounter.create', tx)
    if (!context.ok) return { kind: 'refused', code: context.code, message: context.message }

    const record = await createEncounterRecord(
      {
        patientId,
        ...validated.value,
        clinicianFacilityAssignmentId: context.clinicianFacilityAssignmentId,
        facilityRegulatoryProfileId: context.facilityRegulatoryProfileId,
      },
      tx,
    )
    await recordAuditEvent(
      {
        organizationId: patient.organizationId,
        actorUserId,
        actionCode: 'encounter.created',
        entityType: 'ENCOUNTER',
        entityId: record.id,
        beforeState: null,
        afterState: encounterAuditSnapshot(record),
      },
      tx,
    )
    return { kind: 'written', record }
  })

  if (outcome.kind === 'refused') return failure(outcome.code, outcome.message)
  return { ok: true, value: toEncounterDto(outcome.record) }
}

export async function listEncounters(patientId: string): Promise<EncounterResult<EncounterDto[]>> {
  if (!isEncounterUuid(patientId)) return invalid('invalid patient id')
  if (!(await findPatientOwnership(patientId))) return failure('NOT_FOUND', 'patient not found')
  const records = await findEncountersByPatientId(patientId)
  return { ok: true, value: records.map(toEncounterDto) }
}

export async function getEncounter(id: string): Promise<EncounterResult<EncounterDto>> {
  if (!isEncounterUuid(id)) return invalid('invalid encounter id')
  const record = await findEncounterById(id)
  if (!record) return failure('NOT_FOUND', 'encounter not found')
  return { ok: true, value: toEncounterDto(record) }
}

export async function updateEncounter(id: string, body: unknown, actorUserId: string): Promise<EncounterResult<EncounterDto>> {
  if (!isEncounterUuid(id)) return invalid('invalid encounter id')
  const validated = validateUpdateInput(body)
  if (!validated.ok) return invalid(validated.message)

  // §9 PATCH lock order: Encounter -> resulting Clinician -> resulting Facility -> resulting
  // membership. Every patchable field is context, so ANY change re-runs the FULL resolution on the
  // merged state and replaces both server-resolved IDs atomically; a refused correction leaves the
  // row untouched and writes no audit.
  const outcome = await prisma.$transaction(async (tx): Promise<UpdateOutcome> => {
    if (!(await lockRowForUpdate(tx, 'encounters', id))) return { kind: 'refused', code: 'NOT_FOUND', message: 'encounter not found' }
    await concurrencyProbe('encounter.update')
    const existing = await findEncounterById(id, tx)
    if (!existing) return { kind: 'refused', code: 'NOT_FOUND', message: 'encounter not found' }

    const changed = changedFields(existing, validated.value)
    if (changed.length === 0) return { kind: 'unchanged' }

    const patient = await findPatientOwnership(existing.patientId, tx)
    if (!patient) return { kind: 'refused', code: 'NOT_FOUND', message: 'encounter not found' }
    const merged = mergeEncounter(existing, validated.value)
    const context = await lockAndResolveContext({ id: existing.patientId, organizationId: patient.organizationId }, merged, 'encounter.update.context', tx)
    if (!context.ok) return { kind: 'refused', code: context.code, message: context.message }

    const resolvedChanged = [
      ...changed,
      ...(context.clinicianFacilityAssignmentId !== existing.clinicianFacilityAssignmentId ? ['clinicianFacilityAssignmentId'] : []),
      ...(context.facilityRegulatoryProfileId !== existing.facilityRegulatoryProfileId ? ['facilityRegulatoryProfileId'] : []),
    ]
    const updated = await updateEncounterRecord(
      id,
      {
        ...Object.fromEntries(changed.map((field) => [field, merged[field as keyof EncounterWriteInput]])),
        clinicianFacilityAssignmentId: context.clinicianFacilityAssignmentId,
        facilityRegulatoryProfileId: context.facilityRegulatoryProfileId,
      },
      tx,
    )
    await recordAuditEvent(
      {
        organizationId: patient.organizationId,
        actorUserId,
        actionCode: 'encounter.updated',
        entityType: 'ENCOUNTER',
        entityId: id,
        beforeState: encounterAuditSnapshot(existing),
        afterState: encounterAuditSnapshot(updated, resolvedChanged),
      },
      tx,
    )
    return { kind: 'written', record: updated }
  })

  if (outcome.kind === 'refused') return failure(outcome.code, outcome.message)
  // A patch that changes nothing is refused rather than recorded: audit must describe what
  // happened, and nothing happened.
  if (outcome.kind === 'unchanged') return invalid('a patch must change at least one field')
  return { ok: true, value: toEncounterDto(outcome.record) }
}

import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { clinicianAssignmentAuditSnapshot } from '../audit/audit.snapshot.ts'
import { parseStrictDateOnly } from '../../shared/rules/date-only.ts'
import {
  closeFacilityAssignmentRecord,
  closeSpecialtyAssignmentRecord,
  createFacilityAssignmentRecord,
  createSpecialtyAssignmentRecord,
  findClinicianOwnership,
  findFacilityAssignmentById,
  findFacilityAssignmentsByClinician,
  findFacilityAssignmentsForPair,
  findFacilityOwnership,
  findSpecialtyAssignmentById,
  findSpecialtyAssignmentsByClinician,
  findSpecialtyAssignmentsForPair,
  findSpecialtyOwnership,
} from './clinician-assignment.repository.ts'
import type {
  AssignmentKind,
  AssignmentResolution,
  ClinicianAssignmentResult,
  ClinicianFacilityAssignmentDto,
  ClinicianSpecialtyAssignmentDto,
} from './clinician-assignment.types.ts'
import {
  decideClose,
  decideResolution,
  isAssignmentUuid,
  isEffectiveOnDate,
  periodsOverlap,
  toFacilityDto,
  toSpecialtyDto,
  validateCloseBody,
  validateCreateBody,
} from './clinician-assignment.validation.ts'

// A4.2 — create and close, nothing else. Every writer for one clinician serializes on that
// clinician's row, so the overlap check can never be invalidated between reading and writing. The
// service records an operational fact; it never decides that an encounter is billable, never reads
// a licence and never touches commercial participation.

function invalid(message: string): ClinicianAssignmentResult<never> {
  return { ok: false, code: 'VALIDATION_ERROR', message }
}

const notFound = (what: string): ClinicianAssignmentResult<never> => ({ ok: false, code: 'NOT_FOUND', message: `${what} not found` })

type CreateOutcome =
  | { kind: 'created'; record: { id: string; clinicianId: string; effectiveFrom: Date; effectiveTo: Date | null; createdAt: Date; updatedAt: Date } }
  | { kind: 'clinician-missing' }
  | { kind: 'target-missing' }
  | { kind: 'foreign-target' }
  | { kind: 'overlap'; conflictingIds: string[] }

async function createAssignment(
  kind: AssignmentKind,
  clinicianId: string,
  body: unknown,
  actorUserId: string,
): Promise<ClinicianAssignmentResult<ClinicianFacilityAssignmentDto | ClinicianSpecialtyAssignmentDto>> {
  if (!isAssignmentUuid(clinicianId)) return invalid('invalid clinician id')
  const validated = validateCreateBody(body, kind)
  if (!validated.ok) return invalid(validated.message)
  const { targetId, effectiveFrom, effectiveTo } = validated.value

  const outcome = await prisma.$transaction(async (tx): Promise<CreateOutcome> => {
    // The clinician row is the serialization point for both assignment types: a conservative,
    // single lock is enough to close create-vs-create and create-vs-close races.
    const locked = await lockRowForUpdate(tx, 'clinicians', clinicianId)
    if (!locked) return { kind: 'clinician-missing' }
    await concurrencyProbe('clinicianAssignment.create')

    const clinician = await findClinicianOwnership(clinicianId, tx)
    if (!clinician) return { kind: 'clinician-missing' }
    const target = kind === 'FACILITY' ? await findFacilityOwnership(targetId, tx) : await findSpecialtyOwnership(targetId, tx)
    if (!target) return { kind: 'target-missing' }
    // A clinician of one organization can never be assigned to another organization's facility or
    // specialty, and the refusal says nothing about that foreign record.
    if (target.organizationId !== clinician.organizationId) return { kind: 'foreign-target' }

    const existing =
      kind === 'FACILITY'
        ? await findFacilityAssignmentsForPair(clinicianId, targetId, tx)
        : await findSpecialtyAssignmentsForPair(clinicianId, targetId, tx)
    // Overlap is checked for this EXACT pair only, so practising at another facility or in another
    // specialty during the same period stays legitimate.
    const conflicting = existing.filter((row) => periodsOverlap(row, { effectiveFrom, effectiveTo }))
    if (conflicting.length > 0) return { kind: 'overlap', conflictingIds: conflicting.map((row) => row.id).sort() }

    const record =
      kind === 'FACILITY'
        ? await createFacilityAssignmentRecord({ clinicianId, facilityId: targetId, effectiveFrom, effectiveTo }, tx)
        : await createSpecialtyAssignmentRecord({ clinicianId, specialtyId: targetId, effectiveFrom, effectiveTo }, tx)

    await recordAuditEvent(
      {
        organizationId: clinician.organizationId,
        actorUserId,
        actionCode: kind === 'FACILITY' ? 'clinicianFacilityAssignment.created' : 'clinicianSpecialtyAssignment.created',
        entityType: kind === 'FACILITY' ? 'CLINICIAN_FACILITY_ASSIGNMENT' : 'CLINICIAN_SPECIALTY_ASSIGNMENT',
        entityId: record.id,
        beforeState: null,
        afterState: clinicianAssignmentAuditSnapshot({
          id: record.id,
          clinicianId,
          targetField: kind === 'FACILITY' ? 'facilityId' : 'specialtyId',
          targetId,
          effectiveFrom: record.effectiveFrom,
          effectiveTo: record.effectiveTo,
        }),
      },
      tx,
    )
    return { kind: 'created', record }
  })

  if (outcome.kind === 'clinician-missing') return notFound('clinician')
  if (outcome.kind === 'target-missing') return notFound(kind === 'FACILITY' ? 'facility' : 'specialty')
  if (outcome.kind === 'foreign-target')
    return { ok: false, code: 'NOT_FOUND', message: `${kind === 'FACILITY' ? 'facility' : 'specialty'} not found` }
  if (outcome.kind === 'overlap')
    return invalid(
      `this period overlaps an existing assignment for the same ${kind === 'FACILITY' ? 'clinician and facility' : 'clinician and specialty'}: ${outcome.conflictingIds.join(', ')}`,
    )
  return {
    ok: true,
    value:
      kind === 'FACILITY'
        ? toFacilityDto(outcome.record as Parameters<typeof toFacilityDto>[0])
        : toSpecialtyDto(outcome.record as Parameters<typeof toSpecialtyDto>[0]),
  }
}

export const createFacilityAssignment = (clinicianId: string, body: unknown, actorUserId: string) =>
  createAssignment('FACILITY', clinicianId, body, actorUserId) as Promise<ClinicianAssignmentResult<ClinicianFacilityAssignmentDto>>

export const createSpecialtyAssignment = (clinicianId: string, body: unknown, actorUserId: string) =>
  createAssignment('SPECIALTY', clinicianId, body, actorUserId) as Promise<ClinicianAssignmentResult<ClinicianSpecialtyAssignmentDto>>

type CloseOutcome =
  | { kind: 'closed'; record: { id: string; clinicianId: string; effectiveFrom: Date; effectiveTo: Date | null; createdAt: Date; updatedAt: Date }; before: Date | null }
  | { kind: 'missing' }
  | { kind: 'rejected'; message: string }

async function closeAssignment(
  kind: AssignmentKind,
  assignmentId: string,
  body: unknown,
  actorUserId: string,
): Promise<ClinicianAssignmentResult<ClinicianFacilityAssignmentDto | ClinicianSpecialtyAssignmentDto>> {
  if (!isAssignmentUuid(assignmentId)) return invalid('invalid assignment id')
  const validated = validateCloseBody(body)
  if (!validated.ok) return invalid(validated.message)

  const outcome = await prisma.$transaction(async (tx): Promise<CloseOutcome> => {
    const preliminary =
      kind === 'FACILITY' ? await findFacilityAssignmentById(assignmentId, tx) : await findSpecialtyAssignmentById(assignmentId, tx)
    if (!preliminary) return { kind: 'missing' }

    // Lock the clinician first (the serialization point shared with create), then the assignment
    // row itself, and only then re-read the state the decision depends on: the before-state is
    // never read outside this transaction.
    const lockedClinician = await lockRowForUpdate(tx, 'clinicians', preliminary.clinicianId)
    if (!lockedClinician) return { kind: 'missing' }
    await concurrencyProbe('clinicianAssignment.close')
    const existing =
      kind === 'FACILITY' ? await findFacilityAssignmentById(assignmentId, tx) : await findSpecialtyAssignmentById(assignmentId, tx)
    if (!existing) return { kind: 'missing' }

    const decision = decideClose(existing, validated.value)
    if (decision.kind === 'rejected') return { kind: 'rejected', message: decision.message }

    const record =
      kind === 'FACILITY'
        ? await closeFacilityAssignmentRecord(assignmentId, decision.effectiveTo, tx)
        : await closeSpecialtyAssignmentRecord(assignmentId, decision.effectiveTo, tx)
    const clinician = await findClinicianOwnership(existing.clinicianId, tx)

    const targetField = kind === 'FACILITY' ? ('facilityId' as const) : ('specialtyId' as const)
    const targetId = kind === 'FACILITY' ? (existing as { facilityId: string }).facilityId : (existing as { specialtyId: string }).specialtyId
    await recordAuditEvent(
      {
        organizationId: clinician?.organizationId as string,
        actorUserId,
        actionCode: kind === 'FACILITY' ? 'clinicianFacilityAssignment.closed' : 'clinicianSpecialtyAssignment.closed',
        entityType: kind === 'FACILITY' ? 'CLINICIAN_FACILITY_ASSIGNMENT' : 'CLINICIAN_SPECIALTY_ASSIGNMENT',
        entityId: assignmentId,
        beforeState: clinicianAssignmentAuditSnapshot({ ...existing, targetField, targetId }),
        afterState: clinicianAssignmentAuditSnapshot({ ...record, targetField, targetId }),
      },
      tx,
    )
    return { kind: 'closed', record, before: existing.effectiveTo }
  })

  if (outcome.kind === 'missing') return notFound('assignment')
  if (outcome.kind === 'rejected') return invalid(outcome.message)
  return {
    ok: true,
    value:
      kind === 'FACILITY'
        ? toFacilityDto(outcome.record as Parameters<typeof toFacilityDto>[0])
        : toSpecialtyDto(outcome.record as Parameters<typeof toSpecialtyDto>[0]),
  }
}

export const closeFacilityAssignment = (id: string, body: unknown, actorUserId: string) =>
  closeAssignment('FACILITY', id, body, actorUserId) as Promise<ClinicianAssignmentResult<ClinicianFacilityAssignmentDto>>

export const closeSpecialtyAssignment = (id: string, body: unknown, actorUserId: string) =>
  closeAssignment('SPECIALTY', id, body, actorUserId) as Promise<ClinicianAssignmentResult<ClinicianSpecialtyAssignmentDto>>

// ---- reads ----------------------------------------------------------------------------------

export async function listFacilityAssignments(clinicianId: string): Promise<ClinicianAssignmentResult<ClinicianFacilityAssignmentDto[]>> {
  if (!isAssignmentUuid(clinicianId)) return invalid('invalid clinician id')
  if (!(await findClinicianOwnership(clinicianId))) return notFound('clinician')
  const records = await findFacilityAssignmentsByClinician(clinicianId)
  return { ok: true, value: records.map(toFacilityDto) }
}

export async function listSpecialtyAssignments(clinicianId: string): Promise<ClinicianAssignmentResult<ClinicianSpecialtyAssignmentDto[]>> {
  if (!isAssignmentUuid(clinicianId)) return invalid('invalid clinician id')
  if (!(await findClinicianOwnership(clinicianId))) return notFound('clinician')
  const records = await findSpecialtyAssignmentsByClinician(clinicianId)
  return { ok: true, value: records.map(toSpecialtyDto) }
}

export async function getFacilityAssignment(id: string): Promise<ClinicianAssignmentResult<ClinicianFacilityAssignmentDto>> {
  if (!isAssignmentUuid(id)) return invalid('invalid assignment id')
  const record = await findFacilityAssignmentById(id)
  if (!record) return notFound('assignment')
  return { ok: true, value: toFacilityDto(record) }
}

export async function getSpecialtyAssignment(id: string): Promise<ClinicianAssignmentResult<ClinicianSpecialtyAssignmentDto>> {
  if (!isAssignmentUuid(id)) return invalid('invalid assignment id')
  const record = await findSpecialtyAssignmentById(id)
  if (!record) return notFound('assignment')
  return { ok: true, value: toSpecialtyDto(record) }
}

// ---- resolvers for A4.4 / A4.9 ---------------------------------------------------------------
// These answer one question only: was this pair assigned on this date? They never decide that an
// encounter is billable, and they never pick a winner when history is ambiguous.

export async function resolveClinicianFacilityAssignment(
  clinicianId: string,
  facilityId: string,
  businessDateInput: unknown,
  db: DbClient = prisma,
): Promise<ClinicianAssignmentResult<AssignmentResolution<ClinicianFacilityAssignmentDto>>> {
  if (!isAssignmentUuid(clinicianId) || !isAssignmentUuid(facilityId)) return invalid('clinicianId and facilityId must be UUIDs')
  const businessDate = parseStrictDateOnly(businessDateInput)
  if (!businessDate) return invalid('businessDate must be a real calendar date in YYYY-MM-DD format')

  const rows = await findFacilityAssignmentsForPair(clinicianId, facilityId, db)
  const effective = rows.filter((row) => isEffectiveOnDate(row.effectiveFrom, row.effectiveTo, businessDate))
  const decision = decideResolution(effective)
  return {
    ok: true,
    value:
      decision.status === 'RESOLVED' ? { status: 'RESOLVED', assignment: toFacilityDto(decision.assignment) } : decision,
  }
}

export async function resolveClinicianSpecialtyAssignment(
  clinicianId: string,
  specialtyId: string,
  businessDateInput: unknown,
  db: DbClient = prisma,
): Promise<ClinicianAssignmentResult<AssignmentResolution<ClinicianSpecialtyAssignmentDto>>> {
  if (!isAssignmentUuid(clinicianId) || !isAssignmentUuid(specialtyId)) return invalid('clinicianId and specialtyId must be UUIDs')
  const businessDate = parseStrictDateOnly(businessDateInput)
  if (!businessDate) return invalid('businessDate must be a real calendar date in YYYY-MM-DD format')

  const rows = await findSpecialtyAssignmentsForPair(clinicianId, specialtyId, db)
  const effective = rows.filter((row) => isEffectiveOnDate(row.effectiveFrom, row.effectiveTo, businessDate))
  const decision = decideResolution(effective)
  return {
    ok: true,
    value:
      decision.status === 'RESOLVED' ? { status: 'RESOLVED', assignment: toSpecialtyDto(decision.assignment) } : decision,
  }
}

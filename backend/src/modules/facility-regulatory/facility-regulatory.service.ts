import { findFacilityById } from '../facility/facility.repository.ts'
import type { FacilityRegulatoryProfileDto, FacilityRegulatoryProfileResult } from './facility-regulatory.types.ts'
import {
  decideActiveProfileClosure,
  formatDateOnly,
  isFacilityRegulatoryProfileUuid,
  normalizeDateOnlyField,
  normalizeJurisdictionCode,
  normalizeRegulatoryAuthorityCode,
  normalizeRequiredDateOnly,
  rangesOverlap,
} from './facility-regulatory.validation.ts'
import {
  createFacilityRegulatoryProfileRecord,
  findActiveProfilesForFacility,
  findFacilityRegulatoryProfileById,
  findFacilityRegulatoryProfilesByFacilityId,
  lockFacilityForRegulatoryChange,
  updateFacilityRegulatoryProfileRecord,
} from './facility-regulatory.repository.ts'
import { prisma } from '../../shared/database/prisma.ts'
import { Prisma } from '../../../generated/prisma/client.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import { facilityRegulatoryProfileAuditSnapshot } from '../audit/audit.snapshot.ts'

type FacilityRegulatoryProfileRecord = {
  id: string
  facilityId: string
  jurisdictionCode: string
  regulatoryAuthorityCode: string
  effectiveFrom: Date
  effectiveTo: Date | null
  status: string
  createdAt: Date
  updatedAt: Date
}

// T21 / audit F05: concurrent writers must never leave two overlapping ACTIVE profiles. Every path
// that changes the ACTIVE set or an ACTIVE period (activation and update) takes the facility row
// lock first and makes all decisions on reads taken after the lock, under the default READ
// COMMITTED isolation — so each re-read sees the competing writer's committed result. (A
// SERIALIZABLE snapshot is fixed before the lock is granted and would evaluate stale rows.) The
// bounded retry is kept only for a write conflict/deadlock reported as P2034.
const MAX_ACTIVATE_RETRIES = 3

// Internal test seams (never reachable from an HTTP route): deterministic barriers for the F05
// concurrency proof. Both run inside the transaction.
export type FacilityProfileInternalOptions = {
  beforeLock?: () => Promise<void>
  afterLockedRead?: () => Promise<void>
}

function isSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034'
}

function toDto(record: FacilityRegulatoryProfileRecord): FacilityRegulatoryProfileDto {
  return {
    id: record.id,
    facilityId: record.facilityId,
    jurisdictionCode: record.jurisdictionCode,
    regulatoryAuthorityCode: record.regulatoryAuthorityCode,
    effectiveFrom: formatDateOnly(record.effectiveFrom) as string,
    effectiveTo: formatDateOnly(record.effectiveTo),
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

export async function createFacilityRegulatoryProfile(
  facilityId: string,
  jurisdictionCodeInput: unknown,
  regulatoryAuthorityCodeInput: unknown,
  effectiveFromInput: unknown,
  effectiveToInput: unknown,
  actorUserId: string,
): Promise<FacilityRegulatoryProfileResult<FacilityRegulatoryProfileDto>> {
  if (!isFacilityRegulatoryProfileUuid(facilityId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid facility id' }

  const jurisdictionCode = normalizeJurisdictionCode(jurisdictionCodeInput)
  if (!jurisdictionCode) return { ok: false, code: 'VALIDATION_ERROR', message: 'jurisdictionCode is required' }

  const regulatoryAuthorityCode = normalizeRegulatoryAuthorityCode(regulatoryAuthorityCodeInput)
  if (!regulatoryAuthorityCode)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'regulatoryAuthorityCode is required' }

  const effectiveFrom = normalizeRequiredDateOnly(effectiveFromInput)
  if (!effectiveFrom) return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveFrom must be a YYYY-MM-DD date' }

  const effectiveToField = normalizeDateOnlyField(effectiveToInput)
  if (effectiveToField.present && !effectiveToField.valid)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveTo must be a YYYY-MM-DD date or null' }
  const effectiveTo = effectiveToField.present && effectiveToField.valid ? effectiveToField.value : null

  if (effectiveTo && effectiveFrom.getTime() > effectiveTo.getTime())
    return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveFrom must not be after effectiveTo' }

  const facility = await findFacilityById(facilityId)
  if (!facility) return { ok: false, code: 'NOT_FOUND', message: 'facility not found' }

  const created = await prisma.$transaction(async (tx) => {
    const record = await createFacilityRegulatoryProfileRecord(
      { facilityId, jurisdictionCode, regulatoryAuthorityCode, effectiveFrom, effectiveTo },
      tx,
    )

    await recordAuditEvent(
      {
        organizationId: facility.organizationId,
        actorUserId,
        actionCode: 'facility_regulatory_profile.created',
        entityType: 'FACILITY_REGULATORY_PROFILE',
        entityId: record.id,
        beforeState: null,
        afterState: facilityRegulatoryProfileAuditSnapshot(record),
      },
      tx,
    )

    return record
  })

  return { ok: true, value: toDto(created) }
}

export async function getFacilityRegulatoryProfile(
  id: string,
): Promise<FacilityRegulatoryProfileResult<FacilityRegulatoryProfileDto>> {
  if (!isFacilityRegulatoryProfileUuid(id))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid facility regulatory profile id' }
  const record = await findFacilityRegulatoryProfileById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'facility regulatory profile not found' }
  return { ok: true, value: toDto(record) }
}

export async function listFacilityRegulatoryProfiles(
  facilityId: string,
): Promise<FacilityRegulatoryProfileResult<FacilityRegulatoryProfileDto[]>> {
  if (!isFacilityRegulatoryProfileUuid(facilityId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid facility id' }

  const facility = await findFacilityById(facilityId)
  if (!facility) return { ok: false, code: 'NOT_FOUND', message: 'facility not found' }

  const records = await findFacilityRegulatoryProfilesByFacilityId(facilityId)
  return { ok: true, value: records.map(toDto) }
}

export async function updateFacilityRegulatoryProfile(
  id: string,
  jurisdictionCodeInput: unknown,
  regulatoryAuthorityCodeInput: unknown,
  effectiveFromInput: unknown,
  effectiveToInput: unknown,
  actorUserId: string,
  internal: FacilityProfileInternalOptions = {},
): Promise<FacilityRegulatoryProfileResult<FacilityRegulatoryProfileDto>> {
  if (!isFacilityRegulatoryProfileUuid(id))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid facility regulatory profile id' }

  const jurisdictionCodeField = jurisdictionCodeInput !== undefined ? normalizeJurisdictionCode(jurisdictionCodeInput) : undefined
  if (jurisdictionCodeInput !== undefined && !jurisdictionCodeField)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'jurisdictionCode must be a non-empty string' }

  const regulatoryAuthorityCodeField =
    regulatoryAuthorityCodeInput !== undefined ? normalizeRegulatoryAuthorityCode(regulatoryAuthorityCodeInput) : undefined
  if (regulatoryAuthorityCodeInput !== undefined && !regulatoryAuthorityCodeField)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'regulatoryAuthorityCode must be a non-empty string' }

  const effectiveFromField = normalizeDateOnlyField(effectiveFromInput)
  if (effectiveFromField.present && (!effectiveFromField.valid || effectiveFromField.value === null))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveFrom must be a YYYY-MM-DD date' }

  const effectiveToField = normalizeDateOnlyField(effectiveToInput)
  if (effectiveToField.present && !effectiveToField.valid)
    return { ok: false, code: 'VALIDATION_ERROR', message: 'effectiveTo must be a YYYY-MM-DD date or null' }

  if (
    jurisdictionCodeInput === undefined &&
    regulatoryAuthorityCodeInput === undefined &&
    !effectiveFromField.present &&
    !effectiveToField.present
  )
    return { ok: false, code: 'VALIDATION_ERROR', message: 'at least one field is required' }

  const outcome = await prisma.$transaction(async (tx) => {
    // facilityId is immutable, so the unlocked first read is only used to find the lock target;
    // every decision below is made on the re-read taken while holding the facility lock.
    const located = await findFacilityRegulatoryProfileById(id, tx)
    if (!located) return { kind: 'not_found' as const }
    await lockFacilityForRegulatoryChange(located.facilityId, tx)
    const existing = await findFacilityRegulatoryProfileById(id, tx)
    if (!existing) return { kind: 'not_found' as const }
    await internal.afterLockedRead?.()

    if (existing.status === 'ACTIVE') {
      if (jurisdictionCodeInput !== undefined || regulatoryAuthorityCodeInput !== undefined || effectiveFromField.present)
        return {
          kind: 'terminal' as const,
          message: 'only effectiveTo may be changed once a regulatory profile is ACTIVE',
        }

      const closure = decideActiveProfileClosure(existing, effectiveToField)
      if (!closure.ok) return { kind: 'terminal' as const, message: closure.message }

      const record = await updateFacilityRegulatoryProfileRecord(id, { effectiveTo: closure.effectiveTo }, tx)

      await recordAuditEvent(
        {
          organizationId: (await findFacilityById(existing.facilityId, tx))?.organizationId as string,
          actorUserId,
          actionCode: 'facility_regulatory_profile.updated',
          entityType: 'FACILITY_REGULATORY_PROFILE',
          entityId: id,
          beforeState: facilityRegulatoryProfileAuditSnapshot(existing),
          afterState: facilityRegulatoryProfileAuditSnapshot(record),
        },
        tx,
      )

      return { kind: 'updated' as const, record }
    }

    const nextEffectiveFrom = effectiveFromField.present && effectiveFromField.valid ? effectiveFromField.value! : existing.effectiveFrom
    const nextEffectiveTo = effectiveToField.present && effectiveToField.valid ? effectiveToField.value : existing.effectiveTo
    if (nextEffectiveTo && nextEffectiveFrom.getTime() > nextEffectiveTo.getTime())
      return { kind: 'terminal' as const, message: 'effectiveFrom must not be after effectiveTo' }

    const record = await updateFacilityRegulatoryProfileRecord(
      id,
      {
        ...(jurisdictionCodeField ? { jurisdictionCode: jurisdictionCodeField } : {}),
        ...(regulatoryAuthorityCodeField ? { regulatoryAuthorityCode: regulatoryAuthorityCodeField } : {}),
        ...(effectiveFromField.present && effectiveFromField.valid ? { effectiveFrom: effectiveFromField.value! } : {}),
        ...(effectiveToField.present && effectiveToField.valid ? { effectiveTo: effectiveToField.value } : {}),
      },
      tx,
    )

    await recordAuditEvent(
      {
        organizationId: (await findFacilityById(existing.facilityId, tx))?.organizationId as string,
        actorUserId,
        actionCode: 'facility_regulatory_profile.updated',
        entityType: 'FACILITY_REGULATORY_PROFILE',
        entityId: id,
        beforeState: facilityRegulatoryProfileAuditSnapshot(existing),
        afterState: facilityRegulatoryProfileAuditSnapshot(record),
      },
      tx,
    )

    return { kind: 'updated' as const, record }
  })

  if (outcome.kind === 'not_found') return { ok: false, code: 'NOT_FOUND', message: 'facility regulatory profile not found' }
  if (outcome.kind === 'terminal') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }
  return { ok: true, value: toDto(outcome.record) }
}

export async function activateFacilityRegulatoryProfile(
  id: string,
  actorUserId: string,
  internal: FacilityProfileInternalOptions = {},
): Promise<FacilityRegulatoryProfileResult<FacilityRegulatoryProfileDto>> {
  if (!isFacilityRegulatoryProfileUuid(id))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid facility regulatory profile id' }

  for (let attempt = 1; attempt <= MAX_ACTIVATE_RETRIES; attempt += 1) {
    try {
      const outcome = await prisma.$transaction(
        async (tx) => {
          const located = await findFacilityRegulatoryProfileById(id, tx)
          if (!located) return { kind: 'not_found' as const }
          await internal.beforeLock?.()
          // Audit F05: same facility lock as the update path, so an INACTIVE-period edit can never
          // land after this activation has checked the period (or vice versa).
          await lockFacilityForRegulatoryChange(located.facilityId, tx)
          const existing = await findFacilityRegulatoryProfileById(id, tx)
          if (!existing) return { kind: 'not_found' as const }
          await internal.afterLockedRead?.()
          if (existing.status !== 'INACTIVE')
            return { kind: 'terminal' as const, message: 'activate is only allowed from INACTIVE' }

          const activeSiblings = await findActiveProfilesForFacility(existing.facilityId, id, tx)
          const overlaps = activeSiblings.some((sibling) =>
            rangesOverlap(existing.effectiveFrom, existing.effectiveTo, sibling.effectiveFrom, sibling.effectiveTo),
          )
          if (overlaps)
            return {
              kind: 'terminal' as const,
              message: 'overlaps with an existing ACTIVE regulatory profile for this facility',
            }

          const record = await updateFacilityRegulatoryProfileRecord(id, { status: 'ACTIVE' }, tx)

          await recordAuditEvent(
            {
              organizationId: (await findFacilityById(existing.facilityId, tx))?.organizationId as string,
              actorUserId,
              actionCode: 'facility_regulatory_profile.activated',
              entityType: 'FACILITY_REGULATORY_PROFILE',
              entityId: id,
              beforeState: facilityRegulatoryProfileAuditSnapshot(existing),
              afterState: facilityRegulatoryProfileAuditSnapshot(record),
            },
            tx,
          )

          return { kind: 'updated' as const, record }
        },
      )

      if (outcome.kind === 'not_found') return { ok: false, code: 'NOT_FOUND', message: 'facility regulatory profile not found' }
      if (outcome.kind === 'terminal') return { ok: false, code: 'VALIDATION_ERROR', message: outcome.message }
      return { ok: true, value: toDto(outcome.record) }
    } catch (error) {
      if (isSerializationConflict(error) && attempt < MAX_ACTIVATE_RETRIES) {
        console.warn(`[facility-regulatory] write conflict on activate (attempt ${attempt}/${MAX_ACTIVATE_RETRIES}) — retrying`)
        continue
      }
      if (isSerializationConflict(error))
        return { ok: false, code: 'VALIDATION_ERROR', message: 'this profile could not be activated due to a concurrent conflict; please retry' }
      throw error
    }
  }

  // Unreachable: the loop above always returns or throws within MAX_ACTIVATE_RETRIES attempts.
  return { ok: false, code: 'VALIDATION_ERROR', message: 'activation failed after repeated concurrent conflicts' }
}

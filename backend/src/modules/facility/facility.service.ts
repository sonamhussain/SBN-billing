import { getOrganization } from '../organization/organization.service.ts'
import type { FacilityDto, FacilityResult } from './facility.types.ts'
import { isFacilityUuid, normalizeFacilityName } from './facility.validation.ts'
import { createFacilityRecord, findFacilityById, updateFacilityRecord } from './facility.repository.ts'

type FacilityRecord = { id: string; organizationId: string; name: string; createdAt: Date; updatedAt: Date }

function toDto(record: FacilityRecord): FacilityDto {
  return {
    id: record.id, organizationId: record.organizationId, name: record.name,
    createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
  }
}

export async function createFacility(organizationId: string, nameInput: unknown): Promise<FacilityResult<FacilityDto>> {
  if (!isFacilityUuid(organizationId))
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }

  const name = normalizeFacilityName(nameInput)
  if (!name) return { ok: false, code: 'VALIDATION_ERROR', message: 'name is required' }

  const organization = await getOrganization(organizationId)
  if (!organization.ok)
    return { ok: false, code: organization.code, message: organization.message }

  return { ok: true, value: toDto(await createFacilityRecord(organizationId, name)) }
}

export async function getFacility(id: string): Promise<FacilityResult<FacilityDto>> {
  if (!isFacilityUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid facility id' }
  const record = await findFacilityById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'facility not found' }
  return { ok: true, value: toDto(record) }
}

export async function updateFacility(id: string, nameInput: unknown): Promise<FacilityResult<FacilityDto>> {
  if (!isFacilityUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid facility id' }
  const name = normalizeFacilityName(nameInput)
  if (!name) return { ok: false, code: 'VALIDATION_ERROR', message: 'name is required' }
  const existing = await findFacilityById(id)
  if (!existing) return { ok: false, code: 'NOT_FOUND', message: 'facility not found' }
  return { ok: true, value: toDto(await updateFacilityRecord(id, name)) }
}

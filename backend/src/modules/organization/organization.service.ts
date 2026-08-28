import type { OrganizationDto, ServiceResult } from './organization.types.ts'
import { isUuid, normalizeOrganizationName } from './organization.validation.ts'
import {
  createOrganizationRecord,
  findOrganizationById,
  updateOrganizationRecord,
} from './organization.repository.ts'

type OrganizationRecord = {
  id: string
  name: string
  createdAt: Date
  updatedAt: Date
}

function toDto(record: OrganizationRecord): OrganizationDto {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

export async function createOrganization(
  nameInput: unknown,
): Promise<ServiceResult<OrganizationDto>> {
  const name = normalizeOrganizationName(nameInput)

  if (!name) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'name is required' }
  }

  const record = await createOrganizationRecord(name)
  return { ok: true, value: toDto(record) }
}

export async function getOrganization(
  id: string,
): Promise<ServiceResult<OrganizationDto>> {
  if (!isUuid(id)) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }
  }

  const record = await findOrganizationById(id)

  if (!record) {
    return { ok: false, code: 'NOT_FOUND', message: 'organization not found' }
  }

  return { ok: true, value: toDto(record) }
}

export async function updateOrganization(
  id: string,
  nameInput: unknown,
): Promise<ServiceResult<OrganizationDto>> {
  if (!isUuid(id)) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid organization id' }
  }

  const name = normalizeOrganizationName(nameInput)

  if (!name) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'name is required' }
  }

  const existing = await findOrganizationById(id)

  if (!existing) {
    return { ok: false, code: 'NOT_FOUND', message: 'organization not found' }
  }

  const updated = await updateOrganizationRecord(id, name)
  return { ok: true, value: toDto(updated) }
}

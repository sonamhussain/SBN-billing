import type {
  ReferenceDatasetDto,
  ReferenceDatasetResult,
  ReferenceDatasetVersionDto,
} from './reference-dataset.types.ts'
import { isReferenceDatasetUuid } from './reference-dataset.validation.ts'
import {
  findAllReferenceDatasets,
  findReferenceDatasetById,
  findReferenceDatasetVersionById,
  findReferenceDatasetVersionsByDatasetId,
} from './reference-dataset.repository.ts'
import { formatDateOnly } from '../rule-source-version/rule-source-version.validation.ts'

type ReferenceDatasetRecord = {
  id: string
  datasetKey: string
  displayName: string
  jurisdictionCode: string
  authorityCode: string
  createdAt: Date
  updatedAt: Date
}

type ReferenceDatasetVersionRecord = {
  id: string
  datasetId: string
  sourceVersionId: string | null
  version: string
  retrievedAt: Date
  publicationDate: Date | null
  effectiveFrom: Date | null
  effectiveTo: Date | null
  contentHash: string
  validationStatus: string
  activationStatus: string
  activatedAt: Date | null
  supersededAt: Date | null
  retiredAt: Date | null
  createdAt: Date
  updatedAt: Date
}

function toDto(record: ReferenceDatasetRecord): ReferenceDatasetDto {
  return {
    id: record.id,
    datasetKey: record.datasetKey,
    displayName: record.displayName,
    jurisdictionCode: record.jurisdictionCode,
    authorityCode: record.authorityCode,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function toVersionDto(record: ReferenceDatasetVersionRecord): ReferenceDatasetVersionDto {
  return {
    id: record.id,
    datasetId: record.datasetId,
    sourceVersionId: record.sourceVersionId,
    version: record.version,
    retrievedAt: record.retrievedAt.toISOString(),
    publicationDate: formatDateOnly(record.publicationDate),
    effectiveFrom: formatDateOnly(record.effectiveFrom),
    effectiveTo: formatDateOnly(record.effectiveTo),
    contentHash: record.contentHash,
    validationStatus: record.validationStatus,
    activationStatus: record.activationStatus,
    activatedAt: record.activatedAt ? record.activatedAt.toISOString() : null,
    supersededAt: record.supersededAt ? record.supersededAt.toISOString() : null,
    retiredAt: record.retiredAt ? record.retiredAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

export async function listReferenceDatasets(): Promise<ReferenceDatasetResult<ReferenceDatasetDto[]>> {
  const records = await findAllReferenceDatasets()
  return { ok: true, value: records.map(toDto) }
}

export async function getReferenceDataset(id: string): Promise<ReferenceDatasetResult<ReferenceDatasetDto>> {
  if (!isReferenceDatasetUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid reference dataset id' }
  const record = await findReferenceDatasetById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'reference dataset not found' }
  return { ok: true, value: toDto(record) }
}

export async function listReferenceDatasetVersions(datasetId: string): Promise<ReferenceDatasetResult<ReferenceDatasetVersionDto[]>> {
  if (!isReferenceDatasetUuid(datasetId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid reference dataset id' }
  const dataset = await findReferenceDatasetById(datasetId)
  if (!dataset) return { ok: false, code: 'NOT_FOUND', message: 'reference dataset not found' }
  const records = await findReferenceDatasetVersionsByDatasetId(datasetId)
  return { ok: true, value: records.map(toVersionDto) }
}

export async function getReferenceDatasetVersion(id: string): Promise<ReferenceDatasetResult<ReferenceDatasetVersionDto>> {
  if (!isReferenceDatasetUuid(id)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid reference dataset version id' }
  const record = await findReferenceDatasetVersionById(id)
  if (!record) return { ok: false, code: 'NOT_FOUND', message: 'reference dataset version not found' }
  return { ok: true, value: toVersionDto(record) }
}

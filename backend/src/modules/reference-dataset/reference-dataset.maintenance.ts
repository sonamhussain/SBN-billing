// REF-01 / R3 — controlled internal maintenance surface for the system-wide reference dataset
// registry. ReferenceDataset/ReferenceDatasetVersion carry no organizationId (they are
// SYSTEM_SHARED by construction), so they are intentionally NOT reachable through any
// tenant-authenticated mutation route and never write to the tenant AuditEvent table (which
// requires a non-null organizationId) — lifecycle is reconstructed from the version's own
// state/timestamp fields instead. Call these only from a trusted internal script/CLI.
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import {
  createReferenceDatasetRecord,
  createReferenceDatasetVersionRecord,
  findActiveVersionForDataset,
  findReferenceDatasetVersionById,
  updateReferenceDatasetVersionRecord,
} from './reference-dataset.repository.ts'
import {
  isReferenceDatasetValidationStatus,
  normalizeContentHash,
  normalizeDatasetKey,
  normalizeReferenceDatasetAuthorityCode,
  normalizeReferenceDatasetDisplayName,
  normalizeReferenceDatasetJurisdictionCode,
  normalizeReferenceDatasetVersion,
} from './reference-dataset.validation.ts'
import { normalizeDateOnlyField } from '../rule-source-version/rule-source-version.validation.ts'

export type MaintenanceResult<T> = { ok: true; value: T } | { ok: false; message: string }

export async function importReferenceDataset(input: {
  datasetKey: unknown
  displayName: unknown
  jurisdictionCode: unknown
  authorityCode: unknown
}): Promise<MaintenanceResult<{ id: string }>> {
  const datasetKey = normalizeDatasetKey(input.datasetKey)
  if (!datasetKey) return { ok: false, message: 'datasetKey is required' }
  const displayName = normalizeReferenceDatasetDisplayName(input.displayName)
  if (!displayName) return { ok: false, message: 'displayName is required' }
  const jurisdictionCode = normalizeReferenceDatasetJurisdictionCode(input.jurisdictionCode)
  if (!jurisdictionCode) return { ok: false, message: 'jurisdictionCode is required' }
  const authorityCode = normalizeReferenceDatasetAuthorityCode(input.authorityCode)
  if (!authorityCode) return { ok: false, message: 'authorityCode is required' }

  const record = await createReferenceDatasetRecord({ datasetKey, displayName, jurisdictionCode, authorityCode })
  return { ok: true, value: { id: record.id } }
}

export async function importReferenceDatasetVersion(input: {
  datasetId: string
  sourceVersionId?: string | null
  version: unknown
  retrievedAt: unknown
  publicationDate?: unknown
  effectiveFrom?: unknown
  effectiveTo?: unknown
  contentHash: unknown
}): Promise<MaintenanceResult<{ id: string }>> {
  const version = normalizeReferenceDatasetVersion(input.version)
  if (!version) return { ok: false, message: 'version is required' }
  const contentHash = normalizeContentHash(input.contentHash)
  if (!contentHash) return { ok: false, message: 'contentHash is required' }
  if (typeof input.retrievedAt !== 'string') return { ok: false, message: 'retrievedAt is required' }
  const retrievedAt = new Date(input.retrievedAt)
  if (Number.isNaN(retrievedAt.getTime())) return { ok: false, message: 'retrievedAt must be a valid timestamp' }

  const publicationDateField = normalizeDateOnlyField(input.publicationDate)
  const effectiveFromField = normalizeDateOnlyField(input.effectiveFrom)
  const effectiveToField = normalizeDateOnlyField(input.effectiveTo)

  const record = await createReferenceDatasetVersionRecord({
    datasetId: input.datasetId,
    sourceVersionId: input.sourceVersionId ?? null,
    version,
    retrievedAt,
    publicationDate: publicationDateField.present && publicationDateField.valid ? publicationDateField.value : null,
    effectiveFrom: effectiveFromField.present && effectiveFromField.valid ? effectiveFromField.value : null,
    effectiveTo: effectiveToField.present && effectiveToField.valid ? effectiveToField.value : null,
    contentHash,
  })
  return { ok: true, value: { id: record.id } }
}

const terminalActivationStatuses: readonly string[] = ['RETIRED']

export async function validateReferenceDatasetVersion(
  id: string,
  validationStatusInput: unknown,
): Promise<MaintenanceResult<{ id: string; validationStatus: string }>> {
  if (!isReferenceDatasetValidationStatus(validationStatusInput))
    return { ok: false, message: 'validationStatus must be PENDING, VALID, or INVALID' }

  const existing = await findReferenceDatasetVersionById(id)
  if (!existing) return { ok: false, message: 'reference dataset version not found' }
  if (terminalActivationStatuses.includes(existing.activationStatus))
    return { ok: false, message: 'reference dataset version is retired and cannot be changed' }

  const record = await updateReferenceDatasetVersionRecord(id, { validationStatus: validationStatusInput })
  return { ok: true, value: { id: record.id, validationStatus: record.validationStatus } }
}

// Activating a version supersedes the dataset's current ACTIVE version (if any) in the same
// transaction — a dataset has at most one ACTIVE version. Re-activating a previously SUPERSEDED
// version is a valid rollback: it simply becomes ACTIVE again and supersedes today's ACTIVE one.
export async function activateReferenceDatasetVersion(id: string): Promise<MaintenanceResult<{ id: string; activationStatus: string }>> {
  const outcome = await prisma.$transaction(async (tx: DbClient) => {
    const existing = await findReferenceDatasetVersionById(id, tx)
    if (!existing) return { kind: 'not_found' as const }
    if (existing.activationStatus === 'RETIRED')
      return { kind: 'terminal' as const, message: 'reference dataset version is retired and cannot be changed' }
    if (existing.validationStatus !== 'VALID')
      return { kind: 'terminal' as const, message: 'only a VALID reference dataset version can be activated' }

    const currentActive = await findActiveVersionForDataset(existing.datasetId, id, tx)
    if (currentActive) {
      await updateReferenceDatasetVersionRecord(currentActive.id, { activationStatus: 'SUPERSEDED', supersededAt: new Date() }, tx)
    }

    const record = await updateReferenceDatasetVersionRecord(id, { activationStatus: 'ACTIVE', activatedAt: new Date() }, tx)
    return { kind: 'updated' as const, record }
  })

  if (outcome.kind === 'not_found') return { ok: false, message: 'reference dataset version not found' }
  if (outcome.kind === 'terminal') return { ok: false, message: outcome.message }
  return { ok: true, value: { id: outcome.record.id, activationStatus: outcome.record.activationStatus } }
}

export async function retireReferenceDatasetVersion(id: string): Promise<MaintenanceResult<{ id: string; activationStatus: string }>> {
  const existing = await findReferenceDatasetVersionById(id)
  if (!existing) return { ok: false, message: 'reference dataset version not found' }
  if (existing.activationStatus === 'RETIRED') return { ok: false, message: 'reference dataset version is already retired' }

  const record = await updateReferenceDatasetVersionRecord(id, { activationStatus: 'RETIRED', retiredAt: new Date() })
  return { ok: true, value: { id: record.id, activationStatus: record.activationStatus } }
}

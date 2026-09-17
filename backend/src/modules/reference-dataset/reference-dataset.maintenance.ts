// REF-01 / R3 — controlled internal maintenance surface for the system-wide reference dataset
// registry. ReferenceDataset/ReferenceDatasetVersion carry no organizationId (they are
// SYSTEM_SHARED by construction), so they are intentionally NOT reachable through any
// tenant-authenticated mutation route and never write to the tenant AuditEvent table (which
// requires a non-null organizationId, and no organizationId is ever invented to force them in).
// Audit F12: successful lifecycle transitions are instead appended to the dedicated, append-only
// ReferenceDatasetLifecycleEvent history, in the same transaction as the state change — the
// version's own state/timestamp fields alone cannot reconstruct a rollback chain.
// Call these only from a trusted internal script/CLI.
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import {
  createReferenceDatasetRecord,
  createReferenceDatasetVersionRecord,
  findActiveVersionForDataset,
  findReferenceDatasetById,
  findReferenceDatasetVersionById,
  recordReferenceDatasetLifecycleEvent,
  updateReferenceDatasetVersionRecord,
} from './reference-dataset.repository.ts'
import {
  decideDatasetValidationChange,
  isReferenceDatasetValidationStatus,
  normalizeContentHash,
  normalizeDatasetKey,
  normalizeReferenceDatasetAuthorityCode,
  normalizeReferenceDatasetDisplayName,
  normalizeReferenceDatasetJurisdictionCode,
  normalizeReferenceDatasetVersion,
} from './reference-dataset.validation.ts'
import { normalizeDateOnlyField } from '../rule-source-version/rule-source-version.validation.ts'
import { parseStrictTimestamp } from '../../shared/rules/date-only.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'

export type MaintenanceResult<T> = { ok: true; value: T } | { ok: false; message: string }

// Audit F12 — who performed a maintenance transition, and why. Datasets are SYSTEM_SHARED, so
// there is no tenant user to attribute this to and no organizationId is invented; the caller is a
// trusted internal script or CLI and identifies itself here.
export type MaintenanceActor = { actorRef: string; reason?: string | null }

export const defaultMaintenanceActor: MaintenanceActor = { actorRef: 'internal-maintenance', reason: null }

export const datasetLifecycleActions = ['VALIDATE', 'ACTIVATE', 'SUPERSEDE', 'RETIRE', 'ROLLBACK'] as const

export type DatasetLifecycleAction = (typeof datasetLifecycleActions)[number]

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
  if (input.retrievedAt === undefined || input.retrievedAt === null) return { ok: false, message: 'retrievedAt is required' }
  // Audit F07: `new Date(string)` accepted "2026", free-text dates and rolled overflowing days
  // forward. retrievedAt must be an explicit ISO-8601 instant with a real calendar day and zone.
  const retrievedAt = parseStrictTimestamp(input.retrievedAt)
  if (!retrievedAt) return { ok: false, message: 'retrievedAt must be an ISO-8601 timestamp with a timezone' }

  const publicationDateField = normalizeDateOnlyField(input.publicationDate)
  const effectiveFromField = normalizeDateOnlyField(input.effectiveFrom)
  const effectiveToField = normalizeDateOnlyField(input.effectiveTo)

  // Audit F07: a present-but-invalid optional date used to fall through to null and be inserted as
  // "undated". It is now a typed maintenance error, returned before any database read or write.
  // Absent and explicit null both still mean "not provided" — undated drafts remain supported.
  if (publicationDateField.present && !publicationDateField.valid)
    return { ok: false, message: 'publicationDate must be a real YYYY-MM-DD date or null' }
  if (effectiveFromField.present && !effectiveFromField.valid)
    return { ok: false, message: 'effectiveFrom must be a real YYYY-MM-DD date or null' }
  if (effectiveToField.present && !effectiveToField.valid)
    return { ok: false, message: 'effectiveTo must be a real YYYY-MM-DD date or null' }

  const effectiveFrom = effectiveFromField.present && effectiveFromField.valid ? effectiveFromField.value : null
  const effectiveTo = effectiveToField.present && effectiveToField.valid ? effectiveToField.value : null
  // T50: contradictory effective dates rejected.
  if (effectiveFrom && effectiveTo && effectiveFrom.getTime() > effectiveTo.getTime())
    return { ok: false, message: 'effectiveFrom must not be after effectiveTo' }

  const dataset = await findReferenceDatasetById(input.datasetId)
  if (!dataset) return { ok: false, message: 'reference dataset not found' }

  // T57: sourceVersionId, when supplied, must resolve an existing RuleSourceVersion whose
  // parent RuleSource jurisdiction is compatible with this dataset's own jurisdiction.
  const sourceVersionId = input.sourceVersionId ?? null
  if (sourceVersionId) {
    const sourceVersion = await prisma.ruleSourceVersion.findUnique({
      where: { id: sourceVersionId },
      select: { source: { select: { jurisdictionCode: true } } },
    })
    if (!sourceVersion) return { ok: false, message: 'sourceVersionId not found' }
    if (sourceVersion.source.jurisdictionCode.trim().toUpperCase() !== dataset.jurisdictionCode.trim().toUpperCase())
      return { ok: false, message: 'sourceVersionId jurisdiction is not compatible with this reference dataset' }
  }

  const record = await createReferenceDatasetVersionRecord({
    datasetId: input.datasetId,
    sourceVersionId,
    version,
    retrievedAt,
    publicationDate: publicationDateField.present && publicationDateField.valid ? publicationDateField.value : null,
    effectiveFrom,
    effectiveTo,
    contentHash,
  })
  return { ok: true, value: { id: record.id } }
}

// Audit F11 — validate, activate and retire all decide on the CURRENT state of the dataset's
// versions, and activate additionally rewrites a sibling. They therefore share one parent-level
// protocol: lock the dataset row FOR UPDATE, re-read the version inside that transaction, decide,
// write. Two operations on the same dataset can then never interleave, whichever pair they are.
// The database guards added alongside (one ACTIVE per dataset, ACTIVE implies VALIDATED) are the
// final backstop, not a substitute for this transaction and its sanitized typed error.
type DatasetVersionRecord = { id: string; datasetId: string; activationStatus: string; validationStatus: string }

type DatasetWriteOutcome =
  | { kind: 'not_found' }
  | { kind: 'terminal'; message: string }
  | { kind: 'updated'; record: DatasetVersionRecord }

async function withDatasetLock(
  versionId: string,
  probeName: string,
  decide: (existing: DatasetVersionRecord, tx: DbClient) => Promise<DatasetWriteOutcome>,
): Promise<DatasetWriteOutcome> {
  // This first read is used ONLY to learn which parent row to lock; every decision below is made
  // from the re-read performed while the lock is held.
  const target = await findReferenceDatasetVersionById(versionId)
  if (!target) return { kind: 'not_found' as const }

  return prisma.$transaction(async (tx: DbClient) => {
    await lockRowForUpdate(tx, 'reference_datasets', target.datasetId)
    const existing = await findReferenceDatasetVersionById(versionId, tx)
    if (!existing) return { kind: 'not_found' as const }
    await concurrencyProbe(probeName)
    return decide(existing, tx)
  })
}

// Audit F12 — every SUCCESSFUL transition appends one immutable event, in the same transaction as
// the state change, so a rollback chain (v1 -> v2 -> v1 -> v2) stays reconstructable even though
// re-activating a version overwrites its activated_at. Refused operations write nothing: the
// history records what happened, not what was attempted.
async function appendLifecycleEvent(
  tx: DbClient,
  before: DatasetVersionRecord,
  after: DatasetVersionRecord,
  action: DatasetLifecycleAction,
  actor: MaintenanceActor,
): Promise<void> {
  await recordReferenceDatasetLifecycleEvent(
    {
      datasetId: before.datasetId,
      datasetVersionId: before.id,
      action,
      previousActivationStatus: before.activationStatus,
      nextActivationStatus: after.activationStatus,
      previousValidationStatus: before.validationStatus,
      nextValidationStatus: after.validationStatus,
      actorRef: actor.actorRef,
      reason: actor.reason ?? null,
    },
    tx,
  )
}

export async function validateReferenceDatasetVersion(
  id: string,
  validationStatusInput: unknown,
  actor: MaintenanceActor = defaultMaintenanceActor,
): Promise<MaintenanceResult<{ id: string; validationStatus: string }>> {
  if (!isReferenceDatasetValidationStatus(validationStatusInput))
    return { ok: false, message: 'validationStatus must be UNVALIDATED, VALIDATED, or REJECTED' }

  const outcome = await withDatasetLock(id, 'reference_dataset.validate', async (existing, tx) => {
    const decision = decideDatasetValidationChange(existing, validationStatusInput)
    if (decision.kind === 'rejected') return { kind: 'terminal' as const, message: decision.message }
    const record = await updateReferenceDatasetVersionRecord(id, { validationStatus: validationStatusInput }, tx)
    await appendLifecycleEvent(tx, existing, record, 'VALIDATE', actor)
    return { kind: 'updated' as const, record }
  })

  if (outcome.kind === 'not_found') return { ok: false, message: 'reference dataset version not found' }
  if (outcome.kind === 'terminal') return { ok: false, message: outcome.message }
  return { ok: true, value: { id: outcome.record.id, validationStatus: outcome.record.validationStatus } }
}

// Activating a version supersedes the dataset's current ACTIVE version (if any) in the same
// transaction — a dataset has at most one ACTIVE version. Re-activating a previously SUPERSEDED
// version is a valid rollback: it simply becomes ACTIVE again and supersedes today's ACTIVE one.
export async function activateReferenceDatasetVersion(
  id: string,
  actor: MaintenanceActor = defaultMaintenanceActor,
): Promise<MaintenanceResult<{ id: string; activationStatus: string }>> {
  const outcome = await withDatasetLock(id, 'reference_dataset.activate', async (existing, tx) => {
    if (existing.activationStatus === 'RETIRED')
      return { kind: 'terminal' as const, message: 'reference dataset version is retired and cannot be changed' }
    if (existing.validationStatus !== 'VALIDATED')
      return { kind: 'terminal' as const, message: 'only a VALIDATED reference dataset version can be activated' }

    // Read under the parent lock, so a competing activation on this dataset has either already
    // committed (and is seen here) or is still waiting for this transaction to finish.
    const currentActive = await findActiveVersionForDataset(existing.datasetId, id, tx)
    if (currentActive) {
      const superseded = await updateReferenceDatasetVersionRecord(
        currentActive.id,
        { activationStatus: 'SUPERSEDED', supersededAt: new Date() },
        tx,
      )
      // Audit F12: the supersession is its own transition, committed with the activation that
      // caused it. Its sequence number is lower, so the pair is ordered even at the same instant.
      await appendLifecycleEvent(tx, currentActive, superseded, 'SUPERSEDE', actor)
    }

    const record = await updateReferenceDatasetVersionRecord(id, { activationStatus: 'ACTIVE', activatedAt: new Date() }, tx)
    // Re-activating a version that was already superseded is a rollback, and is recorded as one:
    // the previous/next states alone would not distinguish it from a first activation later.
    await appendLifecycleEvent(tx, existing, record, existing.activationStatus === 'SUPERSEDED' ? 'ROLLBACK' : 'ACTIVATE', actor)
    return { kind: 'updated' as const, record }
  })

  if (outcome.kind === 'not_found') return { ok: false, message: 'reference dataset version not found' }
  if (outcome.kind === 'terminal') return { ok: false, message: outcome.message }
  return { ok: true, value: { id: outcome.record.id, activationStatus: outcome.record.activationStatus } }
}

export async function retireReferenceDatasetVersion(
  id: string,
  actor: MaintenanceActor = defaultMaintenanceActor,
): Promise<MaintenanceResult<{ id: string; activationStatus: string }>> {
  const outcome = await withDatasetLock(id, 'reference_dataset.retire', async (existing, tx) => {
    if (existing.activationStatus === 'RETIRED')
      return { kind: 'terminal' as const, message: 'reference dataset version is already retired' }
    const record = await updateReferenceDatasetVersionRecord(id, { activationStatus: 'RETIRED', retiredAt: new Date() }, tx)
    await appendLifecycleEvent(tx, existing, record, 'RETIRE', actor)
    return { kind: 'updated' as const, record }
  })

  if (outcome.kind === 'not_found') return { ok: false, message: 'reference dataset version not found' }
  if (outcome.kind === 'terminal') return { ok: false, message: outcome.message }
  return { ok: true, value: { id: outcome.record.id, activationStatus: outcome.record.activationStatus } }
}

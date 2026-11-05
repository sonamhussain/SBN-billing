import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { readTransactionTimestamp } from '../encounter-billing-context/encounter-billing-context.repository.ts'
import { membershipFingerprint, parseReleaseArtifact } from './coding-release.artifact.ts'
import { decideCode, diagnosisIdentity, procedureIdentity } from './coding-release.resolver.ts'
import {
  findActiveCodedActivitiesOfEncounter,
  findActiveDiagnosesOfEncounter,
  findDatasetCodeSystem,
  findDatasetForCodingRelease,
  findEncounterForCodingRelease,
  findLatestRights,
  findMappedEditions,
  findMemberships,
  insertDatasetCodeSystem,
  insertReleaseImport,
  insertReleaseMemberships,
  insertRetirementClassification,
  insertRightsDecision,
} from './coding-release.repository.ts'
import {
  CODESET_CONTRACT_VERSION,
  type CodeIdentity,
  type CodeSystem,
  type CodingReleaseCheckDto,
  type CodingReleaseItemDto,
  type CodingReleaseResult,
  type EditionFacts,
  type MappingPurpose,
  type RetirementClassification,
  type RightsStatus,
} from './coding-release.types.ts'
import { isCodingReleaseUuid, validateDatasetCodeSystem, validateReleaseImport, validateRetirementClassification, validateRightsDecision } from './coding-release.validation.ts'

// CRG-01 FINAL Checkpoint A — the encounter's coding-release check (read only) and the four maintenance writers that
// prepare synthetic editions. Nothing here blocks a claim, writes a validation finding, changes an encounter, an A2
// master row, an A3 dataset or version, or a frozen claim; a decision is an answer, never an action (Checkpoint B).

const NOT_FOUND = 'encounter not found'
const integrity = (message: string): CodingReleaseResult<never> => ({ ok: false, code: 'SOURCE_INTEGRITY_CONFLICT', message })

// ---- read (§4.1 read-only scoped diagnostics) -----------------------------------------------------------------

// One encounter's decision for every current diagnosis and coded activity, on the CALLER's transaction — what a later,
// separately approved Checkpoint B validator consults. The scope is the encounter's own service date and its facility
// regulatory profile's jurisdiction and authority; a code of another organization, or a stored history that
// contradicts itself, refuses the whole read (no partial answer).
export async function getCodingReleaseCheckOf(encounterId: string, tx: DbClient): Promise<CodingReleaseResult<CodingReleaseCheckDto>> {
  if (!isCodingReleaseUuid(encounterId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid encounter id' }
  const id = encounterId.toLowerCase()
  const encounter = await findEncounterForCodingRelease(id, tx)
  if (!encounter) return { ok: false, code: 'NOT_FOUND', message: NOT_FOUND }
  const serviceDate = formatDateOnly(encounter.serviceDate)
  if (!serviceDate) return integrity('the encounter has no calendar service date')
  const organizationId = encounter.patient.organizationId
  const { jurisdictionCode, regulatoryAuthorityCode: authorityCode } = encounter.facilityRegulatoryProfile
  const rights: Partial<Record<CodeSystem, RightsStatus>> = {}
  for (const row of await findLatestRights(jurisdictionCode, authorityCode, tx)) rights[row.code_system as CodeSystem] = row.rights_status as RightsStatus
  const scope = { serviceDate, jurisdictionCode, authorityCode, rights }

  const editions: EditionFacts[] = (await findMappedEditions(jurisdictionCode, authorityCode, tx)).map((row) => ({
    datasetVersionId: row.dataset_version_id,
    datasetId: row.dataset_id,
    datasetJurisdictionCode: row.dataset_jurisdiction_code,
    datasetAuthorityCode: row.dataset_authority_code,
    mappingCodeSystem: row.mapping_code_system,
    mappingPurpose: row.mapping_purpose,
    mappingJurisdictionCode: row.mapping_jurisdiction_code,
    mappingAuthorityCode: row.mapping_authority_code,
    version: row.version,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    validationStatus: row.validation_status,
    activationStatus: row.activation_status,
    contentHash: row.content_hash,
    sourceVersionId: row.source_version_id,
    lifecycle: row.lifecycle,
    importId: row.import_id,
    importSourceFileSha256: row.import_source_file_sha256,
    importMembershipFingerprint: row.import_membership_fingerprint_sha256,
    importExpectedRowCount: row.import_expected_row_count,
    importRowCount: row.import_row_count,
    retirementClassification: row.retirement_classification,
  }))
  const mappedSystems = [...new Set(editions.map((edition) => edition.mappingCodeSystem))]

  type Subject = { subjectKind: 'DIAGNOSIS' | 'PROCEDURE'; subjectId: string; masterCodeId: string; identity: CodeIdentity }
  const subjects: Subject[] = []
  for (const row of await findActiveDiagnosesOfEncounter(id, tx)) {
    if (row.diagnosisCode.organizationId !== organizationId) return integrity("a diagnosis names another organization's code")
    subjects.push({ subjectKind: 'DIAGNOSIS', subjectId: row.id, masterCodeId: row.diagnosisCode.id, identity: diagnosisIdentity(row.diagnosisCode.code, mappedSystems) })
  }
  for (const row of await findActiveCodedActivitiesOfEncounter(id, tx)) {
    const master = row.procedureCode
    if (!master) continue
    if (master.organizationId !== organizationId) return integrity("an activity names another organization's code")
    subjects.push({ subjectKind: 'PROCEDURE', subjectId: row.id, masterCodeId: master.id, identity: procedureIdentity(master.codeSystem, master.externalCode) })
  }

  // First every edition decision, then one membership read for exactly the codes that reached an edition.
  const wanted: { datasetVersionId: string; codeSystem: CodeSystem; code: string }[] = []
  for (const subject of subjects) {
    const probe = decideCode(scope, subject.identity, editions, (datasetVersionId, codeSystem, code) => {
      wanted.push({ datasetVersionId, codeSystem, code })
      return null
    })
    if (!probe.ok) return integrity(`the stored coding-release history is inconsistent: ${probe.detail}`)
  }
  const memberships = await findMemberships(wanted, tx)
  const items: CodingReleaseItemDto[] = []
  for (const subject of subjects) {
    const decided = decideCode(scope, subject.identity, editions, (datasetVersionId, codeSystem, code) => memberships.get(`${datasetVersionId}|${codeSystem}|${code}`) ?? null)
    if (!decided.ok) return integrity(`the stored coding-release history is inconsistent: ${decided.detail}`)
    items.push({ subjectKind: subject.subjectKind, subjectId: subject.subjectId, masterCodeId: subject.masterCodeId, ...decided.value })
  }
  const evaluatedAt = await readTransactionTimestamp(tx)
  return { ok: true, value: { contractVersion: CODESET_CONTRACT_VERSION, encounterId: id, serviceDate, jurisdictionCode, authorityCode, items, evaluatedAt: evaluatedAt.toISOString() } }
}

// The public read, from one READ ONLY snapshot.
export async function getCodingReleaseCheck(encounterId: string): Promise<CodingReleaseResult<CodingReleaseCheckDto>> {
  if (!isCodingReleaseUuid(encounterId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid encounter id' }
  return withReadSnapshot(undefined, (tx) => getCodingReleaseCheckOf(encounterId, tx))
}

// ---- maintenance (no HTTP route; synthetic preparation in Checkpoint A) ---------------------------------------

class Refusal extends Error {
  readonly code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'SOURCE_INTEGRITY_CONFLICT' | 'CODING_RELEASE_CONFLICT'
  constructor(code: Refusal['code'], message: string) {
    super(message)
    this.code = code
  }
}
const refuse = (code: Refusal['code'], message: string): never => {
  throw new Refusal(code, message)
}
const isUniqueViolation = (error: unknown) =>
  (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || (error instanceof Error && /duplicate key value violates unique constraint|23505/.test(error.message))

// One SERIALIZABLE transaction per write. A refusal is answered; a database refusal is answered without its text; any
// other failure (an unknown commit outcome included) is thrown to the caller and never retried here.
async function maintain<T>(work: (tx: DbClient) => Promise<T>, timeout = 60_000): Promise<CodingReleaseResult<T>> {
  try {
    return { ok: true, value: await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout }) }
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, code: error.code, message: error.message }
    if (isUniqueViolation(error)) return { ok: false, code: 'CODING_RELEASE_CONFLICT', message: 'the entry is already registered and is immutable; nothing was written' }
    if (error instanceof Error && /crg_import_(hash|incomplete|fingerprint)/.test(error.message)) return integrity('the import does not reproduce its declared records, source artifact or membership fingerprint; nothing was written')
    if (error instanceof Error && /crg_/.test(error.message)) return { ok: false, code: 'CODING_RELEASE_CONFLICT', message: 'the database refused the entry; nothing was written' }
    throw error
  }
}

// Map one A3 dataset to exactly one controlled code system and purpose, once. The dataset's own jurisdiction and
// authority are copied and held equal by the database; the A3 dataset row is locked first, as every A3 lifecycle write
// locks it.
export async function registerDatasetCodeSystem(body: unknown): Promise<CodingReleaseResult<{ mappingId: string; datasetId: string; codeSystem: CodeSystem; purpose: MappingPurpose }>> {
  const input = validateDatasetCodeSystem(body)
  if (!input.ok) return { ok: false, code: 'VALIDATION_ERROR', message: input.message }
  return maintain(async (tx) => {
    if (!(await lockRowForUpdate(tx, 'reference_datasets', input.value.datasetId))) return refuse('NOT_FOUND', 'reference dataset not found')
    const dataset = await findDatasetForCodingRelease(input.value.datasetId, tx)
    if (!dataset) return refuse('NOT_FOUND', 'reference dataset not found')
    if (await findDatasetCodeSystem(dataset.id, tx)) return refuse('CODING_RELEASE_CONFLICT', 'the dataset already has a code-system identity; a mapping is immutable')
    const row = await insertDatasetCodeSystem({ datasetId: dataset.id, codeSystem: input.value.codeSystem, purpose: input.value.purpose, jurisdictionCode: dataset.jurisdictionCode, authorityCode: dataset.authorityCode, contractVersion: CODESET_CONTRACT_VERSION }, tx)
    return { mappingId: row.id, datasetId: row.datasetId, codeSystem: row.codeSystem as CodeSystem, purpose: row.purpose as MappingPurpose }
  })
}

// Append the next rights decision for a code system in one jurisdiction and authority. Until one is APPROVED, no
// edition of that code system is ever used there.
export async function recordRightsDecision(body: unknown): Promise<CodingReleaseResult<{ rightsId: string; sequence: number; rightsStatus: RightsStatus }>> {
  const input = validateRightsDecision(body)
  if (!input.ok) return { ok: false, code: 'VALIDATION_ERROR', message: input.message }
  return maintain(async (tx) => {
    const row = await insertRightsDecision({ ...input.value, contractVersion: CODESET_CONTRACT_VERSION }, tx)
    return { rightsId: row.id, sequence: row.sequence, rightsStatus: input.value.rightsStatus }
  })
}

// Membership rows per INSERT statement. This bounds one batch only (audit CRG-F01): a release of any size is written
// as consecutive batches inside ONE transaction, so it commits completely or not at all and no partial release can
// ever be selected.
export const IMPORT_BATCH_ROWS = 5000
// The import transaction's time budget grows with the release (5 ms per record, at least the usual minute).
const importTimeout = (records: number) => Math.max(60_000, records * 5)

// Import one edition completely, before it is ever validated (audit CRG-F01, CRG-F02). The importer reads the original
// source artifact itself and trusts no declared value:
//   - the artifact's own SHA-256 must equal the declared source artifact SHA-256 and the A3 edition's content hash
//     (A3's meaning of that hash is unchanged: the hash of the retrieved content);
//   - every record is read from the artifact, its own bytes hashed (sourceRowSha256) and its code normalized;
//   - the records' number must equal the declared count, and their membership fingerprint (a different value, over the
//     normalized rows) must equal the declared membership fingerprint.
// The import header and every batch of its rows commit together or not at all; the database re-checks the count and
// recomputes the membership fingerprint at commit. The dataset row is locked first, so an A3 validation or activation
// of the same dataset cannot interleave.
export async function importRelease(
  body: unknown,
): Promise<CodingReleaseResult<{ importId: string; datasetVersionId: string; codeSystem: CodeSystem; recorded: number; batches: number; sourceFileSha256: string; membershipFingerprintSha256: string }>> {
  const input = validateReleaseImport(body)
  if (!input.ok) return { ok: false, code: 'VALIDATION_ERROR', message: input.message }
  const { datasetVersionId, artifactFormat, artifact, sourceFileSha256, membershipFingerprintSha256, sourceUri, publisher, expectedRowCount } = input.value
  const parsed = parseReleaseArtifact(artifactFormat, artifact)
  if (!parsed.ok) return { ok: false, code: 'VALIDATION_ERROR', message: parsed.message }
  const { rows, byteLength } = parsed.value
  if (parsed.value.sourceFileSha256 !== sourceFileSha256) return integrity('the artifact bytes do not reproduce the declared source artifact SHA-256; nothing was written')
  if (rows.length !== expectedRowCount) return integrity(`the artifact carries ${rows.length} records, not the declared ${expectedRowCount}; nothing was written`)
  const fingerprint = membershipFingerprint(rows)
  if (fingerprint !== membershipFingerprintSha256) return integrity('the artifact records do not reproduce the declared membership fingerprint; nothing was written')
  const located = await prisma.referenceDatasetVersion.findUnique({ where: { id: datasetVersionId }, select: { datasetId: true } })
  if (!located) return { ok: false, code: 'NOT_FOUND', message: 'reference dataset version not found' }
  return maintain(async (tx) => {
    await lockRowForUpdate(tx, 'reference_datasets', located.datasetId)
    const version = await tx.referenceDatasetVersion.findUnique({ where: { id: datasetVersionId }, select: { id: true, datasetId: true, validationStatus: true, activationStatus: true, contentHash: true } })
    if (!version) return refuse('NOT_FOUND', 'reference dataset version not found')
    const mapping = await findDatasetCodeSystem(version.datasetId, tx)
    if (!mapping) return refuse('CODING_RELEASE_CONFLICT', "the version's dataset has no code-system identity")
    if (version.contentHash !== sourceFileSha256) return refuse('SOURCE_INTEGRITY_CONFLICT', "the source artifact SHA-256 is not the edition's content hash; nothing was written")
    const everValidated = await tx.referenceDatasetLifecycleEvent.count({ where: { datasetVersionId: version.id, OR: [{ nextValidationStatus: 'VALIDATED' }, { action: { in: ['ACTIVATE', 'ROLLBACK'] } }] } })
    if (version.validationStatus !== 'UNVALIDATED' || version.activationStatus !== 'INACTIVE' || everValidated > 0) return refuse('CODING_RELEASE_CONFLICT', 'the edition has been validated or activated; it cannot be imported')
    const importId = await insertReleaseImport(
      { datasetVersionId: version.id, codeSystem: mapping.codeSystem, sourceFileSha256, artifactFormat, artifactByteLength: byteLength, membershipFingerprintSha256: fingerprint, sourceUri, publisher, expectedRowCount, contractVersion: CODESET_CONTRACT_VERSION },
      tx,
    )
    await concurrencyProbe('codingRelease.import_recorded')
    let recorded = 0
    let batches = 0
    for (let start = 0; start < rows.length; start += IMPORT_BATCH_ROWS) {
      recorded += await insertReleaseMemberships({ importId, datasetVersionId: version.id, codeSystem: mapping.codeSystem, releaseContentHash: version.contentHash, contractVersion: CODESET_CONTRACT_VERSION, rows: rows.slice(start, start + IMPORT_BATCH_ROWS) }, tx)
      batches += 1
      await concurrencyProbe('codingRelease.batch_recorded')
    }
    await concurrencyProbe('codingRelease.rows_recorded')
    return { importId, datasetVersionId: version.id, codeSystem: mapping.codeSystem as CodeSystem, recorded, batches, sourceFileSha256, membershipFingerprintSha256: fingerprint }
  }, importTimeout(rows.length))
}

// Classify, once, what a RETIRED edition's retirement means for the dates it governed.
export async function classifyRetirement(body: unknown): Promise<CodingReleaseResult<{ classificationId: string; classification: RetirementClassification }>> {
  const input = validateRetirementClassification(body)
  if (!input.ok) return { ok: false, code: 'VALIDATION_ERROR', message: input.message }
  const located = await prisma.referenceDatasetVersion.findUnique({ where: { id: input.value.datasetVersionId }, select: { datasetId: true } })
  if (!located) return { ok: false, code: 'NOT_FOUND', message: 'reference dataset version not found' }
  return maintain(async (tx) => {
    await lockRowForUpdate(tx, 'reference_datasets', located.datasetId)
    const version = await tx.referenceDatasetVersion.findUnique({ where: { id: input.value.datasetVersionId }, select: { activationStatus: true } })
    if (!version) return refuse('NOT_FOUND', 'reference dataset version not found')
    if (version.activationStatus !== 'RETIRED') return refuse('CODING_RELEASE_CONFLICT', 'only a RETIRED edition is classified')
    const classificationId = await insertRetirementClassification({ ...input.value, contractVersion: CODESET_CONTRACT_VERSION }, tx)
    return { classificationId, classification: input.value.classification }
  })
}

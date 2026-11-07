import { Prisma } from '../../../generated/prisma/client.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import type { ReceiptPlan } from './coding-validation.types.ts'

// CRG-01 Checkpoint B — Prisma access for the validation scope, the receipts and the manifests. Every write is an
// explicit INSERT that leaves recorded_at / created_at to the database (the guards refuse any other time); nothing is
// ever updated or deleted.

// The latest scope decision of a facility regulatory profile's (jurisdiction, authority), and whether that scope has
// ever had a REGULATORY decision — the same SQL function the database guards use.
export async function findScopeOfProfile(profileId: string, db: DbClient) {
  const rows = await db.$queryRaw<{ scope_class: string | null; scope_status: string | null; regulatory: boolean | null }[]>(
    Prisma.sql`SELECT scope_class, scope_status, regulatory FROM crg_validation_scope_of_profile(${profileId}::uuid)`,
  )
  const row = rows[0]
  return row && row.scope_class !== null && row.scope_status !== null ? { scopeClass: row.scope_class, scopeStatus: row.scope_status, regulatory: row.regulatory === true } : null
}

// The current A2 master value of every active diagnosis and coded activity of an encounter (the values the
// Checkpoint A resolver read on the same transaction).
export async function findTargetMasters(encounterId: string, db: DbClient) {
  const [diagnoses, activities] = await Promise.all([
    db.encounterDiagnosis.findMany({ where: { encounterId, removedAt: null }, select: { id: true, diagnosisCode: { select: { code: true } } } }),
    db.encounterActivity.findMany({ where: { encounterId, removedAt: null, procedureCodeId: { not: null } }, select: { id: true, procedureCode: { select: { externalCode: true } } } }),
  ])
  return [
    ...diagnoses.map((row) => ({ subjectKind: 'DIAGNOSIS' as const, targetId: row.id, masterValue: row.diagnosisCode.code })),
    ...activities.map((row) => ({ subjectKind: 'PROCEDURE' as const, targetId: row.id, masterValue: row.procedureCode?.externalCode ?? null })),
  ]
}

// The CRG mapping id of each dataset (one mapping per dataset).
export async function findMappingsOfDatasets(datasetIds: string[], db: DbClient) {
  if (datasetIds.length === 0) return new Map<string, string>()
  const rows = await db.crgCodeSystemDataset.findMany({ where: { datasetId: { in: datasetIds } }, select: { id: true, datasetId: true } })
  return new Map(rows.map((row) => [row.datasetId, row.id]))
}

export async function insertReceipts(runId: string, encounterId: string, rows: (ReceiptPlan & { validationFindingId: string })[], db: DbClient) {
  for (const row of rows) {
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "crg_validation_code_receipts" ("id", "validation_run_id", "encounter_id", "validation_finding_id", "subject_kind", "encounter_diagnosis_id", "encounter_activity_id",
        "master_code_id", "code_system", "canonical_code", "decision_code", "code_system_dataset_id", "release_import_id", "reference_dataset_version_id", "membership_id",
        "source_row_sha256", "release_content_hash", "membership_fingerprint_sha256", "service_date", "jurisdiction_code", "authority_code", "algorithm_version", "contract_version")
      VALUES (gen_random_uuid(), ${runId}::uuid, ${encounterId}::uuid, ${row.validationFindingId}::uuid, ${row.subjectKind},
        ${row.subjectKind === 'DIAGNOSIS' ? row.targetId : null}::uuid, ${row.subjectKind === 'PROCEDURE' ? row.targetId : null}::uuid,
        ${row.masterCodeId}::uuid, ${row.codeSystem}, ${row.canonicalCode}, ${row.decisionCode}, ${row.codeSystemDatasetId}::uuid, ${row.releaseImportId}::uuid,
        ${row.referenceDatasetVersionId}::uuid, ${row.membershipId}::uuid, ${row.sourceRowSha256}, ${row.releaseContentHash}, ${row.membershipFingerprintSha256},
        ${row.serviceDate}::date, ${row.jurisdictionCode}, ${row.authorityCode}, 'CRG-CODESET-1', 'CRG-RECEIPT-1')`)
  }
}

export async function insertManifest(runId: string, receiptCount: number, manifestSha256: string, db: DbClient) {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "crg_validation_receipt_manifests" ("id", "validation_run_id", "receipt_count", "manifest_sha256", "contract_version")
    VALUES (gen_random_uuid(), ${runId}::uuid, ${receiptCount}, ${manifestSha256}, 'CRG-RECEIPT-1')`)
}

// ---- reads for verification as recorded (immutable records only) ------------------------------------------

export async function findRunForVerification(runId: string, db: DbClient) {
  return db.validationRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      encounterId: true,
      validatorVersion: true,
      serviceDate: true,
      encounter: { select: { patient: { select: { organizationId: true } } } },
      facilityRegulatoryProfile: { select: { jurisdictionCode: true, regulatoryAuthorityCode: true } },
    },
  })
}

export async function findReceiptsOfRun(runId: string, db: DbClient) {
  return db.crgValidationCodeReceipt.findMany({ where: { validationRunId: runId }, orderBy: [{ subjectKind: 'asc' }, { id: 'asc' }] })
}

export async function findManifestOfRun(runId: string, db: DbClient) {
  return db.crgValidationReceiptManifest.findUnique({ where: { validationRunId: runId } })
}

export async function findCodingFindingsOfRun(runId: string, db: DbClient) {
  return db.validationFinding.findMany({
    where: { validationRunId: runId, layer: 'CODING' },
    select: { id: true, findingCode: true, encounterDiagnosisId: true, encounterActivityId: true, referenceDatasetVersionId: true },
  })
}

// The Checkpoint A rows a set of receipts names (all append-only).
export async function findReleaseRows(receipts: { membershipId: string | null; releaseImportId: string | null; codeSystemDatasetId: string | null; referenceDatasetVersionId: string | null }[], db: DbClient) {
  const ids = (field: keyof (typeof receipts)[number]) => [...new Set(receipts.map((r) => r[field]).filter((v): v is string => v !== null))]
  const [memberships, imports, mappings, versions] = await Promise.all([
    db.crgReleaseCodeMembership.findMany({ where: { id: { in: ids('membershipId') } } }),
    db.crgReleaseImport.findMany({ where: { id: { in: ids('releaseImportId') } } }),
    db.crgCodeSystemDataset.findMany({ where: { id: { in: ids('codeSystemDatasetId') } }, include: { dataset: { select: { jurisdictionCode: true, authorityCode: true } } } }),
    db.referenceDatasetVersion.findMany({ where: { id: { in: ids('referenceDatasetVersionId') } }, select: { id: true, datasetId: true, contentHash: true } }),
  ])
  return {
    memberships: new Map(memberships.map((row) => [row.id, row])),
    imports: new Map(imports.map((row) => [row.id, row])),
    mappings: new Map(mappings.map((row) => [row.id, row])),
    versions: new Map(versions.map((row) => [row.id, row])),
  }
}

export async function findSubmissionForProvenance(submissionId: string, db: DbClient) {
  return db.claimFreeze.findUnique({
    where: { id: submissionId },
    select: {
      id: true,
      submissionContractVersion: true,
      payloadSchemaVersion: true,
      canonicalPayloadBytes: true,
      payloadSha256: true,
      claim: { select: { encounter: { select: { patient: { select: { organizationId: true } } } }, preClaimReadinessAssessment: { select: { validationRunId: true } } } },
    },
  })
}

// ---- the maintenance writer --------------------------------------------------------------------------------

export async function findLatestScopeDecision(jurisdictionCode: string, authorityCode: string, db: DbClient) {
  return db.crgValidationScope.findFirst({ where: { jurisdictionCode, authorityCode }, orderBy: { sequence: 'desc' } })
}

export async function insertScopeDecision(data: { jurisdictionCode: string; authorityCode: string; scopeClass: string; sequence: number; scopeStatus: string; decisionReference: string }, db: DbClient) {
  const [row] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "crg_validation_scopes" ("id", "jurisdiction_code", "authority_code", "scope_class", "sequence", "validator_version", "scope_status", "decision_reference", "contract_version")
    VALUES (gen_random_uuid(), ${data.jurisdictionCode}, ${data.authorityCode}, ${data.scopeClass}, ${data.sequence}, 'A5-VAL-2', ${data.scopeStatus}, ${data.decisionReference}, 'CRG-VALSCOPE-1')
    RETURNING "id"::text AS "id"`)
  return row.id
}

import { Prisma } from '../../../generated/prisma/client.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import type { MembershipBasis } from './coding-release.types.ts'

// CRG-01 FINAL Checkpoint A — Prisma access for the five CRG-owned tables and the reads the resolver needs. The A3
// dataset, its versions and their lifecycle events are read here as stored facts and never written; the encounter, its
// codes and its facility profile are read only. CRG rows are written with explicit column lists that omit their
// times, so the database's own transaction time owns them (the insert guards refuse any other).

// The encounter, its owner organization, service date and facility regulatory profile.
export async function findEncounterForCodingRelease(encounterId: string, db: DbClient) {
  return db.encounter.findUnique({
    where: { id: encounterId },
    select: {
      id: true,
      serviceDate: true,
      patient: { select: { organizationId: true } },
      facilityRegulatoryProfile: { select: { jurisdictionCode: true, regulatoryAuthorityCode: true } },
    },
  })
}

// The encounter's current (not removed) diagnoses in their own order, with their A2 master rows.
export async function findActiveDiagnosesOfEncounter(encounterId: string, db: DbClient) {
  return db.encounterDiagnosis.findMany({
    where: { encounterId, removedAt: null },
    orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
    select: { id: true, diagnosisCode: { select: { id: true, organizationId: true, code: true } } },
  })
}

// The encounter's current (not removed) activities that name a procedure code, with their A2 master rows.
export async function findActiveCodedActivitiesOfEncounter(encounterId: string, db: DbClient) {
  return db.encounterActivity.findMany({
    where: { encounterId, removedAt: null, procedureCodeId: { not: null } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, procedureCode: { select: { id: true, organizationId: true, codeSystem: true, externalCode: true } } },
  })
}

// Every edition of every dataset mapped by CRG whose dataset is in this jurisdiction and authority (compared trimmed
// and upper-cased, as A3 compares them), with the mapping, the version's lifecycle in its stored order, its CRG import
// with its stored row count, and its retirement classification.
export async function findMappedEditions(jurisdictionCode: string, authorityCode: string, db: DbClient) {
  return db.$queryRaw<
    {
      dataset_version_id: string
      dataset_id: string
      dataset_jurisdiction_code: string
      dataset_authority_code: string
      mapping_code_system: string
      mapping_purpose: string
      mapping_jurisdiction_code: string
      mapping_authority_code: string
      version: string
      effective_from: string | null
      effective_to: string | null
      validation_status: string
      activation_status: string
      content_hash: string
      source_version_id: string | null
      lifecycle: { action: string; previousActivationStatus: string; nextActivationStatus: string; nextValidationStatus: string }[]
      import_id: string | null
      import_source_file_sha256: string | null
      import_expected_row_count: number | null
      import_row_count: number
      retirement_classification: string | null
    }[]
  >(Prisma.sql`
    SELECT v."id"::text AS dataset_version_id, d."id"::text AS dataset_id, d."jurisdiction_code" AS dataset_jurisdiction_code,
           d."authority_code" AS dataset_authority_code, m."code_system" AS mapping_code_system, m."purpose" AS mapping_purpose,
           m."jurisdiction_code" AS mapping_jurisdiction_code, m."authority_code" AS mapping_authority_code, v."version",
           to_char(v."effective_from", 'YYYY-MM-DD') AS effective_from, to_char(v."effective_to", 'YYYY-MM-DD') AS effective_to,
           v."validation_status", v."activation_status", v."content_hash", v."source_version_id"::text AS source_version_id,
           coalesce((SELECT json_agg(json_build_object('action', e."action", 'previousActivationStatus', e."previous_activation_status",
                                                      'nextActivationStatus', e."next_activation_status", 'nextValidationStatus', e."next_validation_status")
                                     ORDER BY e."sequence")
                     FROM "reference_dataset_lifecycle_events" e WHERE e."dataset_version_id" = v."id"), '[]'::json) AS lifecycle,
           i."id"::text AS import_id, i."source_file_sha256" AS import_source_file_sha256, i."expected_row_count" AS import_expected_row_count,
           (SELECT count(*)::int FROM "crg_release_code_memberships" c WHERE c."import_id" = i."id") AS import_row_count,
           r."classification" AS retirement_classification
    FROM "crg_code_system_datasets" m
    JOIN "reference_datasets" d ON d."id" = m."dataset_id"
    JOIN "reference_dataset_versions" v ON v."dataset_id" = d."id"
    LEFT JOIN "crg_release_imports" i ON i."dataset_version_id" = v."id"
    LEFT JOIN "crg_retirement_classifications" r ON r."dataset_version_id" = v."id"
    WHERE upper(btrim(d."jurisdiction_code")) = upper(btrim(${jurisdictionCode})) AND upper(btrim(d."authority_code")) = upper(btrim(${authorityCode}))
    ORDER BY v."id"`)
}

// The latest rights decision of each code system in this jurisdiction and authority (stored upper-cased).
export async function findLatestRights(jurisdictionCode: string, authorityCode: string, db: DbClient) {
  return db.$queryRaw<{ code_system: string; rights_status: string }[]>(Prisma.sql`
    SELECT DISTINCT ON (r."code_system") r."code_system", r."rights_status"
    FROM "crg_code_system_rights" r
    WHERE r."jurisdiction_code" = upper(btrim(${jurisdictionCode})) AND r."authority_code" = upper(btrim(${authorityCode}))
    ORDER BY r."code_system", r."sequence" DESC`)
}

// The stored membership of the given (edition, system, code) triples, keyed `${versionId}|${system}|${code}`.
export async function findMemberships(keys: { datasetVersionId: string; codeSystem: string; code: string }[], db: DbClient): Promise<Map<string, MembershipBasis>> {
  const found = new Map<string, MembershipBasis>()
  if (keys.length === 0) return found
  const rows = await db.crgReleaseCodeMembership.findMany({
    where: { OR: keys.map((key) => ({ datasetVersionId: key.datasetVersionId, codeSystem: key.codeSystem, code: key.code })) },
    select: { id: true, datasetVersionId: true, codeSystem: true, code: true, sourceRowId: true, sourceRowSha256: true, releaseContentHash: true },
  })
  for (const row of rows)
    found.set(`${row.datasetVersionId}|${row.codeSystem}|${row.code}`, { membershipId: row.id, sourceRowId: row.sourceRowId, sourceRowSha256: row.sourceRowSha256, releaseContentHash: row.releaseContentHash })
  return found
}

export async function findDatasetForCodingRelease(datasetId: string, db: DbClient) {
  return db.referenceDataset.findUnique({ where: { id: datasetId }, select: { id: true, jurisdictionCode: true, authorityCode: true } })
}

export async function findDatasetCodeSystem(datasetId: string, db: DbClient) {
  return db.crgCodeSystemDataset.findUnique({ where: { datasetId } })
}

export async function insertDatasetCodeSystem(data: { datasetId: string; codeSystem: string; purpose: string; jurisdictionCode: string; authorityCode: string; contractVersion: string }, db: DbClient) {
  const [row] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "crg_code_system_datasets" ("id", "dataset_id", "code_system", "purpose", "jurisdiction_code", "authority_code", "contract_version")
    VALUES (gen_random_uuid(), ${data.datasetId}::uuid, ${data.codeSystem}, ${data.purpose}, ${data.jurisdictionCode}, ${data.authorityCode}, ${data.contractVersion})
    RETURNING "id"::text AS "id"`)
  return db.crgCodeSystemDataset.findUniqueOrThrow({ where: { id: row.id } })
}

// The next rights decision of a scope, numbered by the server.
export async function insertRightsDecision(data: { jurisdictionCode: string; authorityCode: string; codeSystem: string; rightsStatus: string; decisionReference: string; contractVersion: string }, db: DbClient) {
  const [row] = await db.$queryRaw<{ id: string; sequence: number }[]>(Prisma.sql`
    INSERT INTO "crg_code_system_rights" ("id", "jurisdiction_code", "authority_code", "code_system", "sequence", "rights_status", "decision_reference", "contract_version")
    SELECT gen_random_uuid(), ${data.jurisdictionCode}, ${data.authorityCode}, ${data.codeSystem}, coalesce(max(r."sequence"), 0) + 1, ${data.rightsStatus}, ${data.decisionReference}, ${data.contractVersion}
    FROM "crg_code_system_rights" r WHERE r."jurisdiction_code" = ${data.jurisdictionCode} AND r."authority_code" = ${data.authorityCode} AND r."code_system" = ${data.codeSystem}
    RETURNING "id"::text AS "id", "sequence"`)
  return row
}

export async function insertReleaseImport(
  data: { datasetVersionId: string; codeSystem: string; sourceFileSha256: string; sourceUri: string; publisher: string; expectedRowCount: number; contractVersion: string },
  db: DbClient,
) {
  const [row] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "crg_release_imports" ("id", "dataset_version_id", "code_system", "source_file_sha256", "source_uri", "publisher", "expected_row_count", "contract_version")
    VALUES (gen_random_uuid(), ${data.datasetVersionId}::uuid, ${data.codeSystem}, ${data.sourceFileSha256}, ${data.sourceUri}, ${data.publisher}, ${data.expectedRowCount}, ${data.contractVersion})
    RETURNING "id"::text AS "id"`)
  return row.id
}

export async function insertReleaseMemberships(
  data: { importId: string; datasetVersionId: string; codeSystem: string; releaseContentHash: string; contractVersion: string; rows: { sourceRowId: string; code: string; sourceRowSha256: string }[] },
  db: DbClient,
): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    INSERT INTO "crg_release_code_memberships" ("id", "import_id", "dataset_version_id", "code_system", "code", "source_row_id", "source_row_sha256", "release_content_hash", "contract_version")
    SELECT gen_random_uuid(), ${data.importId}::uuid, ${data.datasetVersionId}::uuid, ${data.codeSystem}, r."code", r."row_id", r."sha", ${data.releaseContentHash}, ${data.contractVersion}
    FROM unnest(${data.rows.map((r) => r.code)}::text[], ${data.rows.map((r) => r.sourceRowId)}::text[], ${data.rows.map((r) => r.sourceRowSha256)}::text[]) AS r("code", "row_id", "sha")`)
}

export async function insertRetirementClassification(data: { datasetVersionId: string; classification: string; contractVersion: string }, db: DbClient) {
  const [row] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "crg_retirement_classifications" ("id", "dataset_version_id", "classification", "contract_version")
    VALUES (gen_random_uuid(), ${data.datasetVersionId}::uuid, ${data.classification}, ${data.contractVersion})
    RETURNING "id"::text AS "id"`)
  return row.id
}

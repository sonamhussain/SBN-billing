import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import type { EvidenceEntryV1, OwnerVersionFacts } from '../claim-evidence/claim-evidence.types.ts'

// A6.7 — Prisma access for immutable claim freezes. The Claim, assessment, review event and the versioned
// evidence owners are READ from their owners; the only writes are the three append-only freeze rows, which
// the database refuses to update or delete.

// The Claim's owning organization — nothing else of the Claim is needed here.
export async function findClaimForFreeze(claimId: string, db: DbClient) {
  const row = await db.claim.findUnique({ where: { id: claimId }, select: { id: true, encounter: { select: { patient: { select: { organizationId: true } } } } } })
  return row ? { id: row.id, organizationId: row.encounter.patient.organizationId } : null
}

// The stored A6.4 assessment exactly as recorded.
export async function findAssessmentForFreeze(id: string, db: DbClient) {
  return db.claimDraftAssessment.findUnique({ where: { id }, select: { id: true, claimId: true, pricingRunId: true, outcome: true, assemblyFingerprint: true } })
}

// The stored A6.5 review event exactly as recorded.
export async function findReviewEventForFreeze(id: string, db: DbClient) {
  return db.claimReviewEvent.findUnique({ where: { id }, select: { id: true, claimId: true, decisionCode: true, draftAssessmentId: true, approvalFingerprint: true } })
}

// The owners' parent ids (and, for an evidence artifact version, its content hash) of exactly the named
// versions. A version the owner does not hold is simply absent from the map.
export async function readOwnerVersionFacts(
  ids: { priorAuthorizationVersionIds: string[]; evidenceArtifactVersionIds: string[]; ruleVersionIds: string[]; governingSourceVersionIds: string[]; referenceDatasetVersionIds: string[] },
  db: DbClient,
): Promise<OwnerVersionFacts> {
  const byIds = (list: string[]) => ({ id: { in: list } })
  const [authorizations, artifacts, rules, sources, datasets] = await Promise.all([
    ids.priorAuthorizationVersionIds.length > 0 ? db.priorAuthorizationVersion.findMany({ where: byIds(ids.priorAuthorizationVersionIds), select: { id: true, priorAuthorizationId: true } }) : [],
    ids.evidenceArtifactVersionIds.length > 0 ? db.evidenceArtifactVersion.findMany({ where: byIds(ids.evidenceArtifactVersionIds), select: { id: true, evidenceArtifactId: true, contentHash: true } }) : [],
    ids.ruleVersionIds.length > 0 ? db.ruleVersion.findMany({ where: byIds(ids.ruleVersionIds), select: { id: true, ruleId: true } }) : [],
    ids.governingSourceVersionIds.length > 0 ? db.ruleSourceVersion.findMany({ where: byIds(ids.governingSourceVersionIds), select: { id: true, sourceId: true } }) : [],
    ids.referenceDatasetVersionIds.length > 0 ? db.referenceDatasetVersion.findMany({ where: byIds(ids.referenceDatasetVersionIds), select: { id: true, datasetId: true } }) : [],
  ])
  return {
    priorAuthorizationOfVersion: new Map(authorizations.map((row) => [row.id, row.priorAuthorizationId])),
    evidenceArtifactOfVersion: new Map(artifacts.map((row) => [row.id, { evidenceArtifactId: row.evidenceArtifactId, contentHash: row.contentHash }])),
    ruleOfVersion: new Map(rules.map((row) => [row.id, row.ruleId])),
    sourceOfVersion: new Map(sources.map((row) => [row.id, row.sourceId])),
    datasetOfVersion: new Map(datasets.map((row) => [row.id, row.datasetId])),
  }
}

// ---- the three append-only writes ---------------------------------------------------------------------
// Each row is written with an explicit column list that omits its instants, so they take the database's
// own transaction time (the client never supplies one; the insert guards refuse one). Bytes travel as hex
// text and are decoded by the database, so no driver conversion can alter them.

export type NewFreeze = {
  claimId: string
  draftAssessmentId: string
  approvalReviewEventId: string
  pricingRunId: string
  submissionContractVersion: string
  payloadSchemaVersion: string
  approvedAssemblyFingerprint: string
  canonicalPayloadBytes: Buffer
  payloadSha256: string
  createdByUserId: string
}

export async function insertFreeze(data: NewFreeze, db: DbClient): Promise<string> {
  const [inserted] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "claim_freezes" ("id", "claim_id", "draft_assessment_id", "approval_review_event_id", "pricing_run_id", "submission_contract_version", "payload_schema_version", "approved_assembly_fingerprint", "canonical_payload_bytes", "payload_sha256", "created_by_user_id")
    VALUES (gen_random_uuid(), ${data.claimId}::uuid, ${data.draftAssessmentId}::uuid, ${data.approvalReviewEventId}::uuid, ${data.pricingRunId}::uuid, ${data.submissionContractVersion}, ${data.payloadSchemaVersion}, ${data.approvedAssemblyFingerprint}, decode(${data.canonicalPayloadBytes.toString('hex')}, 'hex'), ${data.payloadSha256}, ${data.createdByUserId}::uuid)
    RETURNING "id"::text AS "id"`)
  return inserted.id
}

export type NewEvidencePackage = {
  freezeId: string
  manifestContractVersion: string
  entryCount: number
  manifestBytes: Buffer
  manifestSha256: string
  packageSealSha256: string
}

export async function insertEvidencePackage(data: NewEvidencePackage, db: DbClient): Promise<string> {
  const [inserted] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "claim_freeze_evidence_manifests" ("id", "claim_submission_id", "manifest_contract_version", "entry_count", "manifest_bytes", "manifest_sha256", "package_seal_sha256")
    VALUES (gen_random_uuid(), ${data.freezeId}::uuid, ${data.manifestContractVersion}, ${data.entryCount}::int, decode(${data.manifestBytes.toString('hex')}, 'hex'), ${data.manifestSha256}, ${data.packageSealSha256})
    RETURNING "id"::text AS "id"`)
  return inserted.id
}

// All entries of a package in one statement, in ordinal order.
export async function insertEvidenceEntries(packageId: string, entries: readonly EvidenceEntryV1[], db: DbClient): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    INSERT INTO "claim_freeze_evidence_entries" ("id", "evidence_package_id", "ordinal", "reference_kind", "reference_id", "reference_version_id", "content_hash", "evidence_role")
    SELECT gen_random_uuid(), ${packageId}::uuid, e."ordinal", e."kind", e."ref"::uuid, e."ver"::uuid, e."hash", e."role"
    FROM unnest(
      ${entries.map((entry) => entry.ordinal)}::int[],
      ${entries.map((entry) => entry.referenceKind)}::text[],
      ${entries.map((entry) => entry.referenceId)}::text[],
      ${entries.map((entry) => entry.referenceVersionId)}::text[],
      ${entries.map((entry) => entry.contentHash)}::text[],
      ${entries.map((entry) => entry.evidenceRole)}::text[]
    ) AS e("ordinal", "kind", "ref", "ver", "hash", "role")
    ORDER BY e."ordinal"`)
}

// ---- reads ----------------------------------------------------------------------------------------------

const freezeSelect = {
  id: true,
  claimId: true,
  draftAssessmentId: true,
  approvalReviewEventId: true,
  pricingRunId: true,
  submissionContractVersion: true,
  payloadSchemaVersion: true,
  approvedAssemblyFingerprint: true,
  canonicalPayloadBytes: true,
  payloadSha256: true,
  frozenAt: true,
  createdByUserId: true,
  createdAt: true,
  evidenceManifest: {
    select: { id: true, manifestContractVersion: true, entryCount: true, manifestBytes: true, manifestSha256: true, packageSealSha256: true, createdAt: true },
  },
} as const

export type FreezeRecord = NonNullable<Awaited<ReturnType<typeof findFreezeById>>>

export async function findFreezeById(id: string, db: DbClient = prisma) {
  return db.claimFreeze.findUnique({ where: { id }, select: freezeSelect })
}

// The one freeze of an approval (the idempotency key), if any.
export async function findFreezeByApproval(approvalReviewEventId: string, db: DbClient) {
  return db.claimFreeze.findUnique({ where: { approvalReviewEventId }, select: freezeSelect })
}

// A Claim's freezes in the order they were frozen (database time, then id): a stable historical list.
export async function findFreezesOfClaim(claimId: string, db: DbClient) {
  return db.claimFreeze.findMany({ where: { claimId }, orderBy: [{ frozenAt: 'asc' }, { id: 'asc' }], select: freezeSelect })
}

// The owning organization of a freeze, through its Claim.
export async function findFreezeOwnership(id: string, db: DbClient = prisma) {
  const row = await db.claimFreeze.findUnique({ where: { id }, select: { claim: { select: { encounter: { select: { patient: { select: { organizationId: true } } } } } } } })
  return row ? { organizationId: row.claim.encounter.patient.organizationId } : null
}

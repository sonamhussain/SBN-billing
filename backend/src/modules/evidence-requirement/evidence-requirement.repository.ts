import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import type { EvidenceRequirementInput } from './evidence-requirement.types.ts'

// A5.6 — Prisma access for requirement payloads and completeness inputs. There is no update, upsert
// or delete of a requirement anywhere: a payload is immutable, and the database refuses the
// alternative. Every completeness read takes the caller's transaction client, so one evaluation reads
// one snapshot.

const withDocumentTypes = { documentTypes: { select: { documentType: true } } } as const

// Ownership for a RuleVersion-nested route, read through the RuleDefinition. A SYSTEM_SHARED rule
// has no organization, so it resolves to none and the shared middleware refuses it: tenant routes
// never mutate system governance.
export async function findRuleVersionOwnership(ruleVersionId: string, db: DbClient = prisma) {
  return db.ruleVersion.findUnique({ where: { id: ruleVersionId }, select: { rule: { select: { organizationId: true } } } })
}

// What attaching a payload must know about the RuleVersion, read under its row lock.
export async function findRuleVersionForRequirement(ruleVersionId: string, db: DbClient) {
  return db.ruleVersion.findUnique({
    where: { id: ruleVersionId },
    select: { id: true, effectType: true, verificationStatus: true, rule: { select: { organizationId: true } } },
  })
}

export async function findRequirementByRuleVersion(ruleVersionId: string, db: DbClient = prisma) {
  return db.evidenceRequirement.findUnique({ where: { ruleVersionId }, include: withDocumentTypes })
}

export async function createRequirementRecord(ruleVersionId: string, input: EvidenceRequirementInput, db: DbClient) {
  return db.evidenceRequirement.create({
    data: {
      ruleVersionId,
      minimumCount: input.minimumCount,
      sourceDateRequired: input.sourceDateRequired,
      maxSourceAgeDays: input.maxSourceAgeDays,
      documentTypes: { create: input.documentTypes.map((documentType) => ({ documentType })) },
    },
    include: withDocumentTypes,
  })
}

// The A3 verification gate's question, inside A3's own transaction: does this RuleVersion carry a
// payload, and with how many accepted document types?
export async function findRequirementShapeForGate(ruleVersionId: string, db: DbClient) {
  return db.evidenceRequirement.findUnique({
    where: { ruleVersionId },
    select: { id: true, _count: { select: { documentTypes: true } } },
  })
}

// ---- completeness inputs -------------------------------------------------------------------

// Every own-organization RuleDefinition that has ever had a documentation version. Ordered by id:
// stable, never precedence. SYSTEM_SHARED definitions are not discovered — A3.8 resolves only
// own-organization definitions today (owner decision).
export async function findDocumentationRuleDefinitionIds(organizationId: string, effectType: string, db: DbClient) {
  const rows = await db.ruleDefinition.findMany({
    where: { organizationId, versions: { some: { effectType } } },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  return rows.map((row) => row.id)
}

export async function findResolvedRuleVersion(ruleVersionId: string, db: DbClient) {
  return db.ruleVersion.findUnique({
    where: { id: ruleVersionId },
    select: { id: true, effectType: true, verificationStatus: true, evidenceRequirement: { include: withDocumentTypes } },
  })
}

// The optional exact targets, with what the context needs and what proves they are this Encounter's
// active rows.
export async function findActivityTarget(activityId: string, db: DbClient) {
  return db.encounterActivity.findUnique({
    where: { id: activityId },
    select: { id: true, encounterId: true, removedAt: true, serviceId: true, procedureCodeId: true },
  })
}

export async function findDiagnosisTarget(diagnosisId: string, db: DbClient) {
  return db.encounterDiagnosis.findUnique({
    where: { id: diagnosisId },
    select: { id: true, encounterId: true, removedAt: true, diagnosisCodeId: true },
  })
}

// §8 — the exact evidence versions this Encounter's workflow actually references, from the three
// owners that link them. Never every artifact in the organization, never "latest".
export async function findEncounterEvidencePoolIds(encounterId: string, db: DbClient) {
  const links = await db.encounterEvidenceLink.findMany({ where: { encounterId, removedAt: null }, select: { evidenceArtifactVersionId: true } })
  const eligibility = await db.eligibilityVerification.findMany({
    where: { encounterId },
    select: { requestEvidenceVersionId: true, responseEvidenceVersionId: true },
  })
  const authorization = await db.priorAuthorizationVersionEvidence.findMany({
    where: { priorAuthorizationVersion: { priorAuthorization: { encounterId } } },
    select: { evidenceArtifactVersionId: true },
  })
  const ids = new Set<string>()
  for (const row of links) ids.add(row.evidenceArtifactVersionId)
  for (const row of eligibility) {
    if (row.requestEvidenceVersionId) ids.add(row.requestEvidenceVersionId)
    if (row.responseEvidenceVersionId) ids.add(row.responseEvidenceVersionId)
  }
  for (const row of authorization) ids.add(row.evidenceArtifactVersionId)
  return [...ids].sort()
}

// Only the two facts classification needs. No storage reference, hash or receipt time is read.
export async function findEvidenceFacts(versionIds: string[], db: DbClient) {
  if (versionIds.length === 0) return []
  return db.evidenceArtifactVersion.findMany({
    where: { id: { in: versionIds } },
    select: { id: true, documentType: true, sourceDate: true },
  })
}

import { Prisma } from '../../../generated/prisma/client.ts'
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

// The applicability dimensions of a completeness evaluation, exactly as A5.6 passes them to A3.8.
// facilityRegulatoryProfileId is absent on purpose: A3.8 derives it, so it is never used to narrow.
export type CandidateContext = {
  facilityId: string | null
  payerId: string | null
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  providerContractId: string | null
  tariffScheduleId: string | null
  tariffScheduleVersionId: string | null
  serviceId: string | null
  procedureCodeId: string | null
  diagnosisCodeId: string | null
}

// Performance corrective — which of the given RuleDefinitions A3.8 could possibly answer with anything
// other than NO_MATCH. A3.8 returns NO_MATCH exactly when no RuleVersion of the definition is VERIFIED,
// effective on the business date AND has an applicability row that matches the context (every non-null
// row dimension equal to the context value; a null row dimension is a wildcard; a null context value
// never satisfies a non-null row value). This query keeps every definition that has such a version, so
// it is a superset of the definitions A3.8 can resolve, block or mark reference-only; the facility
// regulatory profile dimension is not used to narrow at all, which only widens the set. One indexed
// statement replaces one full A3.8 evaluation per unrelated rule. A3.8 still decides everything for
// the definitions returned here: specificity, conflicts, supersession and provenance are untouched.
//
// Returns null — "do not narrow" — when the business date or any context value is not in the exact
// shape the query compares (a calendar date, UUIDs): every definition then goes through A3.8 exactly as
// before, so a malformed value is refused by A3.8 itself and never turns into a database error here.
const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const dateShape = /^\d{4}-\d{2}-\d{2}$/

export async function findPossiblyApplicableRuleDefinitionIds(ruleDefinitionIds: string[], businessDate: string, context: CandidateContext, db: DbClient): Promise<Set<string> | null> {
  if (!dateShape.test(businessDate) || Object.values(context).some((value) => value !== null && !(typeof value === 'string' && uuidShape.test(value)))) return null
  if (ruleDefinitionIds.length === 0) return new Set<string>()
  const dimension = (column: string, value: string | null) => Prisma.sql`(${Prisma.raw(`a."${column}"`)} IS NULL OR ${Prisma.raw(`a."${column}"`)} = ${value}::uuid)`
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT v.rule_id::text AS id
    FROM rule_versions v
    JOIN rule_applicabilities a ON a.rule_version_id = v.id
    WHERE v.rule_id = ANY(${ruleDefinitionIds}::uuid[])
      AND v.verification_status = 'VERIFIED'
      AND v.effective_from IS NOT NULL
      AND v.effective_from <= ${businessDate}::date
      AND (v.effective_to IS NULL OR v.effective_to >= ${businessDate}::date)
      AND ${dimension('facility_id', context.facilityId)}
      AND ${dimension('payer_id', context.payerId)}
      AND ${dimension('tpa_id', context.tpaId)}
      AND ${dimension('network_id', context.networkId)}
      AND ${dimension('insurance_product_id', context.insuranceProductId)}
      AND ${dimension('provider_contract_id', context.providerContractId)}
      AND ${dimension('tariff_schedule_id', context.tariffScheduleId)}
      AND ${dimension('tariff_schedule_version_id', context.tariffScheduleVersionId)}
      AND ${dimension('service_id', context.serviceId)}
      AND ${dimension('procedure_code_id', context.procedureCodeId)}
      AND ${dimension('diagnosis_code_id', context.diagnosisCodeId)}`
  return new Set(rows.map((row) => row.id))
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

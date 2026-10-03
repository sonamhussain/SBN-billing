import type { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A5.7 — Prisma access for validation runs and findings. Reads select only the ids and ownership
// columns a check needs; the only sensitive values read are the ones the recorder must keep OUT of a
// finding's text, and they are never returned or stored. There is no update or delete function: the
// database refuses both outright.

// ---- ownership (routes) ------------------------------------------------------------------------

export async function findEncounterOwnership(encounterId: string, db: DbClient = prisma) {
  return db.encounter.findUnique({ where: { id: encounterId }, select: { patient: { select: { organizationId: true } } } })
}

export async function findRunOwnership(runId: string, db: DbClient = prisma) {
  return db.validationRun.findUnique({ where: { id: runId }, select: { encounter: { select: { patient: { select: { organizationId: true } } } } } })
}

export async function findFindingOwnership(findingId: string, db: DbClient = prisma) {
  return db.validationFinding.findUnique({
    where: { id: findingId },
    select: { validationRun: { select: { encounter: { select: { patient: { select: { organizationId: true } } } } } } },
  })
}

// ---- recorder reads ----------------------------------------------------------------------------

export async function findEncounterForRun(encounterId: string, db: DbClient) {
  return db.encounter.findUnique({
    where: { id: encounterId },
    select: { id: true, patientId: true, insuranceMembershipId: true, patient: { select: { organizationId: true } } },
  })
}

const byIds = (ids: string[]) => ({ id: { in: ids } })

export async function findContextRows(
  ids: {
    facilityId: string
    facilityRegulatoryProfileId: string
    insuranceMembershipId: string | null
    payerId: string | null
    tpaId: string | null
    networkId: string | null
    insuranceProductId: string | null
    providerContractId: string | null
    tariffScheduleId: string | null
    tariffScheduleVersionId: string | null
  },
  db: DbClient,
) {
  const [facility, profile, membership, payer, tpa, network, product, contract, schedule, tariffVersion] = await Promise.all([
    db.facility.findUnique({ where: { id: ids.facilityId }, select: { organizationId: true } }),
    db.facilityRegulatoryProfile.findUnique({ where: { id: ids.facilityRegulatoryProfileId }, select: { facilityId: true } }),
    ids.insuranceMembershipId ? db.insuranceMembership.findUnique({ where: { id: ids.insuranceMembershipId }, select: { patientId: true } }) : null,
    ids.payerId ? db.payer.findUnique({ where: { id: ids.payerId }, select: { organizationId: true } }) : null,
    ids.tpaId ? db.tpa.findUnique({ where: { id: ids.tpaId }, select: { organizationId: true } }) : null,
    ids.networkId ? db.network.findUnique({ where: { id: ids.networkId }, select: { organizationId: true } }) : null,
    ids.insuranceProductId ? db.insuranceProduct.findUnique({ where: { id: ids.insuranceProductId }, select: { organizationId: true } }) : null,
    ids.providerContractId ? db.providerContract.findUnique({ where: { id: ids.providerContractId }, select: { organizationId: true } }) : null,
    ids.tariffScheduleId ? db.tariffSchedule.findUnique({ where: { id: ids.tariffScheduleId }, select: { providerContractId: true } }) : null,
    ids.tariffScheduleVersionId ? db.tariffScheduleVersion.findUnique({ where: { id: ids.tariffScheduleVersionId }, select: { tariffScheduleId: true } }) : null,
  ])
  return { facility, profile, membership, payer, tpa, network, product, contract, schedule, tariffVersion }
}

export async function findTargetRows(
  ids: {
    activities: string[]
    diagnoses: string[]
    eligibilityVerifications: string[]
    priorAuthorizationVersions: string[]
    authorizationLines: string[]
    evidenceRequirements: string[]
    evidenceVersions: string[]
    ruleVersions: string[]
    sourceVersions: string[]
    datasetVersions: string[]
  },
  db: DbClient,
) {
  const [activities, diagnoses, eligibilityVerifications, priorAuthorizationVersions, authorizationLines, evidenceRequirements, evidenceVersions, ruleVersions, sourceVersions, datasetVersions] =
    await Promise.all([
      db.encounterActivity.findMany({ where: byIds(ids.activities), select: { id: true, encounterId: true } }),
      db.encounterDiagnosis.findMany({ where: byIds(ids.diagnoses), select: { id: true, encounterId: true } }),
      db.eligibilityVerification.findMany({ where: byIds(ids.eligibilityVerifications), select: { id: true, encounterId: true } }),
      db.priorAuthorizationVersion.findMany({
        where: byIds(ids.priorAuthorizationVersions),
        select: { id: true, priorAuthorization: { select: { encounterId: true } } },
      }),
      db.authorizationLine.findMany({
        where: byIds(ids.authorizationLines),
        select: { id: true, priorAuthorizationVersion: { select: { priorAuthorization: { select: { encounterId: true } } } } },
      }),
      db.evidenceRequirement.findMany({
        where: byIds(ids.evidenceRequirements),
        select: { id: true, ruleVersion: { select: { rule: { select: { organizationId: true, ownershipScope: true } } } } },
      }),
      // Ownership only: the storage reference and hash are read separately, solely to keep them out
      // of finding text.
      db.evidenceArtifactVersion.findMany({ where: byIds(ids.evidenceVersions), select: { id: true, evidenceArtifact: { select: { organizationId: true } } } }),
      db.ruleVersion.findMany({ where: byIds(ids.ruleVersions), select: { id: true, rule: { select: { organizationId: true, ownershipScope: true } } } }),
      db.ruleSourceVersion.findMany({ where: byIds(ids.sourceVersions), select: { id: true, source: { select: { organizationId: true, ownershipScope: true } } } }),
      db.referenceDatasetVersion.findMany({ where: byIds(ids.datasetVersions), select: { id: true } }),
    ])
  return { activities, diagnoses, eligibilityVerifications, priorAuthorizationVersions, authorizationLines, evidenceRequirements, evidenceVersions, ruleVersions, sourceVersions, datasetVersions }
}

// The values a finding's message or field path must never echo (§7). Read, compared, discarded.
export async function findSensitiveValues(encounterId: string, membershipIds: string[], evidenceVersionIds: string[], db: DbClient): Promise<string[]> {
  const [memberships, authorizationVersions, evidenceVersions] = await Promise.all([
    membershipIds.length > 0 ? db.insuranceMembership.findMany({ where: byIds(membershipIds), select: { memberIdentifier: true, policyIdentifier: true } }) : [],
    db.priorAuthorizationVersion.findMany({ where: { priorAuthorization: { encounterId } }, select: { authorizationReference: true } }),
    evidenceVersionIds.length > 0 ? db.evidenceArtifactVersion.findMany({ where: byIds(evidenceVersionIds), select: { storageRef: true, contentHash: true } }) : [],
  ])
  return [
    ...memberships.flatMap((row) => [row.memberIdentifier, row.policyIdentifier]),
    ...authorizationVersions.map((row) => row.authorizationReference),
    ...evidenceVersions.flatMap((row) => [row.storageRef, row.contentHash]),
  ].filter((value): value is string => typeof value === 'string' && value.trim() !== '')
}

// ---- recorder writes ---------------------------------------------------------------------------

export async function createRunRecord(data: Prisma.ValidationRunUncheckedCreateInput, db: DbClient) {
  return db.validationRun.create({ data })
}

export async function createFindingRecords(data: Prisma.ValidationFindingCreateManyInput[], db: DbClient) {
  return db.validationFinding.createMany({ data })
}

// ---- reads -------------------------------------------------------------------------------------

const runWithCount = { _count: { select: { findings: true } } } as const

// §14 — newest evaluation first, then newest row, then id: a fixed order, never a "current" label.
export async function findRunsForEncounter(encounterId: string, db: DbClient = prisma) {
  return db.validationRun.findMany({
    where: { encounterId },
    include: runWithCount,
    orderBy: [{ evaluatedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
  })
}

export async function findRunById(runId: string, db: DbClient = prisma) {
  return db.validationRun.findUnique({ where: { id: runId }, include: runWithCount })
}

export async function findFindingsForRun(runId: string, db: DbClient = prisma) {
  return db.validationFinding.findMany({ where: { validationRunId: runId }, orderBy: [{ sequence: 'asc' }] })
}

export async function findFindingById(findingId: string, db: DbClient = prisma) {
  return db.validationFinding.findUnique({ where: { id: findingId } })
}

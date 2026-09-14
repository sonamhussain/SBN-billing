import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import type { ApplicabilityDimensionKey } from './rule-applicability.validation.ts'

export async function createRuleApplicabilityRecord(
  data: {
    ruleVersionId: string
    payerId: string | null
    tpaId: string | null
    networkId: string | null
    serviceId: string | null
    procedureCodeId: string | null
    diagnosisCodeId: string | null
  },
  db: DbClient = prisma,
) {
  return db.ruleApplicability.create({ data })
}

export async function findRuleApplicabilityById(id: string, db: DbClient = prisma) {
  return db.ruleApplicability.findUnique({ where: { id } })
}

export async function findRuleApplicabilitiesByVersionId(ruleVersionId: string, db: DbClient = prisma) {
  return db.ruleApplicability.findMany({ where: { ruleVersionId }, orderBy: { createdAt: 'asc' } })
}

export async function findRuleApplicabilityWithOrganization(id: string, db: DbClient = prisma) {
  return db.ruleApplicability.findUnique({
    where: { id },
    include: { ruleVersion: { include: { rule: { select: { organizationId: true } } } } },
  })
}

// Every A3.6 target dimension maps to an A2 master whose organizationId is NOT NULL — a
// null return unambiguously means "target does not exist" (T12/T13), never "shared/no owner".
export async function findTargetOrganizationId(
  key: ApplicabilityDimensionKey,
  id: string,
  db: DbClient = prisma,
): Promise<string | null> {
  switch (key) {
    case 'payerId': {
      const record = await db.payer.findUnique({ where: { id }, select: { organizationId: true } })
      return record?.organizationId ?? null
    }
    case 'tpaId': {
      const record = await db.tpa.findUnique({ where: { id }, select: { organizationId: true } })
      return record?.organizationId ?? null
    }
    case 'networkId': {
      const record = await db.network.findUnique({ where: { id }, select: { organizationId: true } })
      return record?.organizationId ?? null
    }
    case 'serviceId': {
      const record = await db.service.findUnique({ where: { id }, select: { organizationId: true } })
      return record?.organizationId ?? null
    }
    case 'procedureCodeId': {
      const record = await db.procedureCode.findUnique({ where: { id }, select: { organizationId: true } })
      return record?.organizationId ?? null
    }
    case 'diagnosisCodeId': {
      const record = await db.diagnosisCode.findUnique({ where: { id }, select: { organizationId: true } })
      return record?.organizationId ?? null
    }
  }
}

import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import type { ScopeDimensionKey } from './rule-source-scope.validation.ts'

export async function createRuleSourceScopeRecord(
  data: {
    sourceId: string
    facilityId: string | null
    payerId: string | null
    tpaId: string | null
    networkId: string | null
    insuranceProductId: string | null
    providerContractId: string | null
    tariffScheduleId: string | null
    tariffScheduleVersionId: string | null
  },
  db: DbClient = prisma,
) {
  return db.ruleSourceScope.create({ data })
}

export async function findRuleSourceScopeById(id: string, db: DbClient = prisma) {
  return db.ruleSourceScope.findUnique({ where: { id } })
}

export async function findRuleSourceScopesBySourceId(sourceId: string, db: DbClient = prisma) {
  return db.ruleSourceScope.findMany({ where: { sourceId }, orderBy: { createdAt: 'asc' } })
}

export async function findRuleSourceScopeWithSource(id: string, db: DbClient = prisma) {
  return db.ruleSourceScope.findUnique({
    where: { id },
    include: { source: { select: { organizationId: true } } },
  })
}

// Every RuleSourceScope target dimension maps to an A2/REF-01 master whose organizationId is
// resolvable — TariffSchedule and TariffScheduleVersion require walking to their owning
// ProviderContract, which is where organizationId actually lives.
export async function findScopeTargetOrganizationId(
  key: ScopeDimensionKey,
  id: string,
  db: DbClient = prisma,
): Promise<string | null> {
  switch (key) {
    case 'facilityId': {
      const record = await db.facility.findUnique({ where: { id }, select: { organizationId: true } })
      return record?.organizationId ?? null
    }
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
    case 'insuranceProductId': {
      const record = await db.insuranceProduct.findUnique({ where: { id }, select: { organizationId: true } })
      return record?.organizationId ?? null
    }
    case 'providerContractId': {
      const record = await db.providerContract.findUnique({ where: { id }, select: { organizationId: true } })
      return record?.organizationId ?? null
    }
    case 'tariffScheduleId': {
      const record = await db.tariffSchedule.findUnique({
        where: { id },
        select: { providerContract: { select: { organizationId: true } } },
      })
      return record?.providerContract.organizationId ?? null
    }
    case 'tariffScheduleVersionId': {
      const record = await db.tariffScheduleVersion.findUnique({
        where: { id },
        select: { tariffSchedule: { select: { providerContract: { select: { organizationId: true } } } } },
      })
      return record?.tariffSchedule.providerContract.organizationId ?? null
    }
  }
}

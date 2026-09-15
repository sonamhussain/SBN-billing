import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import type { ApplicabilityDimensionKey } from './rule-applicability.validation.ts'

export async function createRuleApplicabilityRecord(
  data: {
    ruleVersionId: string
    facilityId: string | null
    facilityRegulatoryProfileId: string | null
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

// Every A3.6 target dimension maps to a master whose organizationId is resolvable — a null
// return unambiguously means "target does not exist" (T12/T13), never "shared/no owner".
// TariffSchedule/TariffScheduleVersion have no organizationId of their own and are resolved by
// walking to their owning ProviderContract (REF-01 / R5).
export async function findTargetOrganizationId(
  key: ApplicabilityDimensionKey,
  id: string,
  db: DbClient = prisma,
): Promise<string | null> {
  switch (key) {
    case 'facilityId': {
      const record = await db.facility.findUnique({ where: { id }, select: { organizationId: true } })
      return record?.organizationId ?? null
    }
    case 'facilityRegulatoryProfileId': {
      const record = await db.facilityRegulatoryProfile.findUnique({
        where: { id },
        select: { facility: { select: { organizationId: true } } },
      })
      return record?.facility.organizationId ?? null
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

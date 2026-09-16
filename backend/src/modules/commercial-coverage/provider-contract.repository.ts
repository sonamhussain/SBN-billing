import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createProviderContractRecord(
  data: {
    organizationId: string
    payerId: string
    tpaId: string | null
    networkId: string | null
    insuranceProductId: string | null
    contractKey: string
    displayName: string
    effectiveFrom: Date
    effectiveTo: Date | null
  },
  db: DbClient = prisma,
) {
  return db.providerContract.create({ data })
}

export async function findProviderContractById(id: string, db: DbClient = prisma) {
  return db.providerContract.findUnique({ where: { id } })
}

export async function findProviderContractsByOrganizationId(organizationId: string, db: DbClient = prisma) {
  return db.providerContract.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } })
}

export async function updateProviderContractDisplayName(id: string, displayName: string, db: DbClient = prisma) {
  return db.providerContract.update({ where: { id }, data: { displayName } })
}

export async function createContractFacilityRecord(
  data: { providerContractId: string; facilityId: string },
  db: DbClient = prisma,
) {
  return db.contractFacility.create({ data })
}

export async function findContractFacilityById(id: string, db: DbClient = prisma) {
  return db.contractFacility.findUnique({ where: { id } })
}

export async function findContractFacilityWithContract(id: string, db: DbClient = prisma) {
  return db.contractFacility.findUnique({
    where: { id },
    include: { providerContract: { select: { organizationId: true } } },
  })
}

export async function findContractFacilitiesByContractId(providerContractId: string, db: DbClient = prisma) {
  return db.contractFacility.findMany({ where: { providerContractId }, orderBy: { createdAt: 'asc' } })
}

// REF-01 §9 (A3.6 context coherence): does this exact contract/facility pair already
// participate together — used to validate "facility participates in contract" for applicability.
export async function findContractFacilityByContractAndFacility(
  providerContractId: string,
  facilityId: string,
  db: DbClient = prisma,
) {
  return db.contractFacility.findFirst({ where: { providerContractId, facilityId } })
}

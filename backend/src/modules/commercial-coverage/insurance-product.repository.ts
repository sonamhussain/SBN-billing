import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createInsuranceProductRecord(
  data: { organizationId: string; payerId: string; productCode: string; displayName: string },
  db: DbClient = prisma,
) {
  return db.insuranceProduct.create({ data })
}

export async function findInsuranceProductById(id: string, db: DbClient = prisma) {
  return db.insuranceProduct.findUnique({ where: { id } })
}

export async function findInsuranceProductsByOrganizationId(organizationId: string, db: DbClient = prisma) {
  return db.insuranceProduct.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } })
}

export async function updateInsuranceProductDisplayName(id: string, displayName: string, db: DbClient = prisma) {
  return db.insuranceProduct.update({ where: { id }, data: { displayName } })
}

export async function createProductNetworkRecord(
  data: { insuranceProductId: string; networkId: string },
  db: DbClient = prisma,
) {
  return db.productNetwork.create({ data })
}

export async function findProductNetworkById(id: string, db: DbClient = prisma) {
  return db.productNetwork.findUnique({ where: { id } })
}

export async function findProductNetworkWithProduct(id: string, db: DbClient = prisma) {
  return db.productNetwork.findUnique({
    where: { id },
    include: { insuranceProduct: { select: { organizationId: true } } },
  })
}

export async function findProductNetworksByProductId(insuranceProductId: string, db: DbClient = prisma) {
  return db.productNetwork.findMany({ where: { insuranceProductId }, orderBy: { createdAt: 'asc' } })
}

// REF-01 §6 T36: a ProviderContract naming both an insuranceProduct and a network must use a
// ProductNetwork relationship that actually exists between that exact pair.
export async function findProductNetworkByProductAndNetwork(
  insuranceProductId: string,
  networkId: string,
  db: DbClient = prisma,
) {
  return db.productNetwork.findUnique({ where: { insuranceProductId_networkId: { insuranceProductId, networkId } } })
}

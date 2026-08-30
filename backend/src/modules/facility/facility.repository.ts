import { prisma } from '../../shared/database/prisma.ts'

export async function createFacilityRecord(organizationId: string, name: string) {
  return prisma.facility.create({ data: { organizationId, name } })
}

export async function findFacilityById(id: string) {
  return prisma.facility.findUnique({ where: { id } })
}

export async function updateFacilityRecord(id: string, name: string) {
  return prisma.facility.update({ where: { id }, data: { name } })
}

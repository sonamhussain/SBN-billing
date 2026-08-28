import { prisma } from '../../shared/database/prisma.ts'

export async function createOrganizationRecord(name: string) {
  return prisma.organization.create({ data: { name } })
}

export async function findOrganizationById(id: string) {
  return prisma.organization.findUnique({ where: { id } })
}

export async function updateOrganizationRecord(id: string, name: string) {
  return prisma.organization.update({
    where: { id },
    data: { name },
  })
}

import { prisma } from '../database/prisma.ts'

export async function findMembershipAccess(userId: string, organizationId: string) {
  return prisma.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    include: {
      roles: {
        include: {
          role: {
            include: {
              permissions: { include: { permission: true } },
            },
          },
        },
      },
    },
  })
}

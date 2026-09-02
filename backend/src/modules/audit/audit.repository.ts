import type { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import type { AuditWriteInput } from './audit.types.ts'

export async function createAuditEventRecord(input: AuditWriteInput, db: DbClient = prisma) {
  return db.auditEvent.create({
    data: {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      actionCode: input.actionCode,
      entityType: input.entityType,
      entityId: input.entityId,
      beforeState: (input.beforeState ?? undefined) as Prisma.InputJsonValue | undefined,
      afterState: (input.afterState ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  })
}

export async function findAuditEventsByOrganization(organizationId: string, limit: number) {
  return prisma.auditEvent.findMany({
    where: { organizationId },
    orderBy: { occurredAt: 'desc' },
    take: limit,
  })
}

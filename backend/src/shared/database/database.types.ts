import type { PrismaClient, Prisma } from '../../../generated/prisma/client.ts'

export type DbClient = PrismaClient | Prisma.TransactionClient

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../../../generated/prisma/client.ts'
import { serializedAdapter } from './serialized-transactions.ts'

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error('DATABASE_URL is required')
}

// CRG-01 Checkpoint B review: each interactive transaction's statements reach pg one after another (see
// serialized-transactions.ts) instead of through pg's deprecated implicit queue. Same statements, order and results.
const adapter = serializedAdapter(new PrismaPg({ connectionString }))

export const prisma = new PrismaClient({ adapter })

import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from './prisma.ts'
import type { DbClient } from './database.types.ts'

// Audit F04 — one read-only snapshot for one evaluation.
//
// A read-side evaluation (A3.7 executability, A3.8 resolution) reads context, applicability,
// bindings, candidate signals and the relationship graph in several stages. Under the default
// READ COMMITTED isolation each statement sees whatever was committed when IT ran, so a governance
// change committed between two stages can make one response combine facts that were never true
// together. Running every read of the evaluation through one REPEATABLE READ transaction gives all
// of them the same snapshot: the response reflects exactly one consistent state, from before or
// after a concurrent change, never a mixture.
//
// - When the caller already holds a transaction (A3.8 passing its snapshot to A3.7), that client
//   is reused, so a composed evaluation shares ONE snapshot rather than opening a second one.
// - The transaction is READ ONLY: the evaluation path writes nothing, and Postgres now enforces it.
// - This protects read consistency only. Write-side invariants keep their own locking protocol
//   (row-lock.ts); a read snapshot is not a substitute for it.
export async function withReadSnapshot<T>(db: DbClient | undefined, run: (tx: DbClient) => Promise<T>): Promise<T> {
  if (db) return run(db)
  return prisma.$transaction(
    async (tx) => {
      // Must precede the first query: the REPEATABLE READ snapshot is taken at the first statement.
      await tx.$executeRaw`SET TRANSACTION READ ONLY`
      return run(tx)
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
  )
}

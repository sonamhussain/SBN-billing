import { Prisma } from '../../../generated/prisma/client.ts'
import type { DbClient } from './database.types.ts'

// Audit F08 — the shared guarded-writer protocol. A writer whose decision depends on the current
// state of a governed row (a freeze such as VERIFIED/ACTIVE, or the predecessor recorded in an
// AuditEvent beforeState) locks that row FOR UPDATE before reading it and keeps the lock through
// write + audit. Every competing writer of the same row does the same, so a status read can never
// be invalidated between the read and the write, and a child append that depends on its parent's
// state locks the PARENT row (locking only the new child cannot protect the parent's freeze).
//
// Only the fixed table names below can be locked; the name is never taken from input.
const lockableTables = [
  'organizations',
  'facilities',
  'external_identifiers',
  'rule_sources',
  'rule_source_versions',
  'source_interpretations',
  'rule_versions',
  'tariff_schedule_versions',
  // Audit F11: the dataset row is the parent every dataset-version writer serializes on.
  'reference_datasets',
  // A3.9: every rule-pack version writer (dates, members, verification, activation) serializes on
  // the parent pack row, so a freeze or a one-ACTIVE decision is never read stale.
  'rule_packs',
  // A4.1: a patient update locks its own row, so two concurrent partial updates serialize and
  // the audit before-state is never read outside the transaction.
  'patients',
  // A4.2: every assignment writer for one clinician serializes on that clinician's row, so a
  // create-vs-create or create-vs-close race can never admit an overlapping period.
  'clinicians',
  // A4.3: a membership PATCH locks its own row, re-reads it and revalidates the resulting commercial
  // context, so two concurrent partial corrections serialize and neither erases the other.
  'insurance_memberships',
] as const

export type LockableTable = (typeof lockableTables)[number]

const lockableTableSet: ReadonlySet<string> = new Set(lockableTables)

// Returns false when the row does not exist (nothing was locked).
export async function lockRowForUpdate(db: DbClient, table: LockableTable, id: string): Promise<boolean> {
  if (!lockableTableSet.has(table)) throw new Error(`lockRowForUpdate: table ${String(table)} is not lockable`)
  const rows = await db.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id}::uuid FOR UPDATE`,
  )
  return rows.length > 0
}

import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A5.5 — Prisma access only, read-only. There is no create, update, upsert or delete anywhere in
// this file, and no row lock: resolution persists nothing and never blocks a writer.
//
// Every resolution query takes the caller's transaction client, so the whole resolution reads one
// snapshot. Only the fields the resolver needs are selected — no display name, key or timestamp,
// because none of them may decide applicability.

// Ownership for the Encounter-nested route, resolved through the Encounter's Patient before
// authorization. Nothing about the membership is read to authorize the caller.
export async function findEncounterOwnership(encounterId: string, db: DbClient = prisma) {
  return db.encounter.findUnique({ where: { id: encounterId }, select: { patient: { select: { organizationId: true } } } })
}

// The organization-and-payer superset of candidates. The remaining conditions — the optional
// dimensions, facility participation and dates — are judged in the pure resolver, where they are
// explicit and unit-tested, rather than hidden in a WHERE clause.
export async function findContractsForPayer(organizationId: string, payerId: string, db: DbClient) {
  return db.providerContract.findMany({
    where: { organizationId, payerId },
    select: {
      id: true,
      organizationId: true,
      payerId: true,
      tpaId: true,
      networkId: true,
      insuranceProductId: true,
      effectiveFrom: true,
      effectiveTo: true,
    },
  })
}

// Every schedule owned by the resolved contract, with every version's lifecycle and dates. All
// statuses are read so the resolver itself is what excludes the non-VERIFIED ones.
export async function findTariffSchedulesWithVersions(providerContractId: string, db: DbClient) {
  return db.tariffSchedule.findMany({
    where: { providerContractId },
    select: {
      id: true,
      versions: { select: { id: true, verificationStatus: true, verifiedAt: true, effectiveFrom: true, effectiveTo: true } },
    },
  })
}

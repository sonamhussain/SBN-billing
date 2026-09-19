import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

// A3.8 §4 + §17: every query in this module is a read. The resolver writes no row, no
// AuditEvent and no decision history — there is deliberately no create/update/delete here.

// RuleDefinition is the authoritative source of jurisdiction and ownership for a resolution;
// neither may ever come from the request body (A3.8 §9 step 1).
export async function findRuleDefinitionForResolution(id: string, db: DbClient = prisma) {
  return db.ruleDefinition.findUnique({
    where: { id },
    select: { id: true, organizationId: true, jurisdictionCode: true },
  })
}

// Every version of the rule. Filtering to VERIFIED + effective-on-businessDate happens in the
// service so the reason a version was excluded stays visible to the algorithm, and so ordering
// here can never be mistaken for precedence — `createdAt` ordering is presentation only.
export async function findRuleVersionsForResolution(ruleDefinitionId: string, db: DbClient = prisma) {
  return db.ruleVersion.findMany({
    where: { ruleId: ruleDefinitionId },
    select: {
      id: true,
      version: true,
      effectType: true,
      effectiveFrom: true,
      effectiveTo: true,
      verificationStatus: true,
    },
    orderBy: { createdAt: 'asc' },
  })
}

// Bindings with the full target chain, so the shared A3.7 candidate gate can be re-run for a
// historical businessDate without a second round of queries.
export async function findBindingsForResolution(ruleVersionId: string, db: DbClient = prisma) {
  return db.ruleSourceBinding.findMany({
    where: { ruleVersionId },
    include: { sourceInterpretation: { include: { sourceVersion: { include: { source: true } } } } },
    orderBy: { createdAt: 'asc' },
  })
}

// One hop of the SUPERSEDES graph in BOTH directions. The service walks this to closure so a
// chain S3 -> S2 -> S1 resolves even when only S3 and S1 are candidates (A3.8 §12), and so a
// successor that is not itself a candidate is still visible to the historical date rule (§13).
export async function findSupersedesEdgesTouching(sourceVersionIds: string[], db: DbClient = prisma) {
  if (sourceVersionIds.length === 0) return []
  return db.ruleSourceRelationship.findMany({
    where: {
      relationshipType: 'SUPERSEDES',
      OR: [
        { fromSourceVersionId: { in: sourceVersionIds } },
        { toSourceVersionId: { in: sourceVersionIds } },
      ],
    },
    select: { fromSourceVersionId: true, toSourceVersionId: true },
  })
}

// Effective dates for every version in the closure. Only dates are read — supersededAt,
// publicationDate and createdAt are deliberately not selected, so they cannot leak into
// precedence even by accident (A3.8 §13, §15).
export async function findSourceVersionEffectiveDates(sourceVersionIds: string[], db: DbClient = prisma) {
  if (sourceVersionIds.length === 0) return []
  return db.ruleSourceVersion.findMany({
    where: { id: { in: sourceVersionIds } },
    select: { id: true, effectiveFrom: true, effectiveTo: true },
  })
}

// CONFLICTS_WITH edges touching any of the supplied versions, used only for the fail-closed
// check in A3.8 §9 step 12 — never as a precedence rank.
export async function findConflictEdgesAmong(sourceVersionIds: string[], db: DbClient = prisma) {
  if (sourceVersionIds.length === 0) return []
  return db.ruleSourceRelationship.findMany({
    where: {
      relationshipType: 'CONFLICTS_WITH',
      OR: [
        { fromSourceVersionId: { in: sourceVersionIds } },
        { toSourceVersionId: { in: sourceVersionIds } },
      ],
    },
    select: { fromSourceVersionId: true, toSourceVersionId: true },
  })
}

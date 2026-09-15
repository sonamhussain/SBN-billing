import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'

export async function createRuleSourceBindingRecord(
  data: { ruleVersionId: string; sourceInterpretationId: string; sourceRole: string },
  db: DbClient = prisma,
) {
  return db.ruleSourceBinding.create({ data })
}

export async function findRuleSourceBindingById(id: string, db: DbClient = prisma) {
  return db.ruleSourceBinding.findUnique({ where: { id } })
}

export async function findRuleSourceBindingsByRuleVersionId(ruleVersionId: string, db: DbClient = prisma) {
  return db.ruleSourceBinding.findMany({ where: { ruleVersionId }, orderBy: { createdAt: 'asc' } })
}

// Ownership resolution for the by-id route: walks binding -> ruleVersion -> rule.organizationId.
export async function findRuleSourceBindingWithOrganization(id: string, db: DbClient = prisma) {
  return db.ruleSourceBinding.findUnique({
    where: { id },
    include: { ruleVersion: { include: { rule: { select: { organizationId: true } } } } },
  })
}

// Full target chain needed at binding-create time: interpretation's own verificationStatus,
// its parent sourceVersion (activation/publication/effective/verification state), and that
// version's source (organizationId, jurisdictionCode, sourceCategory).
export async function findSourceInterpretationForBinding(id: string, db: DbClient = prisma) {
  return db.sourceInterpretation.findUnique({
    where: { id },
    include: { sourceVersion: { include: { source: true } } },
  })
}

// RuleVersion + parent RuleDefinition's organizationId and jurisdictionCode — the rule's own
// jurisdiction is authoritative for the executability evaluate gate (A3.7 §8).
export async function findRuleVersionForExecutability(ruleVersionId: string, db: DbClient = prisma) {
  return db.ruleVersion.findUnique({
    where: { id: ruleVersionId },
    include: { rule: { select: { organizationId: true, jurisdictionCode: true } } },
  })
}

// Every binding for a RuleVersion with the full target chain needed to re-run the live
// A3.3/A3.4 source gate and A3-COMPAT-1 per governing candidate during evaluate.
export async function findRuleSourceBindingsForEvaluation(ruleVersionId: string, db: DbClient = prisma) {
  return db.ruleSourceBinding.findMany({
    where: { ruleVersionId },
    include: { sourceInterpretation: { include: { sourceVersion: { include: { source: true } } } } },
    orderBy: { createdAt: 'asc' },
  })
}

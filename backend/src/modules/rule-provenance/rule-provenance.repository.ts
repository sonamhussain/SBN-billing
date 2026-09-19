import type { DbClient } from '../../shared/database/database.types.ts'

// A3.9 — exact-ID reads for the internal provenance composer. Every lookup is by an exact UUID the
// A3.8 result already named; nothing here searches, ranks or picks a "latest" row, and nothing
// writes. The caller always passes its read snapshot, so there is no default client.

export async function findRuleVersionForProvenance(ruleVersionId: string, db: DbClient) {
  return db.ruleVersion.findUnique({
    where: { id: ruleVersionId },
    select: { id: true, ruleId: true, version: true, rule: { select: { id: true, organizationId: true, jurisdictionCode: true } } },
  })
}

export async function findBindingsForProvenance(bindingIds: string[], db: DbClient) {
  if (bindingIds.length === 0) return []
  return db.ruleSourceBinding.findMany({
    where: { id: { in: bindingIds } },
    select: {
      id: true,
      ruleVersionId: true,
      sourceRole: true,
      sourceInterpretationId: true,
      sourceInterpretation: {
        select: { id: true, sourceVersionId: true, sourceVersion: { select: { id: true, sourceId: true, version: true } } },
      },
    },
  })
}

export async function findApplicabilitiesForProvenance(applicabilityIds: string[], db: DbClient) {
  if (applicabilityIds.length === 0) return []
  return db.ruleApplicability.findMany({ where: { id: { in: applicabilityIds } }, select: { id: true, ruleVersionId: true } })
}

export async function findRulePackVersionForProvenance(rulePackVersionId: string, db: DbClient) {
  return db.rulePackVersion.findUnique({
    where: { id: rulePackVersionId },
    select: {
      id: true,
      version: true,
      effectiveFrom: true,
      effectiveTo: true,
      verificationStatus: true,
      activationStatus: true,
      rulePack: { select: { id: true, organizationId: true, jurisdictionCode: true } },
    },
  })
}

export async function findExactPackMembership(rulePackVersionId: string, ruleVersionId: string, db: DbClient) {
  return db.rulePackMember.findUnique({
    where: { rulePackVersionId_ruleVersionId: { rulePackVersionId, ruleVersionId } },
    select: { id: true },
  })
}

import { prisma } from '../../shared/database/prisma.ts'
import { evaluateRuleResolution } from '../../modules/rule-resolution/rule-resolution.service.ts'
import type { RuleResolutionDto } from '../../modules/rule-resolution/rule-resolution.types.ts'

// Shared synthetic-row builders for the A3.8 correction scripts (F02, F03, F04, F05-B, C35). Every
// row is tagged with the run tag so a run never collides with another, and no helper here ever
// deletes anything.

export function d(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`)
}

export type Checker = {
  check: (label: string, condition: boolean, detail?: string) => void
  eq: (label: string, actual: unknown, expected: unknown) => void
  section: (title: string) => void
  finish: () => void
}

export function createChecker(prefix: string): Checker {
  let passed = 0
  let failed = 0
  const check = (label: string, condition: boolean, detail = '') => {
    if (condition) {
      passed += 1
      console.log(`  PASS  ${label}`)
    } else {
      failed += 1
      console.log(`  FAIL  ${label} ${detail}`)
    }
  }
  return {
    check,
    eq: (label, actual, expected) =>
      check(label, actual === expected, `(expected ${String(expected)}, got ${String(actual)})`),
    section: (title) => console.log(`\n[${prefix}] ${title}`),
    finish: () => {
      console.log(`\n[${prefix}] ${passed} passed, ${failed} failed`)
      console.log(failed === 0 ? `[${prefix}] ALL CHECKS PASS` : `[${prefix}] CHECKS FAILED`)
      process.exitCode = failed === 0 ? 0 : 1
    },
  }
}

export type ResolveOutcome =
  | { ok: true; value: RuleResolutionDto }
  | { ok: false; code: string; message: string }

export async function resolveRaw(
  ruleDefinitionId: string,
  businessDate: string,
  context: Record<string, unknown> = {},
): Promise<ResolveOutcome> {
  return evaluateRuleResolution(ruleDefinitionId, businessDate, context)
}

export async function resolve(
  ruleDefinitionId: string,
  businessDate: string,
  context: Record<string, unknown> = {},
): Promise<RuleResolutionDto> {
  const result = await evaluateRuleResolution(ruleDefinitionId, businessDate, context)
  if (!result.ok) throw new Error(`resolver returned ${result.code}: ${result.message}`)
  return result.value
}

export function a38Fixtures(org: string, tag: string) {
  let counter = 0
  const next = (name: string) => `${tag}-${++counter}-${name}`

  async function makeRule(name: string, jurisdictionCode = 'AE-DU') {
    return prisma.ruleDefinition.create({
      data: { organizationId: org, ruleKey: next(name), displayName: `A3.8 ${name}`, jurisdictionCode, ownershipScope: 'ORGANIZATION' },
    })
  }

  async function makeRuleVersion(
    ruleId: string,
    version: string,
    opts: { effectType?: string; effectiveFrom?: Date | null; effectiveTo?: Date | null; verificationStatus?: string } = {},
  ) {
    const verificationStatus = opts.verificationStatus ?? 'VERIFIED'
    return prisma.ruleVersion.create({
      data: {
        ruleId,
        version,
        effectType: opts.effectType ?? 'AUTHORIZATION_REQUIREMENT_EFFECT',
        effectiveFrom: opts.effectiveFrom === undefined ? d('2020-01-01') : opts.effectiveFrom,
        effectiveTo: opts.effectiveTo ?? null,
        verificationStatus,
        verifiedAt: verificationStatus === 'VERIFIED' ? new Date() : null,
      },
    })
  }

  // An all-null applicability row matches every context.
  async function makeApplicability(ruleVersionId: string, dims: Record<string, string | null> = {}) {
    return prisma.ruleApplicability.create({ data: { ruleVersionId, ...dims } })
  }

  // A published, verified source version with a verified interpretation, bound to the rule
  // version. Rows inserted with activation evidence carry the F09 ever-activated fact.
  async function attachSource(
    ruleVersionId: string,
    name: string,
    opts: {
      role?: string
      category?: string
      effectiveFrom?: Date | null
      effectiveTo?: Date | null
      activationStatus?: string
    } = {},
  ) {
    const source = await prisma.ruleSource.create({
      data: {
        organizationId: org,
        jurisdictionCode: 'AE-DU',
        issuingAuthority: 'Synthetic Authority',
        sourceCategory: opts.category ?? 'REGULATORY_AUTHORITY',
        referenceNumber: next(name),
        title: `A3.8 ${name}`,
        ownershipScope: 'ORGANIZATION',
      },
    })
    const activationStatus = opts.activationStatus ?? 'ACTIVE'
    const sourceVersion = await prisma.ruleSourceVersion.create({
      data: {
        sourceId: source.id,
        version: '1',
        rawEvidenceRef: `synthetic-evidence://a3-8/${next(name)}`,
        publicationStatus: 'PUBLISHED',
        publicationDate: d('2020-01-01'),
        effectiveFrom: opts.effectiveFrom === undefined ? d('2020-01-01') : opts.effectiveFrom,
        effectiveTo: opts.effectiveTo ?? null,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
        activationStatus,
        activatedAt: activationStatus === 'INACTIVE' ? null : new Date(),
        everActivated: activationStatus !== 'INACTIVE',
        firstActivatedAt: activationStatus === 'INACTIVE' ? null : new Date(),
        supersededAt: activationStatus === 'SUPERSEDED' ? new Date() : null,
        retiredAt: activationStatus === 'RETIRED' ? new Date() : null,
        suspendedAt: activationStatus === 'SUSPENDED' ? new Date() : null,
      },
    })
    const interpretation = await addInterpretation(sourceVersion.id, name)
    const binding = await bind(ruleVersionId, interpretation.id, opts.role ?? 'GOVERNING')
    return { source, sourceVersion, interpretation, binding }
  }

  async function addInterpretation(sourceVersionId: string, name: string) {
    return prisma.sourceInterpretation.create({
      data: {
        sourceVersionId,
        interpretationVersion: next('interp'),
        normalizedInterpretationRef: `synthetic-interpretation://a3-8/${next(name)}`,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
      },
    })
  }

  async function bind(ruleVersionId: string, sourceInterpretationId: string, sourceRole = 'GOVERNING') {
    return prisma.ruleSourceBinding.create({ data: { ruleVersionId, sourceInterpretationId, sourceRole } })
  }

  async function relate(fromSourceVersionId: string, toSourceVersionId: string, relationshipType: string) {
    return prisma.ruleSourceRelationship.create({ data: { fromSourceVersionId, toSourceVersionId, relationshipType } })
  }

  async function facility(name: string, owner = org) {
    return prisma.facility.create({ data: { organizationId: owner, name: next(name) } })
  }

  async function profile(facilityId: string, from: string, to: string | null, jurisdictionCode = 'AE-DU', status = 'ACTIVE') {
    return prisma.facilityRegulatoryProfile.create({
      data: {
        facilityId,
        jurisdictionCode,
        regulatoryAuthorityCode: jurisdictionCode === 'AE-DU' ? 'DHA' : 'DOH',
        effectiveFrom: d(from),
        effectiveTo: to ? d(to) : null,
        status,
      },
    })
  }

  return { makeRule, makeRuleVersion, makeApplicability, attachSource, addInterpretation, bind, relate, facility, profile }
}

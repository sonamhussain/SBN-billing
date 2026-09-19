import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import { evaluateRuleResolution } from '../modules/rule-resolution/rule-resolution.service.ts'
import type { RuleResolutionDto } from '../modules/rule-resolution/rule-resolution.types.ts'

// Reproducible A3.8 proof over real synthetic rows. Everything the pure helpers can prove lives
// in rule-resolution.precedence.test.ts; this script proves the end-to-end resolver behaviour
// that only a live database can show — candidate filtering, the reused A3.7 gate, historical
// resolution, and that evaluation mutates nothing at all.

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

function eq(label: string, actual: unknown, expected: unknown) {
  check(label, actual === expected, `(expected ${String(expected)}, got ${String(actual)})`)
}

function section(title: string) {
  console.log(`\n[a3.8] ${title}`)
}

function d(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`)
}

const tag = `A38-${Date.now()}`
const organizationId = process.env.AUTHZ_BOOTSTRAP_ORGANIZATION_ID

async function resolve(
  ruleDefinitionId: string,
  businessDate: string,
  context: Record<string, unknown> = {},
): Promise<RuleResolutionDto> {
  const result = await evaluateRuleResolution(ruleDefinitionId, businessDate, context)
  if (!result.ok) throw new Error(`resolver returned ${result.code}: ${result.message}`)
  return result.value
}

async function main() {
  if (!organizationId) throw new Error('AUTHZ_BOOTSTRAP_ORGANIZATION_ID is required')
  const org = organizationId

  console.log(`[a3.8] run tag ${tag} — organization ${org}`)

  // ---- shared context masters --------------------------------------------------------------
  const payer = await prisma.payer.create({ data: { organizationId: org, displayName: `${tag} Payer 1` } })
  const otherPayer = await prisma.payer.create({ data: { organizationId: org, displayName: `${tag} Payer 2` } })
  const service = await prisma.service.create({
    data: { organizationId: org, internalCode: `${tag}-SVC`, displayName: `${tag} Service` },
  })

  const ctxPayer = { payerId: payer.id }
  const ctxPayerService = { payerId: payer.id, serviceId: service.id }

  // ---- fixture helpers ---------------------------------------------------------------------
  async function makeRule(name: string) {
    return prisma.ruleDefinition.create({
      data: {
        organizationId: org,
        ruleKey: `${tag}-${name}`,
        displayName: `A3.8 ${name}`,
        jurisdictionCode: 'AE-DU',
        ownershipScope: 'ORGANIZATION',
      },
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

  async function makeApplicability(ruleVersionId: string, dims: Record<string, string | null> = {}) {
    return prisma.ruleApplicability.create({ data: { ruleVersionId, ...dims } })
  }

  async function attachSource(
    ruleVersionId: string,
    name: string,
    opts: {
      role?: string
      category?: string
      authority?: string
      effectiveFrom?: Date | null
      effectiveTo?: Date | null
      activationStatus?: string
      publicationDate?: Date
    } = {},
  ) {
    const source = await prisma.ruleSource.create({
      data: {
        organizationId: org,
        jurisdictionCode: 'AE-DU',
        issuingAuthority: opts.authority ?? 'Synthetic Authority',
        sourceCategory: opts.category ?? 'REGULATORY_AUTHORITY',
        referenceNumber: `${tag}-${name}`,
        title: `A3.8 ${name}`,
        ownershipScope: 'ORGANIZATION',
      },
    })

    const activationStatus = opts.activationStatus ?? 'ACTIVE'
    const sourceVersion = await prisma.ruleSourceVersion.create({
      data: {
        sourceId: source.id,
        version: '1',
        rawEvidenceRef: `synthetic-evidence://a3-8/${tag}/${name}`,
        publicationStatus: 'PUBLISHED',
        publicationDate: opts.publicationDate ?? d('2020-01-01'),
        effectiveFrom: opts.effectiveFrom === undefined ? d('2020-01-01') : opts.effectiveFrom,
        effectiveTo: opts.effectiveTo ?? null,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
        activationStatus,
        activatedAt: activationStatus === 'INACTIVE' ? null : new Date(),
        // Audit F09: a row inserted with activation evidence carries the durable ever-activated
        // fact, exactly as the real activation path records it. The F09 CHECK rejects ACTIVE
        // without it, which is the constraint working, not a fixture quirk to work around.
        everActivated: activationStatus !== 'INACTIVE',
        firstActivatedAt: activationStatus === 'INACTIVE' ? null : new Date(),
        supersededAt: activationStatus === 'SUPERSEDED' ? new Date() : null,
      },
    })

    const interpretation = await prisma.sourceInterpretation.create({
      data: {
        sourceVersionId: sourceVersion.id,
        interpretationVersion: '1',
        normalizedInterpretationRef: `synthetic-interpretation://a3-8/${tag}/${name}`,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
      },
    })

    const binding = await prisma.ruleSourceBinding.create({
      data: { ruleVersionId, sourceInterpretationId: interpretation.id, sourceRole: opts.role ?? 'GOVERNING' },
    })

    return { source, sourceVersion, interpretation, binding }
  }

  async function relate(fromSourceVersionId: string, toSourceVersionId: string, relationshipType: string) {
    return prisma.ruleSourceRelationship.create({ data: { fromSourceVersionId, toSourceVersionId, relationshipType } })
  }

  // ---- T13-T16 candidate filtering ---------------------------------------------------------
  section('T13-T16 candidate RuleVersion filtering')

  const ruleNoVersions = await makeRule('no-versions')
  eq('T13 a rule with no versions is NO_MATCH', (await resolve(ruleNoVersions.id, '2026-10-15')).resolutionStatus, 'NO_MATCH')

  const ruleUnverified = await makeRule('unverified')
  const unverified = await makeRuleVersion(ruleUnverified.id, '1', { verificationStatus: 'UNVERIFIED' })
  await makeApplicability(unverified.id)
  await attachSource(unverified.id, 'unverified-src')
  eq('T14 an unverified version never becomes a candidate', (await resolve(ruleUnverified.id, '2026-10-15')).resolutionStatus, 'NO_MATCH')

  const ruleFuture = await makeRule('not-effective')
  const future = await makeRuleVersion(ruleFuture.id, '1', { effectiveFrom: d('2027-01-01') })
  await makeApplicability(future.id)
  await attachSource(future.id, 'future-src')
  eq('T15 a version not effective on the date never becomes a candidate', (await resolve(ruleFuture.id, '2026-10-15')).resolutionStatus, 'NO_MATCH')

  const ruleMismatch = await makeRule('applicability-mismatch')
  const mismatch = await makeRuleVersion(ruleMismatch.id, '1')
  await makeApplicability(mismatch.id, { payerId: payer.id })
  await attachSource(mismatch.id, 'mismatch-src')
  eq(
    'T16 an applicability mismatch is NO_MATCH',
    (await resolve(ruleMismatch.id, '2026-10-15', { payerId: otherPayer.id })).resolutionStatus,
    'NO_MATCH',
  )

  // ---- T17-T20 specificity scoring ---------------------------------------------------------
  section('T17-T20 applicability specificity')

  const ruleWildcard = await makeRule('wildcard')
  const wildcardVersion = await makeRuleVersion(ruleWildcard.id, '1')
  await makeApplicability(wildcardVersion.id)
  const wildcardSource = await attachSource(wildcardVersion.id, 'wildcard-src')
  const wildcardResult = await resolve(ruleWildcard.id, '2026-10-15')
  eq('T17 wildcard match scores 0', wildcardResult.specificityScore, 0)
  eq('T17 wildcard match resolves', wildcardResult.resolutionStatus, 'RESOLVED')

  const rulePayerOnly = await makeRule('payer-only')
  const payerOnlyVersion = await makeRuleVersion(rulePayerOnly.id, '1')
  await makeApplicability(payerOnlyVersion.id, { payerId: payer.id })
  await attachSource(payerOnlyVersion.id, 'payer-only-src')
  eq('T18 payer-only match scores 1', (await resolve(rulePayerOnly.id, '2026-10-15', ctxPayer)).specificityScore, 1)

  const rulePayerService = await makeRule('payer-service')
  const payerServiceVersion = await makeRuleVersion(rulePayerService.id, '1')
  const wildcardRow = await makeApplicability(payerServiceVersion.id)
  const specificRow = await makeApplicability(payerServiceVersion.id, { payerId: payer.id, serviceId: service.id })
  await attachSource(payerServiceVersion.id, 'payer-service-src')
  const payerServiceResult = await resolve(rulePayerService.id, '2026-10-15', ctxPayerService)
  eq('T19/T20 the best matching row score is used', payerServiceResult.specificityScore, 2)
  eq('T52 both matching rows are reported', payerServiceResult.matchedApplicabilityIds.length, 2)
  check(
    'T52 matched ids are exactly the two matching rows',
    payerServiceResult.matchedApplicabilityIds.includes(wildcardRow.id) &&
      payerServiceResult.matchedApplicabilityIds.includes(specificRow.id),
  )

  // ---- T21-T24 RuleVersion selection and ties ----------------------------------------------
  section('T21-T24 RuleVersion selection')

  const ruleSpecificWins = await makeRule('specific-wins')
  const lessSpecific = await makeRuleVersion(ruleSpecificWins.id, '2')
  await makeApplicability(lessSpecific.id, { payerId: payer.id })
  await attachSource(lessSpecific.id, 'less-specific-src')
  const moreSpecific = await makeRuleVersion(ruleSpecificWins.id, '1')
  await makeApplicability(moreSpecific.id, { payerId: payer.id, serviceId: service.id })
  await attachSource(moreSpecific.id, 'more-specific-src')
  const specificWins = await resolve(ruleSpecificWins.id, '2026-10-15', ctxPayerService)
  eq('T21 the more specific RuleVersion wins', specificWins.ruleVersionId, moreSpecific.id)
  eq('T24 the earlier-created, lower-numbered version still wins on specificity', specificWins.ruleVersion, '1')

  const ruleTie = await makeRule('version-tie')
  const tieV2 = await makeRuleVersion(ruleTie.id, '2')
  await makeApplicability(tieV2.id, { payerId: payer.id, serviceId: service.id })
  await attachSource(tieV2.id, 'tie-v2-src')
  const tieV10 = await makeRuleVersion(ruleTie.id, '10')
  await makeApplicability(tieV10.id, { payerId: payer.id, serviceId: service.id })
  await attachSource(tieV10.id, 'tie-v10-src')
  const tieResult = await resolve(ruleTie.id, '2026-10-15', ctxPayerService)
  eq('T22 equal specificity blocks', tieResult.resolutionStatus, 'BLOCKED_RULE_VERSION_CONFLICT')
  eq('T23 v10 did not lexically beat v2', tieResult.ruleVersionId, null)
  eq('T24 the later-created version did not win', tieResult.ruleVersion, null)
  eq('T22 the tie is reported as a specificity tie', tieResult.blockers.join(','), 'RULE_VERSION_SPECIFICITY_TIE')
  check('T22 no winner is manufactured', tieResult.governingBindingId === null)

  // ---- T25-T26 reference only --------------------------------------------------------------
  section('T25-T26 REFERENCE_ONLY')

  const ruleReference = await makeRule('reference-only')
  const referenceVersion = await makeRuleVersion(ruleReference.id, '1', { effectType: 'REFERENCE_ONLY' })
  await makeApplicability(referenceVersion.id)
  await attachSource(referenceVersion.id, 'reference-src')
  const referenceResult = await resolve(ruleReference.id, '2026-10-15')
  eq('T25 a reference-only rule resolves to REFERENCE_ONLY', referenceResult.resolutionStatus, 'REFERENCE_ONLY')
  eq('T25 the selected RuleVersion is still reported', referenceResult.ruleVersionId, referenceVersion.id)
  check(
    'T25 every winner source field is null',
    referenceResult.governingBindingId === null &&
      referenceResult.governingSourceInterpretationId === null &&
      referenceResult.governingSourceVersionId === null &&
      referenceResult.governingSourceId === null,
  )
  eq('T26 reference-only never claims historical execution', referenceResult.historicalOnly, false)

  // ---- T27-T30 executability gate and candidate set ----------------------------------------
  section('T27-T30 A3.7 gate reuse and candidate set')

  const ruleBlocked = await makeRule('gate-blocked')
  const blockedVersion = await makeRuleVersion(ruleBlocked.id, '1')
  await makeApplicability(blockedVersion.id)
  await attachSource(blockedVersion.id, 'inactive-src', { activationStatus: 'INACTIVE' })
  const blockedResult = await resolve(ruleBlocked.id, '2026-10-15')
  eq('T27 a blocked A3.7 gate blocks resolution', blockedResult.resolutionStatus, 'BLOCKED_EXECUTABILITY')
  check('T27 no winner on a blocked gate', blockedResult.governingBindingId === null)
  check('T27 the A3.7 blockers are passed through', blockedResult.blockers.includes('MISSING_GOVERNING_SOURCE'))

  const ruleOne = await makeRule('single-candidate')
  const oneVersion = await makeRuleVersion(ruleOne.id, '1')
  await makeApplicability(oneVersion.id)
  const onlySource = await attachSource(oneVersion.id, 'only-src')
  const oneResult = await resolve(ruleOne.id, '2026-10-15')
  eq('T28/T29 a single governing candidate resolves', oneResult.resolutionStatus, 'RESOLVED')
  eq('T50 the exact binding id is returned', oneResult.governingBindingId, onlySource.binding.id)
  eq('T50 the exact interpretation id is returned', oneResult.governingSourceInterpretationId, onlySource.interpretation.id)
  eq('T50 the exact source version id is returned', oneResult.governingSourceVersionId, onlySource.sourceVersion.id)
  eq('T50 the exact source id is returned', oneResult.governingSourceId, onlySource.source.id)
  eq('T49 the precedence policy version is returned', oneResult.precedencePolicyVersion, 'A3-PREC-1')
  eq('T12 jurisdiction comes from the RuleDefinition', oneResult.jurisdictionCode, 'AE-DU')
  eq('T46 a current winner is not historical', oneResult.historicalOnly, false)

  const ruleTwo = await makeRule('two-candidates')
  const twoVersion = await makeRuleVersion(ruleTwo.id, '1')
  await makeApplicability(twoVersion.id)
  await attachSource(twoVersion.id, 'cand-a', { authority: 'Aaa Authority', publicationDate: d('2020-01-01') })
  await attachSource(twoVersion.id, 'cand-b', { authority: 'Zzz Authority', publicationDate: d('2026-01-01') })
  const twoResult = await resolve(ruleTwo.id, '2026-10-15')
  eq('T30/T42 two unrelated candidates block', twoResult.resolutionStatus, 'BLOCKED_SOURCE_PRECEDENCE_CONFLICT')
  eq('T30 the block is reported as a precedence tie', twoResult.blockers.join(','), 'SOURCE_PRECEDENCE_TIE')
  check('T37 the newer publication date did not win', twoResult.governingSourceId === null)
  check('T38/T40 neither creation order nor authority text produced a winner', twoResult.governingBindingId === null)

  const ruleCategories = await makeRule('two-categories')
  const categoriesVersion = await makeRuleVersion(ruleCategories.id, '1', { effectType: 'CLAIM_EDIT_EFFECT' })
  await makeApplicability(categoriesVersion.id)
  await attachSource(categoriesVersion.id, 'cat-regulatory', { category: 'REGULATORY_AUTHORITY' })
  await attachSource(categoriesVersion.id, 'cat-standard', { category: 'CLAIMS_STANDARD' })
  eq(
    'T39 no invented source-category rank breaks the tie',
    (await resolve(ruleCategories.id, '2026-10-15')).resolutionStatus,
    'BLOCKED_SOURCE_PRECEDENCE_CONFLICT',
  )

  // ---- T31-T36 relationship semantics ------------------------------------------------------
  section('T31-T36 relationship semantics')

  const ruleDirect = await makeRule('direct-supersedes')
  const directVersion = await makeRuleVersion(ruleDirect.id, '1')
  await makeApplicability(directVersion.id)
  const directOld = await attachSource(directVersion.id, 'direct-old')
  const directNew = await attachSource(directVersion.id, 'direct-new', { effectiveFrom: d('2021-01-01') })
  await relate(directNew.sourceVersion.id, directOld.sourceVersion.id, 'SUPERSEDES')
  const directResult = await resolve(ruleDirect.id, '2026-10-15')
  eq('T31 a direct SUPERSEDES resolves to the superseder', directResult.resolutionStatus, 'RESOLVED')
  eq('T31 the superseder is the winner', directResult.governingSourceVersionId, directNew.sourceVersion.id)

  const ruleChain = await makeRule('transitive-supersedes')
  const chainVersion = await makeRuleVersion(ruleChain.id, '1')
  await makeApplicability(chainVersion.id)
  const chain1 = await attachSource(chainVersion.id, 'chain-s1')
  const chain2 = await attachSource(chainVersion.id, 'chain-s2', { effectiveFrom: d('2021-01-01') })
  const chain3 = await attachSource(chainVersion.id, 'chain-s3', { effectiveFrom: d('2022-01-01') })
  await relate(chain3.sourceVersion.id, chain2.sourceVersion.id, 'SUPERSEDES')
  await relate(chain2.sourceVersion.id, chain1.sourceVersion.id, 'SUPERSEDES')
  const chainResult = await resolve(ruleChain.id, '2026-10-15')
  eq('T32 a transitive SUPERSEDES chain resolves to the top descendant', chainResult.resolutionStatus, 'RESOLVED')
  eq('T32 the top of the chain is the winner', chainResult.governingSourceVersionId, chain3.sourceVersion.id)

  const ruleAmends = await makeRule('amends-only')
  const amendsVersion = await makeRuleVersion(ruleAmends.id, '1')
  await makeApplicability(amendsVersion.id)
  const amendsOld = await attachSource(amendsVersion.id, 'amends-old')
  const amendsNew = await attachSource(amendsVersion.id, 'amends-new', { effectiveFrom: d('2021-01-01') })
  await relate(amendsNew.sourceVersion.id, amendsOld.sourceVersion.id, 'AMENDS')
  eq(
    'T33 AMENDS does not auto-eliminate the amended source',
    (await resolve(ruleAmends.id, '2026-10-15')).resolutionStatus,
    'BLOCKED_SOURCE_PRECEDENCE_CONFLICT',
  )

  const ruleReferences = await makeRule('references-only')
  const referencesVersion = await makeRuleVersion(ruleReferences.id, '1')
  await makeApplicability(referencesVersion.id)
  const refA = await attachSource(referencesVersion.id, 'ref-a')
  const refB = await attachSource(referencesVersion.id, 'ref-b', { effectiveFrom: d('2021-01-01') })
  await relate(refB.sourceVersion.id, refA.sourceVersion.id, 'REFERENCES')
  eq(
    'T34 REFERENCES never affects precedence',
    (await resolve(ruleReferences.id, '2026-10-15')).resolutionStatus,
    'BLOCKED_SOURCE_PRECEDENCE_CONFLICT',
  )

  const ruleConflict = await makeRule('conflicts-with')
  const conflictVersion = await makeRuleVersion(ruleConflict.id, '1')
  await makeApplicability(conflictVersion.id)
  const conflictA = await attachSource(conflictVersion.id, 'conflict-a')
  const conflictB = await attachSource(conflictVersion.id, 'conflict-b')
  await relate(conflictA.sourceVersion.id, conflictB.sourceVersion.id, 'CONFLICTS_WITH')
  const conflictResult = await resolve(ruleConflict.id, '2026-10-15')
  check('T36 a conflict blocks', conflictResult.resolutionStatus.startsWith('BLOCKED'), `(got ${conflictResult.resolutionStatus})`)
  check('T36 a conflict produces no winner', conflictResult.governingBindingId === null)

  // ---- T41 supporting bindings -------------------------------------------------------------
  section('T41/T51 supporting bindings')

  const ruleSupporting = await makeRule('supporting')
  const supportingVersion = await makeRuleVersion(ruleSupporting.id, '1')
  await makeApplicability(supportingVersion.id)
  const governing = await attachSource(supportingVersion.id, 'sup-governing')
  const support1 = await attachSource(supportingVersion.id, 'sup-1', { role: 'SUPPORTING' })
  const support2 = await attachSource(supportingVersion.id, 'sup-2', { role: 'SUPPORTING' })
  const supportingResult = await resolve(ruleSupporting.id, '2026-10-15')
  eq('T41 supporting bindings never make the resolution ambiguous', supportingResult.resolutionStatus, 'RESOLVED')
  eq('T41 the governing binding is the winner', supportingResult.governingBindingId, governing.binding.id)
  eq('T51 both supporting bindings are preserved', supportingResult.supportingBindingIds.length, 2)
  check(
    'T51 the supporting ids are exact',
    supportingResult.supportingBindingIds.includes(support1.binding.id) &&
      supportingResult.supportingBindingIds.includes(support2.binding.id),
  )

  // ---- T43-T48 historical resolution -------------------------------------------------------
  section('T43-T48 historical resolution')

  const ruleHistory = await makeRule('historical')
  const historyVersion = await makeRuleVersion(ruleHistory.id, '1')
  await makeApplicability(historyVersion.id)
  const predecessor = await attachSource(historyVersion.id, 'hist-predecessor', {
    effectiveFrom: d('2026-01-01'),
    effectiveTo: d('2026-06-30'),
    activationStatus: 'SUPERSEDED',
  })
  const successor = await attachSource(historyVersion.id, 'hist-successor', { effectiveFrom: d('2026-07-01') })
  await relate(successor.sourceVersion.id, predecessor.sourceVersion.id, 'SUPERSEDES')

  const pastResult = await resolve(ruleHistory.id, '2026-03-15')
  eq('T43 a date before the successor resolves the predecessor', pastResult.resolutionStatus, 'RESOLVED')
  eq('T45 the superseded version id is still retrievable', pastResult.governingSourceVersionId, predecessor.sourceVersion.id)
  eq('T46 a non-current winner sets historicalOnly', pastResult.historicalOnly, true)
  check(
    'T47 a historical response carries no executable/allowed claim',
    !Object.keys(pastResult).some((key) => /execut|allow|approved/i.test(key)),
  )

  const currentResult = await resolve(ruleHistory.id, '2026-08-15')
  eq('T44 a date on/after the successor resolves the successor', currentResult.resolutionStatus, 'RESOLVED')
  eq('T44 the successor is the winner', currentResult.governingSourceVersionId, successor.sourceVersion.id)
  eq('T44 the current winner is not historical', currentResult.historicalOnly, false)

  const boundaryResult = await resolve(ruleHistory.id, '2026-07-01')
  eq('T44 the successor effectiveFrom date itself already belongs to the successor', boundaryResult.governingSourceVersionId, successor.sourceVersion.id)

  const ruleNoDate = await makeRule('successor-without-date')
  const noDateVersion = await makeRuleVersion(ruleNoDate.id, '1')
  await makeApplicability(noDateVersion.id)
  const oldWithDate = await attachSource(noDateVersion.id, 'nodate-predecessor', {
    effectiveFrom: d('2026-01-01'),
    activationStatus: 'SUPERSEDED',
  })
  const newWithoutDate = await attachSource(noDateVersion.id, 'nodate-successor', { effectiveFrom: null })
  await relate(newWithoutDate.sourceVersion.id, oldWithDate.sourceVersion.id, 'SUPERSEDES')
  const noDateResult = await resolve(ruleNoDate.id, '2026-10-15')
  eq('T48 a successor with no effectiveFrom fails closed', noDateResult.resolutionStatus, 'BLOCKED_SOURCE_PRECEDENCE_CONFLICT')
  eq('T48 the blocker names the missing date', noDateResult.blockers.join(','), 'SUPERSEDES_EFFECTIVE_DATE_INCOMPLETE')
  check('T48 supersededAt was never used to infer an order', noDateResult.governingSourceVersionId === null)

  // ---- T04/T53/T54/T55 no persistence ------------------------------------------------------
  section('T04/T53/T54/T55 evaluation writes nothing')

  const beforeCounts = {
    auditEvents: await prisma.auditEvent.count(),
    ruleVersions: await prisma.ruleVersion.count(),
    applicabilities: await prisma.ruleApplicability.count(),
    bindings: await prisma.ruleSourceBinding.count(),
    relationships: await prisma.ruleSourceRelationship.count(),
    sourceVersions: await prisma.ruleSourceVersion.count(),
  }
  const ruleBefore = await prisma.ruleDefinition.findUniqueOrThrow({ where: { id: ruleOne.id } })
  const versionBefore = await prisma.ruleVersion.findUniqueOrThrow({ where: { id: oneVersion.id } })
  const sourceVersionBefore = await prisma.ruleSourceVersion.findUniqueOrThrow({ where: { id: onlySource.sourceVersion.id } })

  for (let i = 0; i < 3; i += 1) await resolve(ruleOne.id, '2026-10-15')

  const afterCounts = {
    auditEvents: await prisma.auditEvent.count(),
    ruleVersions: await prisma.ruleVersion.count(),
    applicabilities: await prisma.ruleApplicability.count(),
    bindings: await prisma.ruleSourceBinding.count(),
    relationships: await prisma.ruleSourceRelationship.count(),
    sourceVersions: await prisma.ruleSourceVersion.count(),
  }
  const ruleAfter = await prisma.ruleDefinition.findUniqueOrThrow({ where: { id: ruleOne.id } })
  const versionAfter = await prisma.ruleVersion.findUniqueOrThrow({ where: { id: oneVersion.id } })
  const sourceVersionAfter = await prisma.ruleSourceVersion.findUniqueOrThrow({ where: { id: onlySource.sourceVersion.id } })

  eq('T54 the AuditEvent count is unchanged', afterCounts.auditEvents, beforeCounts.auditEvents)
  eq('T04 the RuleVersion row count is unchanged', afterCounts.ruleVersions, beforeCounts.ruleVersions)
  eq('T04 the RuleApplicability row count is unchanged', afterCounts.applicabilities, beforeCounts.applicabilities)
  eq('T04 the RuleSourceBinding row count is unchanged', afterCounts.bindings, beforeCounts.bindings)
  eq('T04 the RuleSourceRelationship row count is unchanged', afterCounts.relationships, beforeCounts.relationships)
  eq('T04 the RuleSourceVersion row count is unchanged', afterCounts.sourceVersions, beforeCounts.sourceVersions)
  eq('T53 RuleDefinition.updatedAt is unchanged', ruleAfter.updatedAt.getTime(), ruleBefore.updatedAt.getTime())
  eq('T53 RuleVersion.updatedAt is unchanged', versionAfter.updatedAt.getTime(), versionBefore.updatedAt.getTime())
  eq('T53 RuleSourceVersion.updatedAt is unchanged', sourceVersionAfter.updatedAt.getTime(), sourceVersionBefore.updatedAt.getTime())
  eq(
    'T55 no decision table exists to write to',
    typeof (prisma as unknown as Record<string, unknown>).ruleDecision,
    'undefined',
  )

  // ---- T10/T11 request validation ----------------------------------------------------------
  section('T10/T11 request validation')

  const badDate = await evaluateRuleResolution(ruleOne.id, '15-10-2026', {})
  check('T10 a malformed businessDate is a validation error', !badDate.ok && badDate.code === 'VALIDATION_ERROR')

  const badUuid = await evaluateRuleResolution(ruleOne.id, '2026-10-15', { payerId: 'not-a-uuid' })
  check('T11 a malformed context UUID is a validation error', !badUuid.ok && badUuid.code === 'VALIDATION_ERROR')

  const missingRule = await evaluateRuleResolution('11111111-1111-4111-8111-111111111111', '2026-10-15', {})
  check('T09 a missing RuleDefinition is NOT_FOUND', !missingRule.ok && missingRule.code === 'NOT_FOUND')

  const malformedRule = await evaluateRuleResolution('not-a-uuid', '2026-10-15', {})
  check('T08 a malformed RuleDefinition id never throws', !malformedRule.ok && malformedRule.code === 'VALIDATION_ERROR')

  const stabilityA = await resolve(ruleOne.id, '2026-10-15')
  const stabilityB = await resolve(ruleOne.id, '2026-10-15')
  eq('deterministic: the same input resolves to the same winner', stabilityA.governingBindingId, stabilityB.governingBindingId)

  console.log(`\n[a3.8] ${passed} passed, ${failed} failed`)
  console.log(failed === 0 ? '[a3.8] ALL CHECKS PASS' : '[a3.8] CHECKS FAILED')
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((error) => {
    console.error('[a3.8] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

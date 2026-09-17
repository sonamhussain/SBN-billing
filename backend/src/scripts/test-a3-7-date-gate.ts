import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import { evaluateExecutability } from '../modules/rule-source-binding/rule-source-binding.service.ts'
import { executabilityBlockerCodes } from '../modules/rule-source-binding/rule-source-binding.validation.ts'
import type { ActivationEvaluator } from '../modules/rule-source-binding/rule-source-binding.candidate.ts'
import { evaluateActivationBlockers } from '../modules/rule-source-version/rule-source-version.activation.ts'
import { APPLICABILITY_DIMENSIONS_V2, type ApplicabilityDimensionKeyV2 } from '../shared/rules/applicability-context-v2.ts'

// Reproducible proof for the A3.7 effective-date gate correction. Runs A3.7's real
// executability/evaluate service against real synthetic rows and proves that an otherwise valid
// governing source with a missing or contradictory effective date is BLOCKED with
// SOURCE_NOT_EFFECTIVE, that valid dates still pass, that the raw A3.3 date codes never appear
// in the response, and that a blocked result keeps nextGate = null.

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

function d(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`)
}

const tag = `A37DG-${Date.now()}`
const organizationId = process.env.AUTHZ_BOOTSTRAP_ORGANIZATION_ID
const publicVocabulary = new Set<string>(executabilityBlockerCodes)

function emptyContext(): Record<ApplicabilityDimensionKeyV2, unknown> {
  const context = {} as Record<ApplicabilityDimensionKeyV2, unknown>
  for (const key of APPLICABILITY_DIMENSIONS_V2) context[key] = null
  return context
}

async function main() {
  if (!organizationId) throw new Error('AUTHZ_BOOTSTRAP_ORGANIZATION_ID is required')
  const org = organizationId
  console.log(`[a3.7-date-gate] run tag ${tag} — organization ${org}`)

  async function makeVerifiedRuleVersion(name: string) {
    const rule = await prisma.ruleDefinition.create({
      data: {
        organizationId: org,
        ruleKey: `${tag}-${name}`,
        displayName: `A3.7 date gate ${name}`,
        jurisdictionCode: 'AE-DU',
        ownershipScope: 'ORGANIZATION',
      },
    })
    const version = await prisma.ruleVersion.create({
      data: {
        ruleId: rule.id,
        version: '1',
        effectType: 'AUTHORIZATION_REQUIREMENT_EFFECT',
        effectiveFrom: d('2020-01-01'),
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
      },
    })
    await prisma.ruleApplicability.create({ data: { ruleVersionId: version.id } })
    return version
  }

  // An otherwise fully valid governing source: PUBLISHED, VERIFIED, ACTIVE, verified
  // interpretation, same jurisdiction and organization, compatible category, no scope needed.
  async function bindGoverningSource(
    ruleVersionId: string,
    name: string,
    effectiveFrom: Date | null,
    effectiveTo: Date | null,
    activationStatus = 'ACTIVE',
  ) {
    const source = await prisma.ruleSource.create({
      data: {
        organizationId: org,
        jurisdictionCode: 'AE-DU',
        issuingAuthority: 'Synthetic Authority',
        sourceCategory: 'REGULATORY_AUTHORITY',
        referenceNumber: `${tag}-${name}`,
        title: `A3.7 date gate ${name}`,
        ownershipScope: 'ORGANIZATION',
      },
    })
    const sourceVersion = await prisma.ruleSourceVersion.create({
      data: {
        sourceId: source.id,
        version: '1',
        rawEvidenceRef: `synthetic-evidence://a3-7-date-gate/${tag}/${name}`,
        publicationStatus: 'PUBLISHED',
        publicationDate: d('2020-01-01'),
        effectiveFrom,
        effectiveTo,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
        activationStatus,
        activatedAt: new Date(),
        // Audit F09: ACTIVE and SUPERSEDED rows carry the durable ever-activated fact.
        everActivated: activationStatus !== 'INACTIVE',
        firstActivatedAt: activationStatus !== 'INACTIVE' ? new Date() : null,
        supersededAt: activationStatus === 'SUPERSEDED' ? new Date() : null,
      },
    })
    const interpretation = await prisma.sourceInterpretation.create({
      data: {
        sourceVersionId: sourceVersion.id,
        interpretationVersion: '1',
        normalizedInterpretationRef: `synthetic-interpretation://a3-7-date-gate/${tag}/${name}`,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
      },
    })
    await prisma.ruleSourceBinding.create({
      data: { ruleVersionId, sourceInterpretationId: interpretation.id, sourceRole: 'GOVERNING' },
    })
    return interpretation
  }

  async function evaluate(ruleVersionId: string, activationEvaluator?: ActivationEvaluator) {
    const result = await evaluateExecutability(ruleVersionId, '2026-10-15', emptyContext(), { activationEvaluator })
    if (!result.ok) throw new Error(`evaluate returned ${result.code}: ${result.message}`)
    return result.value
  }

  function assertBlockedOnDate(label: string, value: Awaited<ReturnType<typeof evaluate>>) {
    check(`${label}: gateStatus is BLOCKED`, value.gateStatus === 'BLOCKED', `(got ${value.gateStatus})`)
    check(`${label}: blockers include SOURCE_NOT_EFFECTIVE`, value.blockers.includes('SOURCE_NOT_EFFECTIVE'), `(got ${value.blockers.join(',')})`)
    check(`${label}: blockers include MISSING_GOVERNING_SOURCE`, value.blockers.includes('MISSING_GOVERNING_SOURCE'))
    check(
      `${label}: raw EFFECTIVE_DATE_INCOMPLETE / CONTRADICTORY_DATES are absent`,
      !value.blockers.includes('EFFECTIVE_DATE_INCOMPLETE') && !value.blockers.includes('CONTRADICTORY_DATES'),
    )
    check(
      `${label}: every blocker is in A3.7's public vocabulary`,
      value.blockers.every((code) => publicVocabulary.has(code)),
      `(got ${value.blockers.join(',')})`,
    )
    check(`${label}: no candidate is admitted`, value.candidateSourceInterpretationIds.length === 0)
    check(`${label}: nextGate is null`, value.nextGate === null, `(got ${String(value.nextGate)})`)
  }

  const auditBefore = await prisma.auditEvent.count()

  console.log('\n[a3.7-date-gate] 1. otherwise-valid governing source with missing effectiveFrom')
  const missing = await makeVerifiedRuleVersion('missing-effective-from')
  await bindGoverningSource(missing.id, 'missing-effective-from', null, null)
  assertBlockedOnDate('missing effectiveFrom', await evaluate(missing.id))

  // A3.3's migration already enforces rule_source_versions_effective_period_chk
  // (effective_from <= effective_to when both are set), so contradictory dates can never be
  // persisted and therefore never reach the gate through stored data. The gate-level mapping
  // CONTRADICTORY_DATES -> SOURCE_NOT_EFFECTIVE is defence in depth and is proven by the unit
  // suite (rule-source-binding.validation.test.ts). Here we prove the database layer refuses it.
  // Missing effectiveFrom, by contrast, IS allowed by that constraint — which is why case 1 was the
  // real hole.
  console.log('\n[a3.7-date-gate] 2. contradictory effective dates are refused before they can reach the gate')
  const contradictory = await makeVerifiedRuleVersion('contradictory-dates')
  let refusedByDatabase = false
  try {
    await bindGoverningSource(contradictory.id, 'contradictory-dates', d('2026-09-01'), d('2026-02-01'))
  } catch (error) {
    refusedByDatabase = String(error).includes('rule_source_versions_effective_period_chk')
  }
  check('contradictory dates: rejected by rule_source_versions_effective_period_chk', refusedByDatabase)
  const contradictoryResult = await evaluate(contradictory.id)
  check(
    'contradictory dates: the rule has no governing candidate and stays BLOCKED with nextGate null',
    contradictoryResult.gateStatus === 'BLOCKED' &&
      contradictoryResult.nextGate === null &&
      contradictoryResult.candidateSourceInterpretationIds.length === 0,
  )

  console.log('\n[a3.7-date-gate] 3. governing source with valid effective dates')
  const valid = await makeVerifiedRuleVersion('valid-dates')
  const validInterpretation = await bindGoverningSource(valid.id, 'valid-dates', d('2026-01-01'), d('2026-12-31'))
  const validResult = await evaluate(valid.id)
  check('valid dates: gateStatus is POTENTIALLY_ALLOWED', validResult.gateStatus === 'POTENTIALLY_ALLOWED', `(got ${validResult.gateStatus})`)
  check('valid dates: no blockers', validResult.blockers.length === 0, `(got ${validResult.blockers.join(',')})`)
  check(
    'valid dates: the governing interpretation is the candidate',
    validResult.candidateSourceInterpretationIds.length === 1 &&
      validResult.candidateSourceInterpretationIds[0] === validInterpretation.id,
  )
  check('valid dates: nextGate is A3.8_PRECEDENCE', validResult.nextGate === 'A3.8_PRECEDENCE', `(got ${String(validResult.nextGate)})`)

  console.log('\n[a3.7-date-gate] 4. one undated and one valid governing source on the same rule')
  const mixed = await makeVerifiedRuleVersion('mixed')
  await bindGoverningSource(mixed.id, 'mixed-undated', null, null)
  const mixedValid = await bindGoverningSource(mixed.id, 'mixed-valid', d('2026-01-01'), null)
  const mixedResult = await evaluate(mixed.id)
  check('mixed: gateStatus is POTENTIALLY_ALLOWED through the valid source', mixedResult.gateStatus === 'POTENTIALLY_ALLOWED')
  check(
    'mixed: only the dated source is a candidate — the undated one is excluded',
    mixedResult.candidateSourceInterpretationIds.length === 1 &&
      mixedResult.candidateSourceInterpretationIds[0] === mixedValid.id,
  )
  check('mixed: both governing bindings are still listed', mixedResult.governingBindingIds.length === 2)

  // F01 / C02: an upstream blocker A3.7 has never seen, injected into the REAL candidate path
  // through the internal seam (not reachable from HTTP). The fixture itself is fully valid, so
  // anything but a pass is caused solely by the injected reason.
  function injectFor(targetSourceVersionId: string | null, injected: unknown[]): ActivationEvaluator {
    return (version, ...rest) => {
      const id = (version as { id?: string }).id
      if (targetSourceVersionId === null || id === targetSourceVersionId) return injected
      return evaluateActivationBlockers(version, ...rest)
    }
  }

  console.log('\n[a3.7-date-gate] 5. unknown upstream blocker injected into the real candidate path (C02)')
  const unknownRule = await makeVerifiedRuleVersion('unknown-upstream')
  await bindGoverningSource(unknownRule.id, 'unknown-upstream', d('2026-01-01'), null)
  const unknownBaseline = await evaluate(unknownRule.id)
  check('C02 baseline: the same fixture passes when nothing is injected', unknownBaseline.gateStatus === 'POTENTIALLY_ALLOWED')
  const unknownResult = await evaluate(unknownRule.id, injectFor(null, ['SOME_FUTURE_A33_BLOCKER']))
  check('C02: gateStatus is BLOCKED', unknownResult.gateStatus === 'BLOCKED', `(got ${unknownResult.gateStatus})`)
  check('C02: conservative SOURCE_NOT_ACTIVE is reported', unknownResult.blockers.includes('SOURCE_NOT_ACTIVE'), `(got ${unknownResult.blockers.join(',')})`)
  check('C02: MISSING_GOVERNING_SOURCE is reported', unknownResult.blockers.includes('MISSING_GOVERNING_SOURCE'))
  check('C02: the unknown reason itself never reaches the response', !unknownResult.blockers.includes('SOME_FUTURE_A33_BLOCKER'))
  check('C02: every blocker is a string in the fifteen-code vocabulary', unknownResult.blockers.every((code) => typeof code === 'string' && publicVocabulary.has(code)))
  check('C02: the bad candidate is not admitted', unknownResult.candidateSourceInterpretationIds.length === 0)
  check('C02: nextGate is null', unknownResult.nextGate === null, `(got ${String(unknownResult.nextGate)})`)

  const prototypeResult = await evaluate(unknownRule.id, injectFor(null, ['constructor', '__proto__', '']))
  check(
    'C03: prototype-like and empty upstream reasons block with string-only public codes',
    prototypeResult.gateStatus === 'BLOCKED' &&
      prototypeResult.nextGate === null &&
      prototypeResult.blockers.every((code) => typeof code === 'string' && publicVocabulary.has(code)),
    `(got ${prototypeResult.gateStatus} / ${JSON.stringify(prototypeResult.blockers)})`,
  )

  console.log('\n[a3.7-date-gate] 6. unknown blocker on one candidate while a valid alternative remains')
  const alternativeRule = await makeVerifiedRuleVersion('unknown-with-alternative')
  const tainted = await bindGoverningSource(alternativeRule.id, 'tainted', d('2026-01-01'), null)
  const clean = await bindGoverningSource(alternativeRule.id, 'clean', d('2026-01-01'), null)
  const alternativeResult = await evaluate(alternativeRule.id, injectFor(tainted.sourceVersionId, ['SOME_FUTURE_A33_BLOCKER']))
  check('alternative: the rule stays POTENTIALLY_ALLOWED through the clean source', alternativeResult.gateStatus === 'POTENTIALLY_ALLOWED')
  check(
    'alternative: only the clean source is a candidate — the tainted one is excluded',
    alternativeResult.candidateSourceInterpretationIds.length === 1 &&
      alternativeResult.candidateSourceInterpretationIds[0] === clean.id,
  )

  console.log('\n[a3.7-date-gate] 7. current admission stays ACTIVE-only (C13)')
  const supersededRule = await makeVerifiedRuleVersion('superseded-current')
  await bindGoverningSource(supersededRule.id, 'superseded-current', d('2026-01-01'), null, 'SUPERSEDED')
  const supersededResult = await evaluate(supersededRule.id)
  check('C13: an otherwise valid SUPERSEDED source is BLOCKED by the current gate', supersededResult.gateStatus === 'BLOCKED')
  check('C13: SOURCE_NOT_ACTIVE is reported', supersededResult.blockers.includes('SOURCE_NOT_ACTIVE'))
  check('C13: nextGate is null', supersededResult.nextGate === null)

  console.log('\n[a3.7-date-gate] 8. evaluation stays non-mutating')
  const auditAfter = await prisma.auditEvent.count()
  check('AuditEvent count unchanged by evaluation', auditAfter === auditBefore, `(before ${auditBefore}, after ${auditAfter})`)

  console.log(`\n[a3.7-date-gate] ${passed} passed, ${failed} failed`)
  console.log(failed === 0 ? '[a3.7-date-gate] ALL CHECKS PASS' : '[a3.7-date-gate] CHECKS FAILED')
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((error) => {
    console.error('[a3.7-date-gate] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

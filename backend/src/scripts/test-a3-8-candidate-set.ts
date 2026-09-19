import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import { evaluateExecutability } from '../modules/rule-source-binding/rule-source-binding.service.ts'
import { APPLICABILITY_DIMENSIONS_V2, type ApplicabilityDimensionKeyV2 } from '../shared/rules/applicability-context-v2.ts'
import { a38Fixtures, createChecker, d, resolve } from './support/a3-8-fixtures.ts'

// Audit F03 — the resolver's governing candidate set must be COMPLETE for the requested
// businessDate: every eligible ACTIVE and SUPERSEDED candidate, before dominance and conflict
// resolution. Stored current status must never act as an accidental winner preference, and
// historical reuse must never relax any other check. A3.7's own admission stays ACTIVE-only.

const { check, eq, section, finish } = createChecker('a3.8-candidates')

const tag = `A38C-${Date.now()}`
const organizationId = process.env.AUTHZ_BOOTSTRAP_ORGANIZATION_ID

function emptyContext(): Record<ApplicabilityDimensionKeyV2, unknown> {
  const context = {} as Record<ApplicabilityDimensionKeyV2, unknown>
  for (const key of APPLICABILITY_DIMENSIONS_V2) context[key] = null
  return context
}

async function main() {
  if (!organizationId) throw new Error('AUTHZ_BOOTSTRAP_ORGANIZATION_ID is required')
  const org = organizationId
  console.log(`[a3.8-candidates] run tag ${tag} — organization ${org}`)
  const fx = a38Fixtures(org, tag)

  // REF-02's counterexample, built twice with the binding order reversed so candidate order can
  // be proven irrelevant: A (now SUPERSEDED by A2, whose effectiveFrom is June) and an unrelated
  // B that is still ACTIVE are both valid governing evidence for a March businessDate.
  async function counterexample(name: string, order: 'A-first' | 'B-first') {
    const rule = await fx.makeRule(name)
    const version = await fx.makeRuleVersion(rule.id, '1')
    await fx.makeApplicability(version.id)
    const attachA = () => fx.attachSource(version.id, `${name}-A`, { effectiveFrom: d('2026-01-01'), activationStatus: 'SUPERSEDED' })
    const attachB = () => fx.attachSource(version.id, `${name}-B`, { effectiveFrom: d('2026-01-01') })
    const first = order === 'A-first' ? await attachA() : await attachB()
    const second = order === 'A-first' ? await attachB() : await attachA()
    const a = order === 'A-first' ? first : second
    const b = order === 'A-first' ? second : first
    const a2 = await fx.attachSource(version.id, `${name}-A2`, { effectiveFrom: d('2026-06-01') })
    await fx.relate(a2.sourceVersion.id, a.sourceVersion.id, 'SUPERSEDES')
    return { rule, version, a, b, a2 }
  }

  section('F03 counterexample: a valid SUPERSEDED candidate is no longer shut out by an ACTIVE one')
  const aFirst = await counterexample('mixed-a-first', 'A-first')
  const bFirst = await counterexample('mixed-b-first', 'B-first')
  {
    const march = await resolve(aFirst.rule.id, '2026-03-15')
    check(
      'March: A and B are both valid with no relationship between them, so the answer is a conflict, not B by default',
      march.resolutionStatus === 'BLOCKED_SOURCE_PRECEDENCE_CONFLICT',
      JSON.stringify({ status: march.resolutionStatus, winner: march.governingSourceVersionId, blockers: march.blockers }),
    )
    eq('the blocker names the tie', march.blockers.join(','), 'SOURCE_PRECEDENCE_TIE')
    check('no winner is manufactured', march.governingSourceVersionId === null && march.governingBindingId === null)

    const marchReversed = await resolve(bFirst.rule.id, '2026-03-15')
    check(
      'candidate order permutation: B bound first gives the identical outcome',
      marchReversed.resolutionStatus === march.resolutionStatus && marchReversed.blockers.join(',') === march.blockers.join(','),
      JSON.stringify({ status: marchReversed.resolutionStatus, blockers: marchReversed.blockers }),
    )
  }

  section('A3.7 current admission stays ACTIVE-only')
  {
    const gate = await evaluateExecutability(aFirst.version.id, '2026-03-15', emptyContext())
    if (!gate.ok) throw new Error(`gate returned ${gate.code}`)
    check(
      'A3.7 admits only the ACTIVE B for March — the SUPERSEDED A is not a current candidate',
      gate.value.gateStatus === 'POTENTIALLY_ALLOWED' &&
        gate.value.candidateSourceInterpretationIds.length === 1 &&
        gate.value.candidateSourceInterpretationIds[0] === aFirst.b.interpretation.id,
      JSON.stringify(gate.value.candidateSourceInterpretationIds),
    )
  }

  section('An explicit valid successor still prevails through the approved date rule')
  {
    const rule = await fx.makeRule('successor')
    const version = await fx.makeRuleVersion(rule.id, '1')
    await fx.makeApplicability(version.id)
    const predecessor = await fx.attachSource(version.id, 'succ-pred', { effectiveFrom: d('2026-01-01'), activationStatus: 'SUPERSEDED' })
    const successor = await fx.attachSource(version.id, 'succ-new', { effectiveFrom: d('2026-06-01') })
    await fx.relate(successor.sourceVersion.id, predecessor.sourceVersion.id, 'SUPERSEDES')

    const march = await resolve(rule.id, '2026-03-15')
    check(
      'before the successor takes effect, the predecessor is the answer',
      march.resolutionStatus === 'RESOLVED' && march.governingSourceVersionId === predecessor.sourceVersion.id,
      JSON.stringify({ status: march.resolutionStatus, winner: march.governingSourceVersionId }),
    )
    const august = await resolve(rule.id, '2026-08-15')
    check(
      'on/after the successor effectiveFrom, the successor prevails although both are now candidates',
      august.resolutionStatus === 'RESOLVED' && august.governingSourceVersionId === successor.sourceVersion.id,
      JSON.stringify({ status: august.resolutionStatus, winner: august.governingSourceVersionId }),
    )
    const boundary = await resolve(rule.id, '2026-06-01')
    eq('the successor effectiveFrom day itself belongs to the successor', boundary.governingSourceVersionId, successor.sourceVersion.id)

    // The same structure bound in the opposite order.
    const ruleR = await fx.makeRule('successor-reversed')
    const versionR = await fx.makeRuleVersion(ruleR.id, '1')
    await fx.makeApplicability(versionR.id)
    const successorR = await fx.attachSource(versionR.id, 'succ-new-r', { effectiveFrom: d('2026-06-01') })
    const predecessorR = await fx.attachSource(versionR.id, 'succ-pred-r', { effectiveFrom: d('2026-01-01'), activationStatus: 'SUPERSEDED' })
    await fx.relate(successorR.sourceVersion.id, predecessorR.sourceVersion.id, 'SUPERSEDES')
    const marchR = await resolve(ruleR.id, '2026-03-15')
    const augustR = await resolve(ruleR.id, '2026-08-15')
    check(
      'candidate order permutation: successor bound first resolves the same versions on both dates',
      marchR.governingSourceVersionId === predecessorR.sourceVersion.id && augustR.governingSourceVersionId === successorR.sourceVersion.id,
      JSON.stringify({ march: marchR.governingSourceVersionId, august: augustR.governingSourceVersionId }),
    )
  }

  section('Multiple interpretations of one source version')
  {
    const rule = await fx.makeRule('two-interpretations')
    const version = await fx.makeRuleVersion(rule.id, '1')
    await fx.makeApplicability(version.id)
    const first = await fx.attachSource(version.id, 'interp-1')
    const secondInterpretation = await fx.addInterpretation(first.sourceVersion.id, 'interp-2')
    await fx.bind(version.id, secondInterpretation.id)
    const result = await resolve(rule.id, '2026-03-15')
    check(
      'two governing interpretations of the same version are ambiguous, so the resolver blocks instead of picking one',
      result.resolutionStatus === 'BLOCKED_SOURCE_PRECEDENCE_CONFLICT' && result.blockers.join(',') === 'SOURCE_PRECEDENCE_TIE',
      JSON.stringify({ status: result.resolutionStatus, blockers: result.blockers }),
    )

    // One interpretation SUPERSEDED-era and one ACTIVE-era cannot exist on one version, but one
    // version with one GOVERNING and one SUPPORTING interpretation must still resolve.
    const ruleS = await fx.makeRule('governing-plus-supporting')
    const versionS = await fx.makeRuleVersion(ruleS.id, '1')
    await fx.makeApplicability(versionS.id)
    const governing = await fx.attachSource(versionS.id, 'gov')
    const supportingInterpretation = await fx.addInterpretation(governing.sourceVersion.id, 'sup')
    const supportingBinding = await fx.bind(versionS.id, supportingInterpretation.id, 'SUPPORTING')
    const resolved = await resolve(ruleS.id, '2026-03-15')
    check(
      'a SUPPORTING interpretation of the same version never competes with the GOVERNING one',
      resolved.resolutionStatus === 'RESOLVED' &&
        resolved.governingBindingId === governing.binding.id &&
        resolved.supportingBindingIds.includes(supportingBinding.id),
      JSON.stringify({ status: resolved.resolutionStatus, governing: resolved.governingBindingId, supporting: resolved.supportingBindingIds }),
    )
  }

  section('Historical reuse never relaxes any other check')
  {
    // Each rule has one ACTIVE candidate plus one SUPERSEDED binding that fails a non-status check.
    // If historical reuse relaxed that check, the SUPERSEDED one would join the set and turn the
    // clean RESOLVED into a tie.
    async function withDisqualifiedSuperseded(
      name: string,
      disqualify: (versionId: string) => Promise<unknown>,
    ) {
      const rule = await fx.makeRule(name)
      const version = await fx.makeRuleVersion(rule.id, '1')
      await fx.makeApplicability(version.id)
      const good = await fx.attachSource(version.id, `${name}-good`)
      await disqualify(version.id)
      return { rule, good }
    }

    const cases: [string, (versionId: string) => Promise<unknown>][] = [
      [
        'a SUPERSEDED version not effective on businessDate',
        (versionId) => fx.attachSource(versionId, 'not-effective', { effectiveFrom: d('2026-01-01'), effectiveTo: d('2026-02-28'), activationStatus: 'SUPERSEDED' }),
      ],
      [
        'a SUPERSEDED version with an unverified interpretation',
        async (versionId) => {
          const bad = await fx.attachSource(versionId, 'unverified', { activationStatus: 'SUPERSEDED' })
          await prisma.sourceInterpretation.update({ where: { id: bad.interpretation.id }, data: { verificationStatus: 'UNVERIFIED', verifiedAt: null } })
        },
      ],
      [
        'a SUPERSEDED version whose category is incompatible with the rule effect',
        (versionId) => fx.attachSource(versionId, 'incompatible', { category: 'CLINICAL_STANDARD', activationStatus: 'SUPERSEDED' }),
      ],
      [
        'a SUPERSEDED version that needs typed scope proof and has none',
        (versionId) => fx.attachSource(versionId, 'no-scope', { category: 'PAYER_POLICY', activationStatus: 'SUPERSEDED' }),
      ],
      [
        'a RETIRED version (HISTORICAL admits SUPERSEDED only)',
        (versionId) => fx.attachSource(versionId, 'retired', { activationStatus: 'RETIRED' }),
      ],
    ]

    for (const [label, disqualify] of cases) {
      const { rule, good } = await withDisqualifiedSuperseded(label.replace(/\W+/g, '-').slice(0, 40), disqualify)
      const result = await resolve(rule.id, '2026-03-15')
      check(
        `${label} stays out of the set — the ACTIVE candidate resolves alone`,
        result.resolutionStatus === 'RESOLVED' && result.governingSourceVersionId === good.sourceVersion.id,
        JSON.stringify({ status: result.resolutionStatus, winner: result.governingSourceVersionId, blockers: result.blockers }),
      )
    }
  }

  section('Candidate validity and precedence follow businessDate only')
  {
    const rule = await fx.makeRule('date-driven')
    const version = await fx.makeRuleVersion(rule.id, '1')
    await fx.makeApplicability(version.id)
    const old = await fx.attachSource(version.id, 'dd-old', { effectiveFrom: d('2025-01-01'), activationStatus: 'SUPERSEDED' })
    const current = await fx.attachSource(version.id, 'dd-new', { effectiveFrom: d('2026-01-01') })
    await fx.relate(current.sourceVersion.id, old.sourceVersion.id, 'SUPERSEDES')
    const y2025 = await resolve(rule.id, '2025-06-15')
    const y2026 = await resolve(rule.id, '2026-06-15')
    check(
      'the same stored state answers each date by that date alone',
      y2025.governingSourceVersionId === old.sourceVersion.id && y2026.governingSourceVersionId === current.sourceVersion.id,
      JSON.stringify({ y2025: y2025.governingSourceVersionId, y2026: y2026.governingSourceVersionId }),
    )
  }

  finish()
}

main()
  .catch((error) => {
    console.error('[a3.8-candidates] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

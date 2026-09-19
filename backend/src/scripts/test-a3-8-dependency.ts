import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import { a38Fixtures, createChecker, d, resolve } from './support/a3-8-fixtures.ts'

// Audit C35, A3.8 half — the auditor's confirmed decision: DEPENDS_ON stays a LIFECYCLE
// dependency. A3.8's historical resolution must not infer that a now-SUPERSEDED / SUSPENDED /
// otherwise non-ACTIVE dependency was satisfied in the past from effective dates alone - there
// is no lifecycle-interval history to prove it - so it fails closed. And a DEPENDS_ON edge never
// becomes precedence or ranking. Tests only: the code already conforms.

const { check, eq, section, finish } = createChecker('a3.8-dependency')

const tag = `A38D-${Date.now()}`
const organizationId = process.env.AUTHZ_BOOTSTRAP_ORGANIZATION_ID

async function main() {
  if (!organizationId) throw new Error('AUTHZ_BOOTSTRAP_ORGANIZATION_ID is required')
  const org = organizationId
  console.log(`[a3.8-dependency] run tag ${tag} — organization ${org}`)
  const fx = a38Fixtures(org, tag)

  // A rule whose one governing candidate DEPENDS_ON a target in the given lifecycle state. The
  // target was genuinely in force on the historical businessDate, so only its CURRENT lifecycle
  // status can decide the dependency.
  async function dependentRule(name: string, target: { status: string; from?: string; to?: string | null }, dependent: { status?: string; from?: string } = {}) {
    const rule = await fx.makeRule(name)
    const version = await fx.makeRuleVersion(rule.id, '1')
    await fx.makeApplicability(version.id)
    const candidate = await fx.attachSource(version.id, `${name}-dependent`, {
      effectiveFrom: d(dependent.from ?? '2026-01-01'),
      activationStatus: dependent.status ?? 'ACTIVE',
    })
    // The dependency target is NOT bound to the rule: it is only something the candidate needs.
    const other = await fx.makeRuleVersion((await fx.makeRule(`${name}-target-home`)).id, '1')
    const targetAttached = await fx.attachSource(other.id, `${name}-target`, {
      effectiveFrom: d(target.from ?? '2026-01-01'),
      effectiveTo: target.to ? d(target.to) : null,
      activationStatus: target.status,
    })
    await fx.relate(candidate.sourceVersion.id, targetAttached.sourceVersion.id, 'DEPENDS_ON')
    return { rule, candidate, target: targetAttached }
  }

  section('A historical dependency is never inferred from dates alone')
  {
    // The target was in force from January to June and has since been SUPERSEDED. For a March
    // businessDate its dates cover the day - but no lifecycle history proves it was ACTIVE then.
    const r = await dependentRule('superseded-target', { status: 'SUPERSEDED', from: '2026-01-01', to: '2026-06-30' })
    const march = await resolve(r.rule.id, '2026-03-15')
    check(
      'a now-SUPERSEDED dependency is NOT treated as satisfied for a date its period covered',
      march.resolutionStatus === 'BLOCKED_EXECUTABILITY' && march.governingSourceVersionId === null,
      JSON.stringify({ status: march.resolutionStatus, winner: march.governingSourceVersionId, blockers: march.blockers }),
    )
    check('the reason is the unresolved dependency, in the public vocabulary', march.blockers.includes('DEPENDENCY_UNRESOLVED'), march.blockers.join(','))
  }
  {
    const r = await dependentRule('suspended-target', { status: 'SUSPENDED', from: '2026-01-01' })
    const march = await resolve(r.rule.id, '2026-03-15')
    check(
      'a SUSPENDED dependency blocks too',
      march.resolutionStatus === 'BLOCKED_EXECUTABILITY' && march.blockers.includes('DEPENDENCY_UNRESOLVED'),
      JSON.stringify({ status: march.resolutionStatus, blockers: march.blockers }),
    )
  }
  {
    const r = await dependentRule('retired-target', { status: 'RETIRED', from: '2026-01-01' })
    const march = await resolve(r.rule.id, '2026-03-15')
    check('a RETIRED dependency blocks too', march.resolutionStatus === 'BLOCKED_EXECUTABILITY' && march.blockers.includes('DEPENDENCY_UNRESOLVED'))
  }
  {
    // The historical path relaxes only the CANDIDATE's own status. A SUPERSEDED candidate that
    // would answer historically for March still needs a satisfied dependency.
    const r = await dependentRule(
      'superseded-candidate-superseded-target',
      { status: 'SUPERSEDED', from: '2026-01-01', to: '2026-06-30' },
      { status: 'SUPERSEDED', from: '2026-01-01' },
    )
    const march = await resolve(r.rule.id, '2026-03-15')
    check(
      'a SUPERSEDED candidate on the historical path is still blocked by its SUPERSEDED dependency',
      march.resolutionStatus === 'BLOCKED_EXECUTABILITY' && march.governingSourceVersionId === null,
      JSON.stringify({ status: march.resolutionStatus, blockers: march.blockers }),
    )
  }

  section('A satisfied (ACTIVE) dependency lets the candidate answer, historically too')
  {
    const r = await dependentRule('active-target', { status: 'ACTIVE', from: '2026-01-01' })
    const march = await resolve(r.rule.id, '2026-03-15')
    check(
      'an ACTIVE dependency is resolved and the candidate wins',
      march.resolutionStatus === 'RESOLVED' && march.governingSourceVersionId === r.candidate.sourceVersion.id,
      JSON.stringify({ status: march.resolutionStatus, blockers: march.blockers }),
    )
  }
  {
    // Lifecycle, not in-force: a still-ACTIVE target whose own period ended resolves the dependency.
    const r = await dependentRule('active-expired-target', { status: 'ACTIVE', from: '2025-01-01', to: '2025-12-31' })
    const march = await resolve(r.rule.id, '2026-03-15')
    check(
      'an ACTIVE but date-expired dependency is still resolved (lifecycle semantics)',
      march.resolutionStatus === 'RESOLVED' && march.governingSourceVersionId === r.candidate.sourceVersion.id,
      JSON.stringify({ status: march.resolutionStatus, blockers: march.blockers }),
    )
  }
  {
    const r = await dependentRule('superseded-candidate-active-target', { status: 'ACTIVE', from: '2026-01-01' }, { status: 'SUPERSEDED', from: '2026-01-01' })
    const march = await resolve(r.rule.id, '2026-03-15')
    check(
      'a SUPERSEDED candidate with an ACTIVE dependency answers historically, flagged historicalOnly',
      march.resolutionStatus === 'RESOLVED' && march.governingSourceVersionId === r.candidate.sourceVersion.id && march.historicalOnly === true,
      JSON.stringify({ status: march.resolutionStatus, historicalOnly: march.historicalOnly }),
    )
  }

  section('DEPENDS_ON never becomes precedence or ranking')
  {
    // Two valid unrelated-by-SUPERSEDES candidates, one depending on the other. If DEPENDS_ON
    // leaked into precedence, one of them would win; the only correct answer is a tie.
    for (const direction of ['X depends on Z', 'Z depends on X'] as const) {
      const rule = await fx.makeRule(`rank-${direction.replace(/\W+/g, '-')}`)
      const version = await fx.makeRuleVersion(rule.id, '1')
      await fx.makeApplicability(version.id)
      // Z takes effect later, exactly as a successor would - DEPENDS_ON must still not dominate.
      const x = await fx.attachSource(version.id, 'rank-X', { effectiveFrom: d('2026-01-01') })
      const z = await fx.attachSource(version.id, 'rank-Z', { effectiveFrom: d('2026-02-01') })
      if (direction === 'X depends on Z') await fx.relate(x.sourceVersion.id, z.sourceVersion.id, 'DEPENDS_ON')
      else await fx.relate(z.sourceVersion.id, x.sourceVersion.id, 'DEPENDS_ON')
      const result = await resolve(rule.id, '2026-03-15')
      check(
        `${direction}: both remain candidates and the answer is a tie, not a winner`,
        result.resolutionStatus === 'BLOCKED_SOURCE_PRECEDENCE_CONFLICT' && result.governingSourceVersionId === null,
        JSON.stringify({ status: result.resolutionStatus, winner: result.governingSourceVersionId, blockers: result.blockers }),
      )
      eq(`${direction}: the blocker is the precedence tie`, result.blockers.join(','), 'SOURCE_PRECEDENCE_TIE')
    }
  }
  {
    // The target is not bound to the rule. The resolver's graph walk follows SUPERSEDES only, so
    // the DEPENDS_ON target can never be drawn in as a candidate, a dominator or a winner.
    const r = await dependentRule('unbound-target', { status: 'ACTIVE', from: '2026-01-01' })
    const march = await resolve(r.rule.id, '2026-03-15')
    check(
      'an unbound DEPENDS_ON target is never the winner — the bound candidate is',
      march.governingSourceVersionId === r.candidate.sourceVersion.id && march.governingSourceVersionId !== r.target.sourceVersion.id,
      JSON.stringify({ winner: march.governingSourceVersionId, target: r.target.sourceVersion.id }),
    )
    check('and it is not reported as a supporting binding either', march.supportingBindingIds.length === 0)
  }

  section('Resolution is read-only')
  {
    const auditBefore = await prisma.auditEvent.count()
    const r = await dependentRule('trace', { status: 'SUPERSEDED', from: '2026-01-01', to: '2026-06-30' })
    const afterFixtures = await prisma.auditEvent.count()
    await resolve(r.rule.id, '2026-03-15')
    check('no AuditEvent is written and no dependency state changes', (await prisma.auditEvent.count()) === afterFixtures && afterFixtures === auditBefore)
    const target = await prisma.ruleSourceVersion.findUniqueOrThrow({ where: { id: r.target.sourceVersion.id } })
    check('the SUPERSEDED target is left exactly as it was', target.activationStatus === 'SUPERSEDED')
  }

  finish()
}

main()
  .catch((error) => {
    console.error('[a3.8-dependency] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

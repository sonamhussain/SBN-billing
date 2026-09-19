import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import { executabilityBlockerCodes } from '../modules/rule-source-binding/rule-source-binding.validation.ts'
import { resolutionBlockerCodes } from '../modules/rule-resolution/rule-resolution.types.ts'
import type { RuleResolutionDto } from '../modules/rule-resolution/rule-resolution.types.ts'
import { a38Fixtures, createChecker, d, resolve } from './support/a3-8-fixtures.ts'

// The last A3.8 precedence edge case from the hard-audit ledger. A successor S2 that SUPERSEDES
// candidate S1 and is already in force on businessDate:
//   - usable (a valid governing candidate for this rule)  -> ordinary dominance, S2 answers;
//   - unusable (unverified, not bound here, out of scope) -> S1 must not win, and no unrelated
//     candidate may win merely because S1 dropped out: BLOCKED_SOURCE_PRECEDENCE_CONFLICT with the
//     A3.8-local SUPERSEDES_SUCCESSOR_UNUSABLE, no winner.
// A successor not yet in force leaves S1 as the historical answer; missing successor dates keep
// their existing fail-closed blocker; binding order never changes the result.

const { check, eq, section, finish } = createChecker('a3.8-successor')

const tag = `A38U-${Date.now()}`
const organizationId = process.env.AUTHZ_BOOTSTRAP_ORGANIZATION_ID
const inForce = '2026-08-15' // S2 takes effect on 2026-06-01
const beforeSuccessor = '2026-03-15'

function outcome(dto: RuleResolutionDto): string {
  return JSON.stringify({ status: dto.resolutionStatus, winner: dto.governingSourceVersionId, blockers: dto.blockers })
}

async function main() {
  if (!organizationId) throw new Error('AUTHZ_BOOTSTRAP_ORGANIZATION_ID is required')
  const org = organizationId
  console.log(`[a3.8-successor] run tag ${tag} — organization ${org}`)
  const fx = a38Fixtures(org, tag)

  type Flavour = 'unverified' | 'unbound' | 'out-of-scope' | 'usable' | 'no-date'
  type Piece = 'S1' | 'S2' | 'B'

  // Builds one rule. `order` is the binding creation order (the query order), so permutations of
  // it prove candidate order is irrelevant. S1 is SUPERSEDED by S2; B, when present, is an
  // unrelated ACTIVE candidate.
  // `s2To` gives S2 a finite end date (default open-ended), for the expired-successor boundary.
  async function scenario(name: string, flavour: Flavour, withB: boolean, order: Piece[], s2To: string | null = null) {
    const rule = await fx.makeRule(name)
    const version = await fx.makeRuleVersion(rule.id, '1')
    await fx.makeApplicability(version.id)
    const elsewhere = await fx.makeRuleVersion((await fx.makeRule(`${name}-elsewhere`)).id, '1')

    const made: Partial<Record<Piece, Awaited<ReturnType<typeof fx.attachSource>>>> = {}
    for (const piece of order) {
      if (piece === 'S1') {
        made.S1 = await fx.attachSource(version.id, `${name}-S1`, { effectiveFrom: d('2026-01-01'), activationStatus: 'SUPERSEDED' })
      } else if (piece === 'B') {
        if (withB) made.B = await fx.attachSource(version.id, `${name}-B`, { effectiveFrom: d('2026-01-01') })
      } else {
        // An unbound successor is attached to a different rule, so it exists but is not governing
        // evidence here. The others are bound to this rule.
        const target = flavour === 'unbound' ? elsewhere.id : version.id
        made.S2 = await fx.attachSource(target, `${name}-S2`, {
          effectiveFrom: flavour === 'no-date' ? null : d('2026-06-01'),
          effectiveTo: s2To ? d(s2To) : null,
          category: flavour === 'out-of-scope' ? 'PAYER_POLICY' : undefined,
        })
        if (flavour === 'unverified') {
          await prisma.sourceInterpretation.update({
            where: { id: made.S2.interpretation.id },
            data: { verificationStatus: 'UNVERIFIED', verifiedAt: null },
          })
        }
      }
    }
    const { S1, S2, B } = made as Record<Piece, Awaited<ReturnType<typeof fx.attachSource>>>
    await fx.relate(S2.sourceVersion.id, S1.sourceVersion.id, 'SUPERSEDES')
    return { rule, S1, S2, B }
  }

  const expectBlockedUnusable = (label: string, dto: RuleResolutionDto) => {
    check(
      `${label}: BLOCKED_SOURCE_PRECEDENCE_CONFLICT with SUPERSEDES_SUCCESSOR_UNUSABLE`,
      dto.resolutionStatus === 'BLOCKED_SOURCE_PRECEDENCE_CONFLICT' && dto.blockers.join(',') === 'SUPERSEDES_SUCCESSOR_UNUSABLE',
      outcome(dto),
    )
    check(`${label}: no winner`, dto.governingSourceVersionId === null && dto.governingBindingId === null && dto.governingSourceId === null)
  }

  section('S1 + an unusable S2 already in force -> blocked, no winner')
  for (const flavour of ['unverified', 'unbound', 'out-of-scope'] as const) {
    const s = await scenario(`alone-${flavour}`, flavour, false, ['S1', 'S2'])
    expectBlockedUnusable(`${flavour} S2`, await resolve(s.rule.id, inForce))
  }

  section('S1 + an unusable S2 + an unrelated candidate B -> blocked; B must not win')
  for (const flavour of ['unverified', 'unbound', 'out-of-scope'] as const) {
    const s = await scenario(`with-b-${flavour}`, flavour, true, ['S1', 'B', 'S2'])
    const dto = await resolve(s.rule.id, inForce)
    expectBlockedUnusable(`${flavour} S2 with B`, dto)
    check(`${flavour} S2 with B: B is not the winner`, dto.governingSourceVersionId !== s.B.sourceVersion.id)
  }

  section('S1 + a usable S2 already in force -> S2 wins normally')
  {
    const s = await scenario('usable', 'usable', false, ['S1', 'S2'])
    const dto = await resolve(s.rule.id, inForce)
    check('the usable successor is the winner', dto.resolutionStatus === 'RESOLVED' && dto.governingSourceVersionId === s.S2.sourceVersion.id, outcome(dto))
    check('and it is current, so not historicalOnly', dto.historicalOnly === false)
  }

  section('S2 effectiveFrom after businessDate -> S1 may still resolve historically')
  for (const flavour of ['unverified', 'unbound', 'usable'] as const) {
    const s = await scenario(`before-${flavour}`, flavour, false, ['S1', 'S2'])
    const dto = await resolve(s.rule.id, beforeSuccessor)
    check(
      `${flavour} S2 not yet in force: S1 resolves, flagged historicalOnly`,
      dto.resolutionStatus === 'RESOLVED' && dto.governingSourceVersionId === s.S1.sourceVersion.id && dto.historicalOnly === true,
      outcome(dto),
    )
  }

  section('Missing successor dates keep the existing fail-closed blocker')
  {
    const alone = await scenario('no-date', 'no-date', false, ['S1', 'S2'])
    const dto = await resolve(alone.rule.id, inForce)
    check(
      'S2 with no effectiveFrom: SUPERSEDES_EFFECTIVE_DATE_INCOMPLETE, no winner',
      dto.resolutionStatus === 'BLOCKED_SOURCE_PRECEDENCE_CONFLICT' &&
        dto.blockers.join(',') === 'SUPERSEDES_EFFECTIVE_DATE_INCOMPLETE' &&
        dto.governingSourceVersionId === null,
      outcome(dto),
    )
    const withB = await scenario('no-date-b', 'no-date', true, ['B', 'S1', 'S2'])
    const dtoB = await resolve(withB.rule.id, inForce)
    check(
      'the same with an unrelated B: still the date blocker, and B does not win',
      dtoB.blockers.join(',') === 'SUPERSEDES_EFFECTIVE_DATE_INCOMPLETE' && dtoB.governingSourceVersionId === null,
      outcome(dtoB),
    )
    // A contradictory period cannot be stored at all (rule_source_versions_effective_period_chk),
    // so SUPERSEDES_CONTRADICTORY_DATES is proven in the pure unit tests.
  }

  section('Expired successor: S2 in force 2026-06-01..2026-07-31 no longer counts after its end')
  {
    // The auditor's exact case: businessDate 2026-08-15, after S2 ended on 2026-07-31.
    for (const flavour of ['unverified', 'unbound', 'out-of-scope'] as const) {
      const s = await scenario(`expired-${flavour}`, flavour, false, ['S1', 'S2'], '2026-07-31')
      const dto = await resolve(s.rule.id, inForce)
      check(
        `${flavour} S2 expired on 2026-07-31: on 2026-08-15 S1 resolves (historically), not blocked`,
        dto.resolutionStatus === 'RESOLVED' && dto.governingSourceVersionId === s.S1.sourceVersion.id && dto.historicalOnly === true,
        outcome(dto),
      )
    }
    {
      const s = await scenario('expired-with-b', 'unverified', true, ['S1', 'B', 'S2'], '2026-07-31')
      const dto = await resolve(s.rule.id, inForce)
      check(
        'expired unusable S2 with an unrelated B: S1 and B tie, and B does not win',
        dto.resolutionStatus === 'BLOCKED_SOURCE_PRECEDENCE_CONFLICT' &&
          dto.blockers.join(',') === 'SOURCE_PRECEDENCE_TIE' &&
          dto.governingSourceVersionId === null,
        outcome(dto),
      )
    }
    {
      const s = await scenario('expired-last-day', 'unverified', false, ['S1', 'S2'], '2026-07-31')
      const lastDay = await resolve(s.rule.id, '2026-07-31')
      check(
        'on its last day (2026-07-31, inclusive) the unusable S2 still blocks',
        lastDay.resolutionStatus === 'BLOCKED_SOURCE_PRECEDENCE_CONFLICT' && lastDay.blockers.join(',') === 'SUPERSEDES_SUCCESSOR_UNUSABLE',
        outcome(lastDay),
      )
      const dayAfter = await resolve(s.rule.id, '2026-08-01')
      check(
        'from the next day (2026-08-01) S1 resolves again',
        dayAfter.resolutionStatus === 'RESOLVED' && dayAfter.governingSourceVersionId === s.S1.sourceVersion.id,
        outcome(dayAfter),
      )
    }
    {
      // A usable S2 inside its window wins; after its end it is no longer a candidate (not
      // effective), so it neither wins nor blocks, and S1 answers.
      const s = await scenario('expired-usable', 'usable', false, ['S1', 'S2'], '2026-07-31')
      const inside = await resolve(s.rule.id, '2026-07-15')
      check('usable S2 inside its window (2026-07-15) wins', inside.governingSourceVersionId === s.S2.sourceVersion.id, outcome(inside))
      const after = await resolve(s.rule.id, inForce)
      check(
        'usable S2 after its window (2026-08-15): S1 resolves historically',
        after.resolutionStatus === 'RESOLVED' && after.governingSourceVersionId === s.S1.sourceVersion.id,
        outcome(after),
      )
    }
  }

  section('Candidate / input order permutations produce the same result')
  {
    const orders: Piece[][] = [
      ['S1', 'S2', 'B'],
      ['S1', 'B', 'S2'],
      ['S2', 'S1', 'B'],
      ['S2', 'B', 'S1'],
      ['B', 'S1', 'S2'],
      ['B', 'S2', 'S1'],
    ]
    // Each order builds its own rows, so the winner is compared by ROLE (S1 / S2 / B / none), not by
    // UUID — otherwise six identical behaviours would look like six different outcomes.
    const results = new Set<string>()
    for (const [index, order] of orders.entries()) {
      const s = await scenario(`perm-${index}`, 'unverified', true, order)
      const dto = await resolve(s.rule.id, inForce)
      const winner = dto.governingSourceVersionId
      const role =
        winner === null ? 'none'
        : winner === s.S1.sourceVersion.id ? 'S1'
        : winner === s.S2.sourceVersion.id ? 'S2'
        : winner === s.B.sourceVersion.id ? 'B'
        : 'other'
      results.add(JSON.stringify({ status: dto.resolutionStatus, blockers: dto.blockers, winner: role }))
    }
    eq('all six binding orders give one identical outcome', results.size, 1)
    check('and that outcome is the unusable-successor block', [...results][0].includes('SUPERSEDES_SUCCESSOR_UNUSABLE'), [...results].join(' | '))

    const usableResults = new Set<string>()
    for (const [index, order] of [['S1', 'S2'], ['S2', 'S1']].entries()) {
      const s = await scenario(`perm-usable-${index}`, 'usable', false, order as Piece[])
      const dto = await resolve(s.rule.id, inForce)
      usableResults.add(dto.governingSourceVersionId === s.S2.sourceVersion.id ? 'S2 wins' : outcome(dto))
    }
    check('usable successor: both orders resolve to S2', usableResults.size === 1 && usableResults.has('S2 wins'), [...usableResults].join(' | '))
  }

  section('The new blocker is A3.8-local')
  check('SUPERSEDES_SUCCESSOR_UNUSABLE is in A3.8\'s resolution vocabulary', (resolutionBlockerCodes as readonly string[]).includes('SUPERSEDES_SUCCESSOR_UNUSABLE'))
  check('and NOT in A3.7\'s executability vocabulary', !(executabilityBlockerCodes as readonly string[]).includes('SUPERSEDES_SUCCESSOR_UNUSABLE'))
  eq('A3.7\'s vocabulary is still exactly fifteen codes', executabilityBlockerCodes.length, 15)

  section('Resolution is read-only')
  {
    const s = await scenario('trace', 'unverified', true, ['S1', 'B', 'S2'])
    const auditBefore = await prisma.auditEvent.count()
    await resolve(s.rule.id, inForce)
    check('no AuditEvent is written', (await prisma.auditEvent.count()) === auditBefore)
  }

  finish()
}

main()
  .catch((error) => {
    console.error('[a3.8-successor] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

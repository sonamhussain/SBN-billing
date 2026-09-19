import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bestMatchedSpecificity,
  hasConflictAmong,
  highestSpecificityCandidates,
  precedencePolicyVersion,
  resolveSupersedesDominance,
  rowSpecificity,
  type PrecedenceVersion,
  type SupersedesEdge,
} from './rule-resolution.precedence.ts'
import type { ApplicabilityRow } from '../rule-applicability/rule-applicability.matcher.ts'

const PAYER = '11111111-1111-4111-8111-111111111111'
const PAYER2 = '1111aaaa-1111-4111-8111-111111111111'
const NETWORK = '22222222-2222-4222-8222-222222222222'
const SERVICE = '33333333-3333-4333-8333-333333333333'
const PROCEDURE = '44444444-4444-4444-8444-444444444444'
const DIAGNOSIS = '55555555-5555-4555-8555-555555555555'
const FACILITY = '66666666-6666-4666-8666-666666666666'
const CONTRACT = '77777777-7777-4777-8777-777777777777'
const TPA = '88888888-8888-4888-8888-888888888888'

const S1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const S2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const S3 = 'cccccccc-3333-4333-8333-cccccccccccc'
const SB = 'dddddddd-4444-4444-8444-dddddddddddd'

function row(id: string, overrides: Partial<ApplicabilityRow>): ApplicabilityRow {
  return {
    id,
    facilityId: null,
    facilityRegulatoryProfileId: null,
    payerId: null,
    tpaId: null,
    networkId: null,
    insuranceProductId: null,
    providerContractId: null,
    tariffScheduleId: null,
    tariffScheduleVersionId: null,
    serviceId: null,
    procedureCodeId: null,
    diagnosisCodeId: null,
    ...overrides,
  }
}

function date(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`)
}

function version(sourceVersionId: string, effectiveFrom: string | null, effectiveTo: string | null = null): PrecedenceVersion {
  return {
    sourceVersionId,
    effectiveFrom: effectiveFrom ? date(effectiveFrom) : null,
    effectiveTo: effectiveTo ? date(effectiveTo) : null,
  }
}

function edge(fromSourceVersionId: string, toSourceVersionId: string): SupersedesEdge {
  return { fromSourceVersionId, toSourceVersionId }
}

// --- policy version -----------------------------------------------------------------------

test('T49 precedence policy version is A3-PREC-1', () => {
  assert.equal(precedencePolicyVersion, 'A3-PREC-1')
})

// --- specificity (A3.8 §10) ---------------------------------------------------------------

test('T17 wildcard row scores 0', () => {
  assert.equal(rowSpecificity(row('r0', {})), 0)
})

test('T18 payer-only row scores 1', () => {
  assert.equal(rowSpecificity(row('r1', { payerId: PAYER })), 1)
})

test('T19 payer+service row scores 2', () => {
  assert.equal(rowSpecificity(row('r2', { payerId: PAYER, serviceId: SERVICE })), 2)
})

test('payer+network+procedure row scores 3', () => {
  assert.equal(rowSpecificity(row('r3', { payerId: PAYER, networkId: NETWORK, procedureCodeId: PROCEDURE })), 3)
})

test('all six legacy dimensions score 6', () => {
  const legacy = row('r6', {
    payerId: PAYER,
    tpaId: TPA,
    networkId: NETWORK,
    serviceId: SERVICE,
    procedureCodeId: PROCEDURE,
    diagnosisCodeId: DIAGNOSIS,
  })
  assert.equal(rowSpecificity(legacy), 6)
})

test('REF-01 carry-forward: the six new V2 dimensions also count towards specificity', () => {
  const v2Row = row('rv2', { facilityId: FACILITY, providerContractId: CONTRACT })
  assert.equal(rowSpecificity(v2Row), 2)
})

test('T20 best matched row score is used when several rows match', () => {
  const rows = [row('wild', {}), row('specific', { payerId: PAYER, serviceId: SERVICE })]
  assert.equal(bestMatchedSpecificity(rows, { payerId: PAYER, serviceId: SERVICE }), 2)
})

test('T16 no matching row yields null, never a zero score', () => {
  const rows = [row('specific', { payerId: PAYER })]
  assert.equal(bestMatchedSpecificity(rows, { payerId: PAYER2 }), null)
})

test('zero applicability rows never match', () => {
  assert.equal(bestMatchedSpecificity([], { payerId: PAYER }), null)
})

test('T21 more specific RuleVersion wins over less specific', () => {
  const kept = highestSpecificityCandidates([
    { ruleVersionId: 'v1', specificityScore: 1 },
    { ruleVersionId: 'v2', specificityScore: 2 },
  ])
  assert.deepEqual(kept.map((entry) => entry.ruleVersionId), ['v2'])
})

test('T22 equal specificity keeps every tied candidate so the caller can block', () => {
  const kept = highestSpecificityCandidates([
    { ruleVersionId: 'v1', specificityScore: 2 },
    { ruleVersionId: 'v2', specificityScore: 2 },
  ])
  assert.equal(kept.length, 2)
})

test('T23/T24 tie survival does not depend on order, version text or creation order', () => {
  const forward = highestSpecificityCandidates([
    { ruleVersionId: 'v2', specificityScore: 2 },
    { ruleVersionId: 'v10', specificityScore: 2 },
  ])
  const reversed = highestSpecificityCandidates([
    { ruleVersionId: 'v10', specificityScore: 2 },
    { ruleVersionId: 'v2', specificityScore: 2 },
  ])
  assert.equal(forward.length, 2)
  assert.equal(reversed.length, 2)
})

// --- SUPERSEDES dominance (A3.8 §12) ------------------------------------------------------

test('T29 a single candidate survives untouched', () => {
  const outcome = resolveSupersedesDominance([S1], [version(S1, '2026-01-01')], [], date('2026-10-15'))
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.ok && outcome.survivingSourceVersionIds, [S1])
})

test('T30 two unrelated candidates both survive so the caller blocks', () => {
  const outcome = resolveSupersedesDominance(
    [S1, S2],
    [version(S1, '2026-01-01'), version(S2, '2026-02-01')],
    [],
    date('2026-10-15'),
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok && outcome.survivingSourceVersionIds.length, 2)
})

test('T31 direct SUPERSEDES: the superseder wins', () => {
  const outcome = resolveSupersedesDominance(
    [S1, S2],
    [version(S1, '2026-01-01'), version(S2, '2026-02-01')],
    [edge(S2, S1)],
    date('2026-10-15'),
  )
  assert.deepEqual(outcome.ok && outcome.survivingSourceVersionIds, [S2])
})

test('T32 transitive SUPERSEDES: the top descendant wins', () => {
  const outcome = resolveSupersedesDominance(
    [S1, S2, S3],
    [version(S1, '2026-01-01'), version(S2, '2026-02-01'), version(S3, '2026-03-01')],
    [edge(S3, S2), edge(S2, S1)],
    date('2026-10-15'),
  )
  assert.deepEqual(outcome.ok && outcome.survivingSourceVersionIds, [S3])
})

test('T32 transitive dominance works when the middle version is not itself a candidate', () => {
  const outcome = resolveSupersedesDominance(
    [S1, S3],
    [version(S1, '2026-01-01'), version(S2, '2026-02-01'), version(S3, '2026-03-01')],
    [edge(S3, S2), edge(S2, S1)],
    date('2026-10-15'),
  )
  assert.deepEqual(outcome.ok && outcome.survivingSourceVersionIds, [S3])
})

test('T42 an unusable successor already in force blocks explicitly instead of silently removing its predecessor', () => {
  // S2 is not a usable candidate (it failed the gate), but it had taken effect on the business
  // date, so S1 must not win. The resolution now blocks with a named A3.8 reason rather than
  // returning an empty survivor set for the caller to interpret.
  const outcome = resolveSupersedesDominance(
    [S1],
    [version(S1, '2026-01-01'), version(S2, '2026-02-01')],
    [edge(S2, S1)],
    date('2026-10-15'),
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.blocker, 'SUPERSEDES_SUCCESSOR_UNUSABLE')
})

test('T33/T34/T35 AMENDS, REFERENCES and DEPENDS_ON edges are never supplied, so they cannot rank', () => {
  // Only SUPERSEDES edges are ever fetched. With no SUPERSEDES edge both candidates survive,
  // which is exactly what "does not auto-eliminate the amended source" must produce.
  const outcome = resolveSupersedesDominance(
    [S1, S2],
    [version(S1, '2026-01-01'), version(S2, '2026-02-01')],
    [],
    date('2026-10-15'),
  )
  assert.equal(outcome.ok && outcome.survivingSourceVersionIds.length, 2)
})

// --- historical resolution (A3.8 §13) -----------------------------------------------------

test('T43 before the successor takes effect, the predecessor survives', () => {
  const outcome = resolveSupersedesDominance(
    [S1, S2],
    [version(S1, '2026-01-01', '2026-06-30'), version(S2, '2026-07-01')],
    [edge(S2, S1)],
    date('2026-03-15'),
  )
  assert.deepEqual(outcome.ok && outcome.survivingSourceVersionIds, [S1, S2])
})

test('T43 the predecessor survives even when the successor is not itself a candidate yet', () => {
  const outcome = resolveSupersedesDominance(
    [S1],
    [version(S1, '2026-01-01', '2026-06-30'), version(S2, '2026-07-01')],
    [edge(S2, S1)],
    date('2026-03-15'),
  )
  assert.deepEqual(outcome.ok && outcome.survivingSourceVersionIds, [S1])
})

test('T44 on the successor effectiveFrom date the successor dominates', () => {
  const outcome = resolveSupersedesDominance(
    [S1, S2],
    [version(S1, '2026-01-01', '2026-06-30'), version(S2, '2026-07-01')],
    [edge(S2, S1)],
    date('2026-07-01'),
  )
  assert.deepEqual(outcome.ok && outcome.survivingSourceVersionIds, [S2])
})

test('T44 after the successor effectiveFrom date the successor still dominates', () => {
  const outcome = resolveSupersedesDominance(
    [S1, S2],
    [version(S1, '2026-01-01', '2026-06-30'), version(S2, '2026-07-01')],
    [edge(S2, S1)],
    date('2026-12-31'),
  )
  assert.deepEqual(outcome.ok && outcome.survivingSourceVersionIds, [S2])
})

test('T48 a missing successor effectiveFrom fails closed instead of inferring from supersededAt', () => {
  const outcome = resolveSupersedesDominance(
    [S1, S2],
    [version(S1, '2026-01-01'), version(S2, null)],
    [edge(S2, S1)],
    date('2026-10-15'),
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.blocker, 'SUPERSEDES_EFFECTIVE_DATE_INCOMPLETE')
})

test('T48 a missing effectiveFrom blocks even when the successor is not a candidate', () => {
  const outcome = resolveSupersedesDominance(
    [S1],
    [version(S1, '2026-01-01'), version(S2, null)],
    [edge(S2, S1)],
    date('2026-10-15'),
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.blocker, 'SUPERSEDES_EFFECTIVE_DATE_INCOMPLETE')
})

test('T48 contradictory successor dates fail closed', () => {
  const outcome = resolveSupersedesDominance(
    [S1, S2],
    [version(S1, '2026-01-01'), version(S2, '2026-09-01', '2026-02-01')],
    [edge(S2, S1)],
    date('2026-10-15'),
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.blocker, 'SUPERSEDES_CONTRADICTORY_DATES')
})

// --- forbidden tie-breakers (A3.8 §15) ----------------------------------------------------

test('T37/T38 dominance ignores candidate order entirely — no first-row or newest-row winner', () => {
  const versions = [version(S1, '2026-01-01'), version(S2, '2026-02-01')]
  const forward = resolveSupersedesDominance([S1, S2], versions, [], date('2026-10-15'))
  const reversed = resolveSupersedesDominance([S2, S1], versions, [], date('2026-10-15'))
  assert.equal(forward.ok && forward.survivingSourceVersionIds.length, 2)
  assert.equal(reversed.ok && reversed.survivingSourceVersionIds.length, 2)
})

test('T39/T40 a later effectiveFrom alone never eliminates the other candidate', () => {
  const outcome = resolveSupersedesDominance(
    [S1, S2],
    [version(S1, '2020-01-01'), version(S2, '2026-09-01')],
    [],
    date('2026-10-15'),
  )
  assert.equal(outcome.ok && outcome.survivingSourceVersionIds.length, 2)
})

// --- CONFLICTS_WITH fail-closed (A3.8 §9 step 12) -----------------------------------------

test('T36 a conflict between two surviving candidates is detected', () => {
  assert.equal(hasConflictAmong([S1, S2], [{ fromSourceVersionId: S1, toSourceVersionId: S2 }]), true)
})

test('T36 a conflict touching an already-dominated version does not block the survivor', () => {
  assert.equal(hasConflictAmong([S2], [{ fromSourceVersionId: S1, toSourceVersionId: S3 }]), false)
})

test('a self-referencing conflict edge is ignored', () => {
  assert.equal(hasConflictAmong([S1], [{ fromSourceVersionId: S1, toSourceVersionId: S1 }]), false)
})

// --- successor usability (audit: the last A3.8 precedence edge case) -----------------------

// Every ordering of a list, so each rule below is proven independent of candidate, version and
// edge order rather than of one lucky order.
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  )
}

function everyOrder(candidates: string[], versions: PrecedenceVersion[], edges: SupersedesEdge[], businessDate: Date) {
  const outcomes = new Set<string>()
  for (const c of permutations(candidates))
    for (const v of permutations(versions))
      for (const e of permutations(edges)) {
        const outcome = resolveSupersedesDominance(c, v, e, businessDate)
        outcomes.add(
          JSON.stringify(outcome.ok ? { ok: true, survivors: [...outcome.survivingSourceVersionIds].sort() } : outcome),
        )
      }
  return [...outcomes]
}

const BLOCKED_UNUSABLE = JSON.stringify({ ok: false, blocker: 'SUPERSEDES_SUCCESSOR_UNUSABLE' })

test('unusable successor: S1 + an unusable S2 already in force -> blocked, no winner, in every order', () => {
  const outcomes = everyOrder([S1], [version(S1, '2026-01-01'), version(S2, '2026-06-01')], [edge(S2, S1)], date('2026-08-15'))
  assert.deepEqual(outcomes, [BLOCKED_UNUSABLE])
})

test('unusable successor: S1 + unusable S2 + an unrelated candidate B -> blocked, B never wins, in every order', () => {
  const outcomes = everyOrder(
    [S1, SB],
    [version(S1, '2026-01-01'), version(SB, '2026-01-01'), version(S2, '2026-06-01')],
    [edge(S2, S1)],
    date('2026-08-15'),
  )
  assert.deepEqual(outcomes, [BLOCKED_UNUSABLE])
})

test('usable successor: S1 + a usable S2 already in force -> S2 dominates normally, in every order', () => {
  const outcomes = everyOrder([S1, S2], [version(S1, '2026-01-01'), version(S2, '2026-06-01')], [edge(S2, S1)], date('2026-08-15'))
  assert.deepEqual(outcomes, [JSON.stringify({ ok: true, survivors: [S2] })])
})

test('successor not yet in force: an unusable S2 from a later date leaves S1 as the historical answer', () => {
  const alone = everyOrder([S1], [version(S1, '2026-01-01'), version(S2, '2026-06-01')], [edge(S2, S1)], date('2026-03-15'))
  assert.deepEqual(alone, [JSON.stringify({ ok: true, survivors: [S1] })])
  // with an unrelated B present, S1 and B both survive for the caller to report as a tie
  const withB = everyOrder(
    [S1, SB],
    [version(S1, '2026-01-01'), version(SB, '2026-01-01'), version(S2, '2026-06-01')],
    [edge(S2, S1)],
    date('2026-03-15'),
  )
  assert.deepEqual(withB, [JSON.stringify({ ok: true, survivors: [S1, SB].sort() })])
})

test('unusable successor: the very day it takes effect already blocks (inclusive)', () => {
  const outcome = resolveSupersedesDominance([S1], [version(S1, '2026-01-01'), version(S2, '2026-06-01')], [edge(S2, S1)], date('2026-06-01'))
  assert.equal(outcome.ok === false && outcome.blocker, 'SUPERSEDES_SUCCESSOR_UNUSABLE')
})

test('missing or contradictory successor dates keep their own fail-closed blockers, in every order', () => {
  const missing = everyOrder(
    [S1, SB],
    [version(S1, '2026-01-01'), version(SB, '2026-01-01'), version(S2, null)],
    [edge(S2, S1)],
    date('2026-08-15'),
  )
  assert.deepEqual(missing, [JSON.stringify({ ok: false, blocker: 'SUPERSEDES_EFFECTIVE_DATE_INCOMPLETE' })])
  const contradictory = everyOrder(
    [S1, SB],
    [version(S1, '2026-01-01'), version(SB, '2026-01-01'), version(S2, '2026-09-01', '2026-02-01')],
    [edge(S2, S1)],
    date('2026-08-15'),
  )
  assert.deepEqual(contradictory, [JSON.stringify({ ok: false, blocker: 'SUPERSEDES_CONTRADICTORY_DATES' })])
})

test('date blockers take priority over an unusable successor, and over each other, in every order', () => {
  // S2 (unusable, in force) replaces S1; S3 (missing date) replaces SB. The missing date decides.
  const outcomes = everyOrder(
    [S1, SB],
    [version(S1, '2026-01-01'), version(SB, '2026-01-01'), version(S2, '2026-06-01'), version(S3, null)],
    [edge(S2, S1), edge(S3, SB)],
    date('2026-08-15'),
  )
  assert.deepEqual(outcomes, [JSON.stringify({ ok: false, blocker: 'SUPERSEDES_EFFECTIVE_DATE_INCOMPLETE' })])
  // A missing date and a contradictory date on two different successors: always INCOMPLETE.
  const both = everyOrder(
    [S1, SB],
    [version(S1, '2026-01-01'), version(SB, '2026-01-01'), version(S2, '2026-09-01', '2026-02-01'), version(S3, null)],
    [edge(S2, S1), edge(S3, SB)],
    date('2026-08-15'),
  )
  assert.deepEqual(both, [JSON.stringify({ ok: false, blocker: 'SUPERSEDES_EFFECTIVE_DATE_INCOMPLETE' })])
})

test('transitive: a usable successor that replaced an unusable middle version still dominates normally', () => {
  // S3 (usable) SUPERSEDES S2 (unusable) SUPERSEDES S1, all in force: S3 reaches S1 and answers.
  const outcomes = everyOrder(
    [S1, S3],
    [version(S1, '2026-01-01'), version(S2, '2026-03-01'), version(S3, '2026-05-01')],
    [edge(S3, S2), edge(S2, S1)],
    date('2026-08-15'),
  )
  assert.deepEqual(outcomes, [JSON.stringify({ ok: true, survivors: [S3] })])
})

test('transitive: a usable successor not yet in force cannot cover an unusable one that is -> blocked', () => {
  // S2 (unusable) took effect in March; S3 (usable) only from December. On August 15 S1 had
  // already been replaced, but nothing usable had replaced it yet.
  const outcomes = everyOrder(
    [S1, S3],
    [version(S1, '2026-01-01'), version(S2, '2026-03-01'), version(S3, '2026-12-01')],
    [edge(S3, S2), edge(S2, S1)],
    date('2026-08-15'),
  )
  assert.deepEqual(outcomes, [BLOCKED_UNUSABLE])
})

test('an unusable successor that replaced nothing among the candidates changes nothing', () => {
  // S2 supersedes S3, which is not a candidate: S1 and SB are untouched.
  const outcomes = everyOrder(
    [S1, SB],
    [version(S1, '2026-01-01'), version(SB, '2026-01-01'), version(S2, '2026-06-01'), version(S3, '2026-01-01')],
    [edge(S2, S3)],
    date('2026-08-15'),
  )
  assert.deepEqual(outcomes, [JSON.stringify({ ok: true, survivors: [S1, SB].sort() })])
})

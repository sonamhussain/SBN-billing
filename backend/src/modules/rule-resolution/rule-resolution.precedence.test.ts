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

test('T42 a non-candidate successor that was already in force still dominates its predecessor', () => {
  // S2 is not a usable candidate (it failed the gate), but it had taken effect on the business
  // date, so resurrecting S1 would contradict the evidence. Nothing survives, and the caller
  // blocks — the fail-closed answer, never a silent fallback to the superseded predecessor.
  const outcome = resolveSupersedesDominance(
    [S1],
    [version(S1, '2026-01-01'), version(S2, '2026-02-01')],
    [edge(S2, S1)],
    date('2026-10-15'),
  )
  assert.deepEqual(outcome.ok && outcome.survivingSourceVersionIds, [])
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

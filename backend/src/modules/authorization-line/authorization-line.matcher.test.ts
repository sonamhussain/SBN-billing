import test from 'node:test'
import assert from 'node:assert/strict'
import { Prisma } from '../../../generated/prisma/client.ts'
import { evaluateScope, type MatcherActivity, type MatcherInput, type MatcherLine } from './authorization-line.matcher.ts'

// A5.4 — the pure scope matcher. Synthetic identifiers only; no database access.

const SVC_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const SVC_B = 'aaaaaaaa-0000-4000-8000-000000000002'
const PROC_A = 'bbbbbbbb-0000-4000-8000-000000000001'
const PROC_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const DX_A = 'cccccccc-0000-4000-8000-000000000001'
const DATE = new Date('2026-06-15T00:00:00.000Z')
const d = (value: string) => new Date(`${value}T00:00:00.000Z`)
const dec = (value: string) => new Prisma.Decimal(value)

let serial = 0
const line = (overrides: Partial<MatcherLine> = {}): MatcherLine => ({
  id: `11111111-0000-4000-8000-${String(++serial).padStart(12, '0')}`,
  sequence: serial,
  serviceId: SVC_A,
  procedureCodeId: null,
  diagnosisCodeId: null,
  approvedQty: dec('10'),
  unitCode: null,
  approvedFrom: null,
  approvedThrough: null,
  status: 'APPROVED',
  ...overrides,
})
const activity = (overrides: Partial<MatcherActivity> = {}): MatcherActivity => ({
  id: `22222222-0000-4000-8000-${String(++serial).padStart(12, '0')}`,
  serviceId: SVC_A,
  procedureCodeId: null,
  quantity: dec('1'),
  unitCode: null,
  ...overrides,
})
const input = (overrides: Partial<MatcherInput> = {}): MatcherInput => ({
  contextMatch: true,
  header: { status: 'APPROVED', validFrom: null, validThrough: null },
  serviceDate: DATE,
  lines: [],
  activities: [],
  activeDiagnosisCodeIds: [],
  ...overrides,
})
const outcomeOf = (result: ReturnType<typeof evaluateScope>, activityId: string) => result.activities.find((row) => row.encounterActivityId === activityId)

// ---------------------------------------------------------------- context

test('a drifted context evaluates nothing and substitutes nothing', () => {
  const l = line()
  const a = activity()
  const result = evaluateScope(input({ contextMatch: false, lines: [l], activities: [a] }))
  assert.equal(outcomeOf(result, a.id)?.outcome, 'CONTEXT_MISMATCH')
  assert.equal(outcomeOf(result, a.id)?.authorizationLineId, null)
  assert.deepEqual(outcomeOf(result, a.id)?.candidateAuthorizationLineIds, [])
  // Nothing was allocated, so no utilization is reported rather than a misleading zero.
  assert.deepEqual(result.lineUtilization, [])
})

// ---------------------------------------------------------------- candidates

test('zero candidate lines is NO_MATCH', () => {
  const a = activity({ serviceId: SVC_B })
  const result = evaluateScope(input({ lines: [line({ serviceId: SVC_A })], activities: [a] }))
  assert.equal(outcomeOf(result, a.id)?.outcome, 'NO_MATCH')
})

test('a service constraint matches the exact service id', () => {
  const l = line({ serviceId: SVC_A })
  const a = activity({ serviceId: SVC_A })
  assert.equal(outcomeOf(evaluateScope(input({ lines: [l], activities: [a] })), a.id)?.outcome, 'MATCHED')
})

test('a procedure constraint matches the exact procedure id', () => {
  const l = line({ serviceId: null, procedureCodeId: PROC_A })
  const hit = activity({ serviceId: null, procedureCodeId: PROC_A })
  const miss = activity({ serviceId: null, procedureCodeId: PROC_B })
  const result = evaluateScope(input({ lines: [l], activities: [hit, miss] }))
  assert.equal(outcomeOf(result, hit.id)?.outcome, 'MATCHED')
  assert.equal(outcomeOf(result, miss.id)?.outcome, 'NO_MATCH')
})

test('when a line names both service and procedure, both must match', () => {
  const l = line({ serviceId: SVC_A, procedureCodeId: PROC_A })
  const both = activity({ serviceId: SVC_A, procedureCodeId: PROC_A })
  const serviceOnly = activity({ serviceId: SVC_A, procedureCodeId: PROC_B })
  const procedureOnly = activity({ serviceId: SVC_B, procedureCodeId: PROC_A })
  const result = evaluateScope(input({ lines: [l], activities: [both, serviceOnly, procedureOnly] }))
  assert.equal(outcomeOf(result, both.id)?.outcome, 'MATCHED')
  assert.equal(outcomeOf(result, serviceOnly.id)?.outcome, 'NO_MATCH')
  assert.equal(outcomeOf(result, procedureOnly.id)?.outcome, 'NO_MATCH')
})

test('a null diagnosis on the line imposes no diagnosis restriction', () => {
  const a = activity()
  assert.equal(outcomeOf(evaluateScope(input({ lines: [line({ diagnosisCodeId: null })], activities: [a] })), a.id)?.outcome, 'MATCHED')
})

test('a scoped diagnosis must be active on the Encounter', () => {
  const l = line({ diagnosisCodeId: DX_A })
  const a = activity()
  assert.equal(outcomeOf(evaluateScope(input({ lines: [l], activities: [a], activeDiagnosisCodeIds: [DX_A] })), a.id)?.outcome, 'MATCHED')
  // A removed diagnosis is simply not in the active set, so it does not satisfy the scope.
  assert.equal(outcomeOf(evaluateScope(input({ lines: [l], activities: [a], activeDiagnosisCodeIds: [] })), a.id)?.outcome, 'NO_MATCH')
})

// ---------------------------------------------------------------- ambiguity, never a winner

test('two candidate lines is AMBIGUOUS and names both, in id order', () => {
  const l1 = line()
  const l2 = line()
  const a = activity()
  const row = outcomeOf(evaluateScope(input({ lines: [l2, l1], activities: [a] })), a.id)
  assert.equal(row?.outcome, 'AMBIGUOUS')
  assert.equal(row?.authorizationLineId, null)
  assert.deepEqual(row?.candidateAuthorizationLineIds, [l1.id, l2.id].sort())
})

test('a more specific line does not win over a less specific one', () => {
  // Service-only and service+procedure both fit. Ranking by specificity would invent precedence.
  const general = line({ serviceId: SVC_A })
  const specific = line({ serviceId: SVC_A, procedureCodeId: PROC_A })
  const a = activity({ serviceId: SVC_A, procedureCodeId: PROC_A })
  assert.equal(outcomeOf(evaluateScope(input({ lines: [general, specific], activities: [a] })), a.id)?.outcome, 'AMBIGUOUS')
})

test('swapping line sequence does not choose a winner', () => {
  const l1 = line({ sequence: 1 })
  const l2 = line({ sequence: 2 })
  const a = activity()
  const forward = evaluateScope(input({ lines: [l1, l2], activities: [a] }))
  const swapped = evaluateScope(input({ lines: [{ ...l1, sequence: 2 }, { ...l2, sequence: 1 }], activities: [a] }))
  assert.equal(outcomeOf(forward, a.id)?.outcome, 'AMBIGUOUS')
  assert.deepEqual(outcomeOf(forward, a.id), outcomeOf(swapped, a.id))
})

test('an ambiguous activity is allocated to no line', () => {
  const l1 = line()
  const l2 = line()
  const a = activity({ quantity: dec('5') })
  const result = evaluateScope(input({ lines: [l1, l2], activities: [a] }))
  for (const row of result.lineUtilization) {
    assert.deepEqual(row.matchedActivityIds, [])
    assert.equal(row.matchedQty, '0')
  }
})

// ---------------------------------------------------------------- statuses

test('an approving header lets evaluation continue; any other header stops it', () => {
  for (const status of ['APPROVED', 'PARTIALLY_APPROVED']) {
    const a = activity()
    assert.equal(outcomeOf(evaluateScope(input({ header: { status, validFrom: null, validThrough: null }, lines: [line()], activities: [a] })), a.id)?.outcome, 'MATCHED')
  }
  for (const status of ['REQUESTED', 'PENDING', 'DENIED', 'UNKNOWN']) {
    const a = activity()
    assert.equal(outcomeOf(evaluateScope(input({ header: { status, validFrom: null, validThrough: null }, lines: [line()], activities: [a] })), a.id)?.outcome, 'HEADER_STATUS_NOT_APPROVED')
  }
})

test('an approving line lets evaluation continue; any other line stops it', () => {
  for (const status of ['APPROVED', 'PARTIALLY_APPROVED']) {
    const a = activity()
    assert.equal(outcomeOf(evaluateScope(input({ lines: [line({ status })], activities: [a] })), a.id)?.outcome, 'MATCHED')
  }
  for (const status of ['REQUESTED', 'PENDING', 'DENIED', 'UNKNOWN']) {
    const a = activity()
    assert.equal(outcomeOf(evaluateScope(input({ lines: [line({ status })], activities: [a] })), a.id)?.outcome, 'LINE_STATUS_NOT_APPROVED')
  }
})

test('a denied header with an approved line reports the header and rewrites neither', () => {
  const l = line({ status: 'APPROVED' })
  const a = activity()
  const header = { status: 'DENIED', validFrom: null, validThrough: null }
  assert.equal(outcomeOf(evaluateScope(input({ header, lines: [l], activities: [a] })), a.id)?.outcome, 'HEADER_STATUS_NOT_APPROVED')
  assert.equal(l.status, 'APPROVED')
  assert.equal(header.status, 'DENIED')
})

// ---------------------------------------------------------------- dates

test('a service date outside a supplied header or line bound is DATE_OUTSIDE_SCOPE', () => {
  const cases: Array<[string, Partial<MatcherInput>, Partial<MatcherLine>]> = [
    ['header lower', { header: { status: 'APPROVED', validFrom: d('2026-06-16'), validThrough: null } }, {}],
    ['header upper', { header: { status: 'APPROVED', validFrom: null, validThrough: d('2026-06-14') } }, {}],
    ['line lower', {}, { approvedFrom: d('2026-06-16') }],
    ['line upper', {}, { approvedThrough: d('2026-06-14') }],
  ]
  for (const [label, inputOverrides, lineOverrides] of cases) {
    const a = activity()
    const result = evaluateScope(input({ ...inputOverrides, lines: [line(lineOverrides)], activities: [a] }))
    assert.equal(outcomeOf(result, a.id)?.outcome, 'DATE_OUTSIDE_SCOPE', label)
  }
})

test('a service date exactly on every supplied bound stays in scope', () => {
  const a = activity()
  const result = evaluateScope(input({
    header: { status: 'APPROVED', validFrom: DATE, validThrough: DATE },
    lines: [line({ approvedFrom: DATE, approvedThrough: DATE })],
    activities: [a],
  }))
  assert.equal(outcomeOf(result, a.id)?.outcome, 'MATCHED')
})

test('a missing bound adds no invented restriction', () => {
  const a = activity()
  assert.equal(outcomeOf(evaluateScope(input({ lines: [line({ approvedFrom: null, approvedThrough: null })], activities: [a] })), a.id)?.outcome, 'MATCHED')
})

// ---------------------------------------------------------------- units

test('a line unit equal to the activity unit passes', () => {
  const a = activity({ unitCode: 'ML' })
  assert.equal(outcomeOf(evaluateScope(input({ lines: [line({ unitCode: 'ML' })], activities: [a] })), a.id)?.outcome, 'MATCHED')
})

test('a line unit different from the activity unit is UNIT_MISMATCH, case included', () => {
  for (const unit of ['TABLET', 'ml', null]) {
    const a = activity({ unitCode: unit })
    assert.equal(outcomeOf(evaluateScope(input({ lines: [line({ unitCode: 'ML' })], activities: [a] })), a.id)?.outcome, 'UNIT_MISMATCH', String(unit))
  }
})

test('a line with no unit imposes no unit restriction', () => {
  const a = activity({ unitCode: 'ANYTHING' })
  assert.equal(outcomeOf(evaluateScope(input({ lines: [line({ unitCode: null })], activities: [a] })), a.id)?.outcome, 'MATCHED')
})

test('a unit-mismatched activity is not added to its line quantity', () => {
  // 8 ML and 5 TABLET against a line approved for 10 ML. Adding them would compare two numbers that
  // do not measure the same thing.
  const l = line({ unitCode: 'ML', approvedQty: dec('10') })
  const ml = activity({ unitCode: 'ML', quantity: dec('8') })
  const tablet = activity({ unitCode: 'TABLET', quantity: dec('5') })
  const result = evaluateScope(input({ lines: [l], activities: [ml, tablet] }))
  assert.equal(outcomeOf(result, ml.id)?.outcome, 'MATCHED')
  assert.equal(outcomeOf(result, tablet.id)?.outcome, 'UNIT_MISMATCH')
  assert.equal(result.lineUtilization[0].matchedQty, '8')
  assert.deepEqual(result.lineUtilization[0].matchedActivityIds, [ml.id])
})

// ---------------------------------------------------------------- quantity

test('a null approved quantity is QUANTITY_UNKNOWN even when every status approves', () => {
  const a = activity()
  const result = evaluateScope(input({ lines: [line({ approvedQty: null })], activities: [a] }))
  assert.equal(outcomeOf(result, a.id)?.outcome, 'QUANTITY_UNKNOWN')
  assert.equal(result.lineUtilization[0].quantityOutcome, 'UNKNOWN')
})

test('a total within the approved quantity passes', () => {
  const a = activity({ quantity: dec('10') })
  const result = evaluateScope(input({ lines: [line({ approvedQty: dec('10') })], activities: [a] }))
  assert.equal(outcomeOf(result, a.id)?.outcome, 'MATCHED')
  assert.equal(result.lineUtilization[0].quantityOutcome, 'WITHIN')
})

test('every activity on a line whose total exceeds capacity is QUANTITY_EXCEEDED', () => {
  const l = line({ approvedQty: dec('5') })
  const a1 = activity({ quantity: dec('3') })
  const a2 = activity({ quantity: dec('3') })
  const result = evaluateScope(input({ lines: [l], activities: [a1, a2] }))
  // Not first-come: neither activity "used up" the capacity before the other.
  assert.equal(outcomeOf(result, a1.id)?.outcome, 'QUANTITY_EXCEEDED')
  assert.equal(outcomeOf(result, a2.id)?.outcome, 'QUANTITY_EXCEEDED')
  assert.equal(result.lineUtilization[0].matchedQty, '6')
  assert.equal(result.lineUtilization[0].quantityOutcome, 'EXCEEDED')
})

test('quantities are exact decimals: 0.1 + 0.2 is exactly 0.3', () => {
  // In binary floating point 0.1 + 0.2 is 0.30000000000000004, which would exceed a capacity of 0.3.
  const l = line({ approvedQty: dec('0.3') })
  const a1 = activity({ quantity: dec('0.1') })
  const a2 = activity({ quantity: dec('0.2') })
  const result = evaluateScope(input({ lines: [l], activities: [a1, a2] }))
  assert.equal(result.lineUtilization[0].matchedQty, '0.3')
  assert.equal(result.lineUtilization[0].quantityOutcome, 'WITHIN')
  assert.equal(outcomeOf(result, a1.id)?.outcome, 'MATCHED')
})

test('an explicit zero approved quantity is exceeded by any allocated activity', () => {
  const a = activity({ quantity: dec('1') })
  const result = evaluateScope(input({ lines: [line({ approvedQty: dec('0') })], activities: [a] }))
  assert.equal(outcomeOf(result, a.id)?.outcome, 'QUANTITY_EXCEEDED')
})

test('reordering the activities changes no outcome and no total', () => {
  const l = line({ approvedQty: dec('5') })
  const a1 = activity({ quantity: dec('2') })
  const a2 = activity({ quantity: dec('4') })
  const forward = evaluateScope(input({ lines: [l], activities: [a1, a2] }))
  const reversed = evaluateScope(input({ lines: [l], activities: [a2, a1] }))
  assert.deepEqual(forward, reversed)
})

// ---------------------------------------------------------------- order of facts

test('the first failing fact is the one reported, in the documented order', () => {
  // A denied header, a denied line, an out-of-range date, a wrong unit and an unknown quantity all at
  // once: the header is reported, because it is checked first.
  const l = line({ status: 'DENIED', approvedFrom: d('2027-01-01'), unitCode: 'ML', approvedQty: null })
  const a = activity({ unitCode: 'TABLET' })
  const header = { status: 'DENIED', validFrom: null, validThrough: null }
  assert.equal(outcomeOf(evaluateScope(input({ header, lines: [l], activities: [a] })), a.id)?.outcome, 'HEADER_STATUS_NOT_APPROVED')
})

test('a single-candidate outcome still names the line, even when it fails', () => {
  const l = line({ status: 'DENIED' })
  const a = activity()
  const row = outcomeOf(evaluateScope(input({ lines: [l], activities: [a] })), a.id)
  assert.equal(row?.outcome, 'LINE_STATUS_NOT_APPROVED')
  assert.equal(row?.authorizationLineId, l.id)
})

test('the result carries no readiness, submission or payer-acceptance field', () => {
  const a = activity()
  const result = evaluateScope(input({ lines: [line()], activities: [a] }))
  const keys = JSON.stringify(result)
  for (const forbidden of ['readyForClaim', 'authorizedClaimLine', 'payerAcceptance', 'submissionAllowed'])
    assert.equal(keys.includes(forbidden), false, forbidden)
})

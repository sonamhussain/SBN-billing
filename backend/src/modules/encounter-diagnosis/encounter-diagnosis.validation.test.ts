import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkReadInvariant,
  isEncounterDiagnosisUuid,
  planCompaction,
  planReorder,
  toEncounterDiagnosisDto,
  validateAddBody,
  validateOrderBody,
  validateRemoveBody,
  type ActiveRow,
} from './encounter-diagnosis.validation.ts'
import { encounterDiagnosisAuditSnapshot } from '../audit/audit.snapshot.ts'

// A4.5 — the pure body, read-invariant, reorder and compaction rules. Synthetic values only.

const ED1 = '11111111-1111-4111-8111-111111111111'
const ED2 = '22222222-2222-4222-8222-222222222222'
const ED3 = '33333333-3333-4333-8333-333333333333'
const DX_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DX_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DX_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const row = (id: string, diagnosisCodeId: string, sequence: number): ActiveRow => ({ id, diagnosisCodeId, sequence })
const three = [row(ED1, DX_A, 1), row(ED2, DX_B, 2), row(ED3, DX_C, 3)]

test('an encounter diagnosis id must be UUID-shaped', () => {
  assert.equal(isEncounterDiagnosisUuid(ED1), true)
  assert.equal(isEncounterDiagnosisUuid('nope'), false)
  assert.equal(isEncounterDiagnosisUuid(1), false)
})

test('add takes exactly { diagnosisCodeId }; the sequence is never client-supplied', () => {
  assert.deepEqual(validateAddBody({ diagnosisCodeId: DX_A }), { ok: true, value: { diagnosisCodeId: DX_A } })
  for (const body of [null, [], {}, { diagnosisCodeId: 'x' }, { diagnosisCodeId: DX_A, note: 'x' }, { diagnosisCodeId: DX_A, isPrimary: true }]) {
    assert.equal(validateAddBody(body).ok, false, JSON.stringify(body))
  }
  for (const field of ['sequence', 'id', 'encounterId', 'removedAt', 'createdAt', 'updatedAt']) {
    const outcome = validateAddBody({ diagnosisCodeId: DX_A, [field]: 1 })
    assert.equal(outcome.ok, false, field)
    if (!outcome.ok) assert.match(outcome.message, new RegExp(field))
  }
})

test('the order body is exactly { encounterDiagnosisIds: [uuid...] } with no duplicates', () => {
  assert.deepEqual(validateOrderBody({ encounterDiagnosisIds: [ED2, ED1] }), { ok: true, value: [ED2, ED1] })
  assert.deepEqual(validateOrderBody({ encounterDiagnosisIds: [] }), { ok: true, value: [] })
  for (const body of [null, [], {}, { encounterDiagnosisIds: 'x' }, { encounterDiagnosisIds: [ED1, 'x'] }, { encounterDiagnosisIds: [ED1, ED1] }, { encounterDiagnosisIds: [ED1], sequence: 1 }, { encounterDiagnosisIds: [ED1], extra: 1 }]) {
    assert.equal(validateOrderBody(body).ok, false, JSON.stringify(body))
  }
})

test('the remove body is empty (or absent); anything else is rejected', () => {
  assert.equal(validateRemoveBody(undefined).ok, true)
  assert.equal(validateRemoveBody({}).ok, true)
  for (const body of [null, [], { reason: 'x' }, { removedAt: '2026-01-01' }]) assert.equal(validateRemoveBody(body).ok, false, JSON.stringify(body))
})

test('read invariant: a contiguous 1..N with unique codes passes and comes back ordered', () => {
  const shuffled = [three[2], three[0], three[1]]
  const outcome = checkReadInvariant(shuffled)
  assert.equal(outcome.ok, true)
  if (outcome.ok) assert.deepEqual(outcome.value.map((r) => r.sequence), [1, 2, 3])
  assert.equal(checkReadInvariant([]).ok, true, 'no active rows is valid')
})

test('read invariant fails closed on a gap, a duplicate sequence, a start other than 1 or a duplicate code', () => {
  const cases: [string, ActiveRow[]][] = [
    ['gap 1,3', [row(ED1, DX_A, 1), row(ED2, DX_B, 3)]],
    ['duplicate sequence 1,1', [row(ED1, DX_A, 1), row(ED2, DX_B, 1)]],
    ['starts at 2', [row(ED1, DX_A, 2)]],
    ['duplicate code', [row(ED1, DX_A, 1), row(ED2, DX_A, 2)]],
  ]
  for (const [label, rows] of cases) assert.equal(checkReadInvariant(rows).ok, false, label)
})

test('reorder: the exact active set in a new order yields only the rows that move', () => {
  const reversed = planReorder(three, [ED3, ED2, ED1])
  assert.deepEqual(reversed, { ok: true, value: [{ id: ED3, from: 3, to: 1 }, { id: ED1, from: 1, to: 3 }] })
  const swapFirstTwo = planReorder(three, [ED2, ED1, ED3])
  assert.deepEqual(swapFirstTwo, { ok: true, value: [{ id: ED2, from: 2, to: 1 }, { id: ED1, from: 1, to: 2 }] })
})

test('reorder refuses a same-order no-op, a missing, extra or foreign ID, and an empty list', () => {
  const FOREIGN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  assert.equal(planReorder(three, [ED1, ED2, ED3]).ok, false, 'same order')
  assert.equal(planReorder(three, [ED2, ED1]).ok, false, 'missing ID')
  assert.equal(planReorder(three, [ED3, ED2, ED1, FOREIGN]).ok, false, 'extra ID')
  assert.equal(planReorder(three, [ED3, ED2, FOREIGN]).ok, false, 'foreign ID in place of an active one')
  assert.equal(planReorder(three, []).ok, false, 'empty with active rows')
  assert.equal(planReorder([], []).ok, false, 'empty with zero active rows is a no-op')
})

test('compaction after removal renumbers the remaining rows 1..N and touches only rows that move', () => {
  assert.deepEqual(planCompaction([row(ED2, DX_B, 2), row(ED3, DX_C, 3)]), [{ id: ED2, from: 2, to: 1 }, { id: ED3, from: 3, to: 2 }], 'first removed')
  assert.deepEqual(planCompaction([row(ED1, DX_A, 1), row(ED3, DX_C, 3)]), [{ id: ED3, from: 3, to: 2 }], 'middle removed')
  assert.deepEqual(planCompaction([row(ED1, DX_A, 1), row(ED2, DX_B, 2)]), [], 'last removed: nothing moves')
})

test('the DTO joins the master code and name, and carries no removedAt or clinical context', () => {
  const dto = toEncounterDiagnosisDto({
    id: ED1,
    encounterId: ED2,
    diagnosisCodeId: DX_A,
    sequence: 1,
    createdAt: new Date('2026-09-24T10:00:00.000Z'),
    updatedAt: new Date('2026-09-24T10:00:00.000Z'),
    diagnosisCode: { code: 'A01.0', displayName: 'Synthetic diagnosis A' },
  })
  assert.deepEqual(dto.diagnosisCode, { code: 'A01.0', displayName: 'Synthetic diagnosis A' })
  assert.equal(Object.keys(dto).some((key) => /(removed|patient|facility|clinician|primary|claim|status)/i.test(key)), false)
})

test('the audit snapshot carries only id, sequence, removedAt and updatedAt — never the diagnosis or encounter', () => {
  const snapshot = encounterDiagnosisAuditSnapshot({ id: ED1, sequence: 2, removedAt: null, updatedAt: new Date('2026-09-24T10:00:00.000Z') })
  assert.deepEqual(Object.keys(snapshot).sort(), ['id', 'removedAt', 'sequence', 'updatedAt'])
  assert.deepEqual(Object.keys(encounterDiagnosisAuditSnapshot({ id: ED1 })), ['id'])
  assert.equal(JSON.stringify(snapshot).includes(DX_A), false)
})

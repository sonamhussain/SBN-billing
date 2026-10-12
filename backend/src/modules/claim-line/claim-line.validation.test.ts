import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkActiveOrder,
  isClaimStructureUuid,
  planCompaction,
  planPointerChanges,
  planReorder,
  validateCreateLineBody,
  validateLineOrderBody,
  validatePointerBody,
  validateRemoveBody,
} from './claim-line.validation.ts'

// A6.2 — ClaimLine request shapes and pure plans. Synthetic values only.

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'

test('a line is created from exactly one encounterActivityId', () => {
  assert.deepEqual(validateCreateLineBody({ encounterActivityId: A }), { ok: true, value: { encounterActivityId: A } })
  for (const body of [undefined, null, [], 'x', {}, { encounterActivityId: 'not-a-uuid' }, { encounterActivityId: 42 }]) {
    assert.equal(validateCreateLineBody(body).ok, false, JSON.stringify(body))
  }
})

test('server-owned and A4.6 source facts are refused by name on line create', () => {
  for (const field of ['sequence', 'claimId', 'encounterId', 'claimLineContractVersion', 'removedAt', 'createdByUserId', 'createdAt']) {
    const result = validateCreateLineBody({ encounterActivityId: A, [field]: 'x' })
    assert.ok(!result.ok && result.message.includes(field) && result.message.includes('owned by the server'), field)
  }
  for (const field of ['serviceId', 'procedureCodeId', 'quantity', 'unitCode', 'modifierCodes', 'code', 'price', 'amount', 'state']) {
    const result = validateCreateLineBody({ encounterActivityId: A, [field]: 'x' })
    assert.ok(!result.ok && result.message.includes(field), field)
  }
})

test('order and pointer bodies are UUID lists without duplicates; an empty pointer list is allowed', () => {
  assert.deepEqual(validateLineOrderBody({ claimLineIds: [A, B] }), { ok: true, value: [A, B] })
  assert.equal(validateLineOrderBody({ claimLineIds: [A, A] }).ok, false)
  assert.equal(validateLineOrderBody({ claimLineIds: 'x' }).ok, false)
  assert.equal(validateLineOrderBody({ claimLineIds: [A], sequence: 1 }).ok, false)
  assert.deepEqual(validatePointerBody({ claimDiagnosisIds: [] }), { ok: true, value: [] })
  assert.equal(validatePointerBody({ claimDiagnosisIds: [B, B] }).ok, false)
  assert.equal(validatePointerBody({ claimDiagnosisIds: ['nope'] }).ok, false)
  assert.equal(validatePointerBody({ claimDiagnosisIds: [B], order: [1] }).ok, false)
})

test('a remove body is empty or absent', () => {
  assert.equal(validateRemoveBody(undefined).ok, true)
  assert.equal(validateRemoveBody({}).ok, true)
  assert.equal(validateRemoveBody({ removedAt: '2026-01-01' }).ok, false)
  assert.equal(validateRemoveBody([]).ok, false)
})

test('stored active order must be exactly 1..N', () => {
  assert.equal(checkActiveOrder([{ id: A, sequence: 2 }, { id: B, sequence: 1 }]).ok, true)
  assert.equal(checkActiveOrder([{ id: A, sequence: 1 }, { id: B, sequence: 3 }]).ok, false)
  assert.equal(checkActiveOrder([{ id: A, sequence: 1 }, { id: B, sequence: 1 }]).ok, false)
})

test('reorder needs the exact active set; the identical order is an empty plan', () => {
  const active = [{ id: A, sequence: 1 }, { id: B, sequence: 2 }, { id: C, sequence: 3 }]
  assert.deepEqual(planReorder(active, [C, A, B], 'ids'), { ok: true, value: [{ id: C, from: 3, to: 1 }, { id: A, from: 1, to: 2 }, { id: B, from: 2, to: 3 }] })
  assert.deepEqual(planReorder(active, [A, B, C], 'ids'), { ok: true, value: [] })
  assert.equal(planReorder(active, [A, B], 'ids').ok, false)
  assert.equal(planReorder(active, [A, B, '00000000-0000-4000-8000-0000000000ff'], 'ids').ok, false)
})

test('compaction renumbers the remaining rows 1..N in their existing order', () => {
  assert.deepEqual(planCompaction([{ id: A, sequence: 1 }, { id: C, sequence: 3 }]), [{ id: C, from: 3, to: 2 }])
  assert.deepEqual(planCompaction([{ id: A, sequence: 1 }]), [])
})

test('pointer exact-set plan removes absent links, adds missing ones and is empty for the same set', () => {
  const active = [{ id: 'p1', claimDiagnosisId: A }, { id: 'p2', claimDiagnosisId: B }]
  assert.deepEqual(planPointerChanges(active, [B, C]), { removePointerIds: ['p1'], addDiagnosisIds: [C] })
  assert.deepEqual(planPointerChanges(active, [B, A]), { removePointerIds: [], addDiagnosisIds: [] })
  assert.deepEqual(planPointerChanges(active, []), { removePointerIds: ['p1', 'p2'], addDiagnosisIds: [] })
})

test('claim structure identifiers must be UUIDs', () => {
  assert.equal(isClaimStructureUuid(A), true)
  for (const value of ['', 'x', "1' OR '1'='1", 7, null, undefined]) assert.equal(isClaimStructureUuid(value), false, String(value))
})

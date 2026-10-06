import test from 'node:test'
import assert from 'node:assert/strict'
import { Prisma } from '../../../generated/prisma/client.ts'
import { MAX_LINES_PER_BATCH, lineServerOwnedFields } from './authorization-line.types.ts'
import {
  type CurrentEncounterContext,
  type FrozenAuthorizationContext,
  frozenContextMatches,
  lineAuditSnapshot,
  normalizeApprovedQty,
  normalizeLineStatus,
  normalizeLineUnitCode,
  normalizeRequestedQty,
  toLineDto,
  validateLine,
  validateLineBatch,
} from './authorization-line.validation.ts'

// A5.4 — the pure line rules. Synthetic identifiers only; no database access.

const SVC = 'aaaaaaaa-0000-4000-8000-000000000001'
const PROC = 'bbbbbbbb-0000-4000-8000-000000000001'
const DX = 'cccccccc-0000-4000-8000-000000000001'
const valid = (overrides: Record<string, unknown> = {}) => ({ serviceId: SVC, requestedQty: '2', status: 'APPROVED', ...overrides })
const refused = (value: unknown) => {
  const outcome = validateLine(value)
  assert.equal(outcome.ok, false)
  return outcome.ok ? '' : outcome.message
}

// ---------------------------------------------------------------- identity

test('a line naming a service, a procedure, or both is accepted', () => {
  assert.equal(validateLine(valid()).ok, true)
  assert.equal(validateLine(valid({ serviceId: null, procedureCodeId: PROC })).ok, true)
  assert.equal(validateLine(valid({ procedureCodeId: PROC })).ok, true)
})

test('a diagnosis-only line is refused: it does not say what was authorized', () => {
  assert.match(refused(valid({ serviceId: null, diagnosisCodeId: DX })), /serviceId or procedureCodeId/)
  assert.match(refused({ requestedQty: '1', status: 'APPROVED' }), /serviceId or procedureCodeId/)
})

test('a non-UUID master reference is refused and its value is not echoed', () => {
  for (const field of ['serviceId', 'procedureCodeId', 'diagnosisCodeId']) {
    const message = refused(valid({ [field]: 'not-a-uuid-SECRET' }))
    assert.match(message, new RegExp(field))
    assert.equal(message.includes('SECRET'), false)
  }
})

// ---------------------------------------------------------------- quantities

test('requestedQty uses the A4.6 strict positive grammar and is kept exact', () => {
  assert.deepEqual(normalizeRequestedQty('2'), { ok: true, value: '2' })
  assert.deepEqual(normalizeRequestedQty('0.0001'), { ok: true, value: '0.0001' })
  assert.deepEqual(normalizeRequestedQty('99999999999999.9999'), { ok: true, value: '99999999999999.9999' })
  for (const bad of ['0', '0.0', '-1', '1e3', '01', '1.23456', '123456789012345', 'abc', '', 2, null, undefined])
    assert.equal(normalizeRequestedQty(bad).ok, false, String(bad))
})

test('approvedQty may be null, an explicit zero, or positive — never negative', () => {
  assert.deepEqual(normalizeApprovedQty(undefined), { ok: true, value: null })
  assert.deepEqual(normalizeApprovedQty(null), { ok: true, value: null })
  for (const zero of ['0', '0.0', '0.0000']) assert.deepEqual(normalizeApprovedQty(zero), { ok: true, value: '0' }, zero)
  assert.deepEqual(normalizeApprovedQty('1.5'), { ok: true, value: '1.5' })
  for (const bad of ['-1', '-0', '00', '0.00000', '1e2', 1, '', 'x']) assert.equal(normalizeApprovedQty(bad).ok, false, String(bad))
})

test('approvedQty greater than requestedQty is preserved as reported', () => {
  // Payer semantics are external; A5.8 judges what the reported numbers mean.
  const outcome = validateLine(valid({ requestedQty: '1', approvedQty: '5' }))
  assert.equal(outcome.ok, true)
  if (outcome.ok) assert.equal(outcome.value.approvedQty, '5')
})

test('a numeric JSON quantity is refused so binary floating point never touches one', () => {
  assert.match(refused(valid({ requestedQty: 0.3 })), /requestedQty/)
  assert.match(refused(valid({ approvedQty: 0.3 })), /approvedQty/)
})

// ---------------------------------------------------------------- unit

test('unitCode follows A4.6: absent/null is none, trimmed, and blank is refused', () => {
  assert.deepEqual(normalizeLineUnitCode(undefined), { ok: true, value: null })
  assert.deepEqual(normalizeLineUnitCode(null), { ok: true, value: null })
  assert.deepEqual(normalizeLineUnitCode('  ML  '), { ok: true, value: 'ML' })
  assert.equal(normalizeLineUnitCode('   ').ok, false)
  assert.equal(normalizeLineUnitCode('').ok, false)
  assert.equal(normalizeLineUnitCode(5).ok, false)
})

test('unitCode keeps its case and refuses control characters and excess length', () => {
  assert.deepEqual(normalizeLineUnitCode('mL'), { ok: true, value: 'mL' })
  assert.equal(normalizeLineUnitCode('M\u0000L').ok, false)
  assert.equal(normalizeLineUnitCode('M\nL').ok, false)
  assert.equal(normalizeLineUnitCode('U'.repeat(64)).ok, true)
  assert.equal(normalizeLineUnitCode('U'.repeat(65)).ok, false)
})

// ---------------------------------------------------------------- dates

test('approved dates are strict calendar dates, inclusive, and ordered', () => {
  const same = validateLine(valid({ approvedFrom: '2026-06-01', approvedThrough: '2026-06-01' }))
  assert.equal(same.ok, true)
  assert.match(refused(valid({ approvedFrom: '2026-06-02', approvedThrough: '2026-06-01' })), /approvedThrough/)
  for (const bad of ['2026-02-30', '2026-6-1', '2026-06-01T00:00:00Z', 20260601])
    assert.match(refused(valid({ approvedFrom: bad })), /approvedFrom/, String(bad))
})

test('a missing date bound is stored as null, not invented', () => {
  const outcome = validateLine(valid())
  assert.equal(outcome.ok, true)
  if (outcome.ok) {
    assert.equal(outcome.value.approvedFrom, null)
    assert.equal(outcome.value.approvedThrough, null)
  }
})

// ---------------------------------------------------------------- status

test('status is exactly one of the six reported statuses', () => {
  for (const status of ['REQUESTED', 'PENDING', 'APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'UNKNOWN'])
    assert.equal(normalizeLineStatus(status).ok, true, status)
  for (const status of ['ACTIVE', 'EXPIRED', 'SATISFIED', 'approved', '', null, undefined])
    assert.equal(normalizeLineStatus(status).ok, false, String(status))
})

// ---------------------------------------------------------------- field ownership

test('every server-owned field is refused by name', () => {
  for (const field of lineServerOwnedFields) assert.match(refused(valid({ [field]: 'x' })), new RegExp(`${field} is derived by the server`), field)
})

test('an unknown field is refused, not ignored', () => {
  assert.match(refused(valid({ price: '10' })), /unknown field\(s\): price/)
})

test('a non-object line is refused', () => {
  for (const bad of [null, 'line', 3, []]) assert.match(refused(bad), /each line must be an object/)
})

// ---------------------------------------------------------------- batch

test('a batch body is exactly { lines: [...] }, non-empty and at most the cap', () => {
  assert.equal(validateLineBatch({ lines: [valid()] }).ok, true)
  for (const bad of [null, [], 'x', {}, { lines: [] }, { lines: 'x' }, { lines: [valid()], extra: 1 }])
    assert.equal(validateLineBatch(bad).ok, false, JSON.stringify(bad))
  assert.equal(validateLineBatch({ lines: Array.from({ length: MAX_LINES_PER_BATCH }, () => valid()) }).ok, true)
  assert.equal(validateLineBatch({ lines: Array.from({ length: MAX_LINES_PER_BATCH + 1 }, () => valid()) }).ok, false)
})

test('a batch error names the failing line index', () => {
  const outcome = validateLineBatch({ lines: [valid(), valid({ status: 'ACTIVE' })] })
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.match(outcome.message, /^lines\[1\]: status/)
})

test('a batch keeps the submitted order', () => {
  const outcome = validateLineBatch({ lines: [valid({ requestedQty: '1' }), valid({ requestedQty: '2' }), valid({ requestedQty: '3' })] })
  assert.equal(outcome.ok, true)
  if (outcome.ok) assert.deepEqual(outcome.value.map((line) => line.requestedQty), ['1', '2', '3'])
})

// ---------------------------------------------------------------- DTO and audit

const stored = {
  id: '11111111-0000-4000-8000-000000000001',
  priorAuthorizationVersionId: '22222222-0000-4000-8000-000000000001',
  sequence: 1,
  serviceId: SVC,
  procedureCodeId: null,
  diagnosisCodeId: DX,
  requestedQty: new Prisma.Decimal('2.0000'),
  approvedQty: new Prisma.Decimal('0.0000'),
  unitCode: 'ML',
  approvedFrom: new Date('2026-06-01T00:00:00.000Z'),
  approvedThrough: null,
  status: 'APPROVED',
  createdByUserId: '33333333-0000-4000-8000-000000000001',
  createdAt: new Date('2026-06-01T10:00:00.000Z'),
}

test('the DTO reports exact quantities in shortest form and dates as YYYY-MM-DD', () => {
  const dto = toLineDto(stored)
  assert.equal(dto.requestedQty, '2')
  assert.equal(dto.approvedQty, '0')
  assert.equal(dto.approvedFrom, '2026-06-01')
  assert.equal(dto.approvedThrough, null)
  assert.equal(dto.createdAt, '2026-06-01T10:00:00.000Z')
})

test('the audit snapshot carries identity and position only, never scope', () => {
  const snapshot = lineAuditSnapshot(stored)
  assert.deepEqual(Object.keys(snapshot).sort(), ['createdAt', 'id', 'priorAuthorizationVersionId', 'sequence'])
})

// ---------------------------------------------------------------- frozen context

const frozen: FrozenAuthorizationContext = {
  insuranceMembershipId: 'dddddddd-0000-4000-8000-000000000001',
  payerId: 'eeeeeeee-0000-4000-8000-000000000001',
  tpaId: null,
  networkId: 'eeeeeeee-0000-4000-8000-000000000002',
  insuranceProductId: null,
  facilityId: 'ffffffff-0000-4000-8000-000000000001',
  clinicianId: 'ffffffff-0000-4000-8000-000000000002',
  serviceDate: new Date('2026-06-15T00:00:00.000Z'),
}
const current = (): CurrentEncounterContext & { membership: NonNullable<CurrentEncounterContext['membership']> } => ({
  insuranceMembershipId: frozen.insuranceMembershipId,
  facilityId: frozen.facilityId,
  clinicianId: frozen.clinicianId,
  serviceDate: new Date(frozen.serviceDate),
  membership: { payerId: frozen.payerId, tpaId: frozen.tpaId, networkId: frozen.networkId, insuranceProductId: frozen.insuranceProductId },
})

test('an unchanged context matches', () => {
  assert.equal(frozenContextMatches(frozen, current()), true)
})

test('any drift in membership, commercial context, provider or date is a mismatch', () => {
  const other = '99999999-0000-4000-8000-000000000001'
  const drifts: Array<[string, CurrentEncounterContext]> = [
    ['membership', { ...current(), insuranceMembershipId: other }],
    ['payer', { ...current(), membership: { ...current().membership, payerId: other } }],
    ['tpa', { ...current(), membership: { ...current().membership, tpaId: other } }],
    ['network', { ...current(), membership: { ...current().membership, networkId: null } }],
    ['product', { ...current(), membership: { ...current().membership, insuranceProductId: other } }],
    ['facility', { ...current(), facilityId: other }],
    ['clinician', { ...current(), clinicianId: other }],
    ['serviceDate', { ...current(), serviceDate: new Date('2026-06-16T00:00:00.000Z') }],
  ]
  for (const [label, drifted] of drifts) assert.equal(frozenContextMatches(frozen, drifted), false, label)
})

test('an Encounter with no membership now, or no Encounter, is a mismatch', () => {
  assert.equal(frozenContextMatches(frozen, { ...current(), insuranceMembershipId: null, membership: null }), false)
  assert.equal(frozenContextMatches(frozen, null), false)
})

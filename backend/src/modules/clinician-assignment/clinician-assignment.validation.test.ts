import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideClose,
  decideResolution,
  isAssignmentUuid,
  isEffectiveOnDate,
  periodsOverlap,
  targetFieldFor,
  toFacilityDto,
  toSpecialtyDto,
  validateCloseBody,
  validateCreateBody,
} from './clinician-assignment.validation.ts'

// A4.2 — the pure date, overlap and resolution rules. Synthetic values only.

const d = (text: string) => new Date(`${text}T00:00:00.000Z`)
const period = (from: string, to: string | null) => ({ effectiveFrom: d(from), effectiveTo: to === null ? null : d(to) })
const F = '11111111-1111-4111-8111-111111111111'
const S = '22222222-2222-4222-8222-222222222222'

test('an assignment id must be UUID-shaped', () => {
  assert.equal(isAssignmentUuid(F), true)
  assert.equal(isAssignmentUuid('not-a-uuid'), false)
  assert.equal(isAssignmentUuid(7), false)
})

test('the target field depends on the assignment kind', () => {
  assert.equal(targetFieldFor('FACILITY'), 'facilityId')
  assert.equal(targetFieldFor('SPECIALTY'), 'specialtyId')
})

test('an effective period includes both of its boundary dates', () => {
  const p = period('2026-01-01', '2026-06-30')
  assert.equal(isEffectiveOnDate(p.effectiveFrom, p.effectiveTo, d('2025-12-31')), false, 'the day before the start')
  assert.equal(isEffectiveOnDate(p.effectiveFrom, p.effectiveTo, d('2026-01-01')), true, 'the start date itself')
  assert.equal(isEffectiveOnDate(p.effectiveFrom, p.effectiveTo, d('2026-03-15')), true)
  assert.equal(isEffectiveOnDate(p.effectiveFrom, p.effectiveTo, d('2026-06-30')), true, 'the end date itself')
  assert.equal(isEffectiveOnDate(p.effectiveFrom, p.effectiveTo, d('2026-07-01')), false, 'the day after the end')
})

test('an open-ended period runs forever, and a one-day period covers exactly that day', () => {
  const open = period('2026-01-01', null)
  assert.equal(isEffectiveOnDate(open.effectiveFrom, open.effectiveTo, d('2099-01-01')), true)
  assert.equal(isEffectiveOnDate(open.effectiveFrom, open.effectiveTo, d('2025-12-31')), false)
  const oneDay = period('2026-05-05', '2026-05-05')
  assert.equal(isEffectiveOnDate(oneDay.effectiveFrom, oneDay.effectiveTo, d('2026-05-05')), true)
  assert.equal(isEffectiveOnDate(oneDay.effectiveFrom, oneDay.effectiveTo, d('2026-05-04')), false)
  assert.equal(isEffectiveOnDate(oneDay.effectiveFrom, oneDay.effectiveTo, d('2026-05-06')), false)
})

test('two periods overlap when they share at least one date, including a touching boundary', () => {
  assert.equal(periodsOverlap(period('2026-01-01', '2026-06-30'), period('2026-06-30', '2026-12-31')), true, 'the shared day')
  assert.equal(periodsOverlap(period('2026-01-01', '2026-06-30'), period('2026-07-01', null)), false, 'the next day is adjacent, not overlapping')
  assert.equal(periodsOverlap(period('2026-01-01', '2026-06-30'), period('2026-01-01', '2026-06-30')), true, 'identical periods')
  assert.equal(periodsOverlap(period('2026-01-01', null), period('2026-03-01', '2026-04-01')), true, 'an open period covers a later one')
  assert.equal(periodsOverlap(period('2026-01-01', null), period('2025-01-01', '2025-12-31')), false, 'an earlier closed period')
  assert.equal(periodsOverlap(period('2026-01-01', null), period('2027-01-01', null)), true, 'two open periods always overlap eventually')
  assert.equal(periodsOverlap(period('2026-05-05', '2026-05-05'), period('2026-05-05', null)), true, 'a one-day period on the same day')
})

test('a create body needs a UUID target and a real start date', () => {
  const outcome = validateCreateBody({ facilityId: F, effectiveFrom: '2026-01-01', effectiveTo: null }, 'FACILITY')
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.ok && outcome.value, { targetId: F, effectiveFrom: d('2026-01-01'), effectiveTo: null })
  assert.equal(validateCreateBody({ facilityId: 'x', effectiveFrom: '2026-01-01' }, 'FACILITY').ok, false)
  assert.equal(validateCreateBody({ facilityId: F }, 'FACILITY').ok, false, 'effectiveFrom is required')
  assert.equal(validateCreateBody({ facilityId: F, effectiveFrom: '2026-02-31' }, 'FACILITY').ok, false, 'an impossible date')
  assert.equal(validateCreateBody({ facilityId: F, effectiveFrom: '2026-01-01T00:00:00.000Z' }, 'FACILITY').ok, false, 'a timestamp')
  assert.equal(validateCreateBody({ facilityId: F, effectiveFrom: '01/01/2026' }, 'FACILITY').ok, false, 'a non-ISO date')
  assert.equal(validateCreateBody(null, 'FACILITY').ok, false)
})

test('a create body accepts a closed, a one-day and a past period, and rejects an inverted one', () => {
  assert.equal(validateCreateBody({ facilityId: F, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' }, 'FACILITY').ok, true)
  assert.equal(validateCreateBody({ facilityId: F, effectiveFrom: '2026-05-05', effectiveTo: '2026-05-05' }, 'FACILITY').ok, true, 'one day')
  assert.equal(validateCreateBody({ facilityId: F, effectiveFrom: '2019-01-01' }, 'FACILITY').ok, true, 'a historical entry is legitimate')
  assert.equal(validateCreateBody({ facilityId: F, effectiveFrom: '2026-06-30', effectiveTo: '2026-01-01' }, 'FACILITY').ok, false)
})

test('a create body rejects unknown and server-owned fields, and the other kind of target', () => {
  assert.equal(validateCreateBody({ facilityId: F, effectiveFrom: '2026-01-01', primary: true }, 'FACILITY').ok, false)
  assert.equal(validateCreateBody({ facilityId: F, effectiveFrom: '2026-01-01', licenseNumber: 'X' }, 'FACILITY').ok, false)
  assert.equal(validateCreateBody({ facilityId: F, effectiveFrom: '2026-01-01', id: F }, 'FACILITY').ok, false)
  assert.equal(validateCreateBody({ facilityId: F, effectiveFrom: '2026-01-01', clinicianId: F }, 'FACILITY').ok, false)
  assert.equal(validateCreateBody({ facilityId: F, effectiveFrom: '2026-01-01', createdAt: 'x' }, 'FACILITY').ok, false)
  assert.equal(validateCreateBody({ specialtyId: S, effectiveFrom: '2026-01-01' }, 'FACILITY').ok, false, 'specialtyId is unknown here')
  assert.equal(validateCreateBody({ specialtyId: S, effectiveFrom: '2026-01-01' }, 'SPECIALTY').ok, true)
})

test('a close body carries exactly one strict date', () => {
  const outcome = validateCloseBody({ effectiveTo: '2026-12-31' })
  assert.deepEqual(outcome.ok && outcome.value, d('2026-12-31'))
  assert.equal(validateCloseBody({}).ok, false)
  assert.equal(validateCloseBody({ effectiveTo: null }).ok, false, 'a close cannot clear the date')
  assert.equal(validateCloseBody({ effectiveTo: '2026-02-31' }).ok, false)
  assert.equal(validateCloseBody({ effectiveTo: '2026-12-31', effectiveFrom: '2026-01-01' }).ok, false, 'the start cannot be changed')
  assert.equal(validateCloseBody({ effectiveTo: '2026-12-31', id: F }).ok, false)
})

test('closing is allowed once, never before the start, and never again afterwards', () => {
  const open = period('2026-01-01', null)
  assert.deepEqual(decideClose(open, d('2026-12-31')), { kind: 'close', effectiveTo: d('2026-12-31') })
  assert.deepEqual(decideClose(open, d('2026-01-01')), { kind: 'close', effectiveTo: d('2026-01-01') }, 'a same-day close')
  const early = decideClose(open, d('2025-12-31'))
  assert.equal(early.kind, 'rejected')
  const closed = decideClose(period('2026-01-01', '2026-06-30'), d('2026-12-31'))
  assert.equal(closed.kind, 'rejected')
  assert.equal(closed.kind === 'rejected' && /already closed/.test(closed.message), true)
})

test('resolution is zero, one or fail-closed — never a chosen winner', () => {
  assert.deepEqual(decideResolution([]), { status: 'NO_MATCH' })
  assert.deepEqual(decideResolution([{ id: F }]), { status: 'RESOLVED', assignment: { id: F } })
  const conflict = decideResolution([{ id: S }, { id: F }])
  assert.equal(conflict.status, 'INTEGRITY_CONFLICT')
  assert.deepEqual(conflict.status === 'INTEGRITY_CONFLICT' && conflict.matchedIds, [F, S], 'both ids are reported, sorted')
})

test('the DTOs expose date-only periods and the exact identifiers', () => {
  const base = {
    id: F,
    clinicianId: S,
    effectiveFrom: d('2026-01-01'),
    effectiveTo: null,
    createdAt: new Date('2026-01-01T08:00:00.000Z'),
    updatedAt: new Date('2026-01-02T08:00:00.000Z'),
  }
  const facility = toFacilityDto({ ...base, facilityId: F })
  assert.equal(facility.effectiveFrom, '2026-01-01')
  assert.equal(facility.effectiveTo, null)
  assert.equal(facility.facilityId, F)
  const specialty = toSpecialtyDto({ ...base, effectiveTo: d('2026-06-30'), specialtyId: S })
  assert.equal(specialty.effectiveTo, '2026-06-30')
  assert.equal(specialty.specialtyId, S)
  assert.equal('organizationId' in facility, false, 'ownership is not duplicated onto the assignment')
  assert.equal('status' in facility, false, 'currentness comes from the period, not a flag')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalModifierSignature, validateCreateRateBody, validateRetireBody } from './tariff-rate.validation.ts'

// A6.3 — tariff rate request shapes. Synthetic values only.

const SVC = '00000000-0000-4000-8000-0000000000a1'
const PROC = '00000000-0000-4000-8000-0000000000b1'
const base = { selectorKind: 'PROCEDURE_CODE', procedureCodeId: PROC, modifierCodes: [], currencyCode: 'AED', unitTariffAmount: '125.2500' }

test('a procedure rate and a service rate are accepted with exactly one identity', () => {
  const proc = validateCreateRateBody(base)
  assert.ok(proc.ok && proc.value.procedureCodeId === PROC && proc.value.serviceId === null && proc.value.unitCodeKey === null)
  const svc = validateCreateRateBody({ selectorKind: 'SERVICE', serviceId: SVC, modifierCodes: [], currencyCode: 'AED', unitTariffAmount: '0' })
  assert.ok(svc.ok && svc.value.serviceId === SVC && svc.value.unitTariffAmount === '0')
})

test('the selector must name exactly its own identity', () => {
  for (const body of [
    { ...base, selectorKind: 'SERVICE' },
    { ...base, serviceId: SVC },
    { ...base, selectorKind: 'BUNDLE' },
    { ...base, procedureCodeId: 'nope' },
    { ...base, procedureCodeId: undefined },
  ])
    assert.equal(validateCreateRateBody(body).ok, false, JSON.stringify(body))
})

test('amounts are non-negative decimal strings with at most 4 fractional digits; numbers are refused', () => {
  for (const amount of ['0', '0.0000', '125.25', '99999999999999.9999']) assert.ok(validateCreateRateBody({ ...base, unitTariffAmount: amount }).ok, amount)
  for (const amount of [125.25, '-1', '1.23456', '1e3', '', ' 1', 'NaN', 'Infinity', '123456789012345']) assert.equal(validateCreateRateBody({ ...base, unitTariffAmount: amount }).ok, false, String(amount))
})

test('only configured uppercase currencies are accepted', () => {
  assert.ok(validateCreateRateBody(base).ok)
  for (const currencyCode of ['aed', 'USD', 'AE', 'AEDX', 1]) assert.equal(validateCreateRateBody({ ...base, currencyCode }).ok, false, String(currencyCode))
})

test('modifiers are trimmed, unique and canonically sorted; blank or repeated codes are refused', () => {
  const value = validateCreateRateBody({ ...base, modifierCodes: [' M2 ', 'M1'] })
  assert.ok(value.ok && JSON.stringify(value.value.modifierSignature) === JSON.stringify(['M1', 'M2']))
  assert.deepEqual(canonicalModifierSignature(['b', 'A', 'a']), ['A', 'a', 'b'])
  for (const modifierCodes of [[''], ['M1', 'M1'], ['M1', ' M1'], 'M1', [1]]) assert.equal(validateCreateRateBody({ ...base, modifierCodes }).ok, false, JSON.stringify(modifierCodes))
})

test('a unit is trimmed and non-blank, or absent for an activity recorded without a unit', () => {
  const unit = validateCreateRateBody({ ...base, unitCodeKey: ' SYN-U ' })
  assert.ok(unit.ok && unit.value.unitCodeKey === 'SYN-U')
  for (const unitCodeKey of ['', '  ', 3]) assert.equal(validateCreateRateBody({ ...base, unitCodeKey }).ok, false, String(unitCodeKey))
})

test('server-owned fields are refused by name', () => {
  for (const field of ['tariffScheduleVersionId', 'rateContractVersion', 'removedAt', 'createdByUserId', 'createdAt', 'id', 'modifierSignature']) {
    const result = validateCreateRateBody({ ...base, [field]: 'x' })
    assert.ok(!result.ok && result.message.includes(field), field)
  }
  assert.equal(validateCreateRateBody({ ...base, price: '1' }).ok, false)
})

test('a retire body is empty or absent', () => {
  assert.ok(validateRetireBody(undefined).ok)
  assert.ok(validateRetireBody({}).ok)
  assert.equal(validateRetireBody({ removedAt: 'x' }).ok, false)
})

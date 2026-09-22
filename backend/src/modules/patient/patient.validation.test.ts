import test from 'node:test'
import assert from 'node:assert/strict'
import {
  changedFields,
  displayNameOf,
  isPatientUuid,
  normalizeDateOfBirth,
  normalizeEmail,
  normalizeMiddleName,
  normalizeMobilePhone,
  normalizeRequiredName,
  suppliedImmutableFields,
  toPatientDto,
  unknownFields,
  validateCreateInput,
  validateUpdateInput,
} from './patient.validation.ts'

// A4.1 — the pure validation contract. Synthetic values only.

const now = new Date('2026-09-21T09:00:00.000Z')
const d = (text: string) => new Date(`${text}T00:00:00.000Z`)

const validBody = {
  givenName: 'Maya',
  middleName: null,
  familyName: 'Khan',
  dateOfBirth: '1994-08-12',
  mobilePhone: '+971500000001',
  email: 'maya.synthetic@example.test',
}

test('a UUID-shaped id is accepted and anything else is rejected', () => {
  assert.equal(isPatientUuid('11111111-1111-4111-8111-111111111111'), true)
  assert.equal(isPatientUuid('not-a-uuid'), false)
  assert.equal(isPatientUuid(42), false)
})

test('required names trim, reject blanks, non-strings and control characters, and cap at 120', () => {
  assert.deepEqual(normalizeRequiredName('  Maya  ', 'givenName'), { ok: true, value: 'Maya' })
  assert.equal(normalizeRequiredName('   ', 'givenName').ok, false)
  assert.equal(normalizeRequiredName('', 'familyName').ok, false)
  assert.equal(normalizeRequiredName(7, 'givenName').ok, false)
  assert.equal(normalizeRequiredName(null, 'givenName').ok, false)
  assert.equal(normalizeRequiredName('Ma\nya', 'givenName').ok, false)
  assert.equal(normalizeRequiredName('x'.repeat(120), 'givenName').ok, true)
  assert.equal(normalizeRequiredName('x'.repeat(121), 'givenName').ok, false)
})

test('an optional middle name: absent, null and blank all become null; whitespace is trimmed', () => {
  assert.deepEqual(normalizeMiddleName(undefined), { ok: true, value: null })
  assert.deepEqual(normalizeMiddleName(null), { ok: true, value: null })
  assert.deepEqual(normalizeMiddleName('   '), { ok: true, value: null })
  assert.deepEqual(normalizeMiddleName('  Noor '), { ok: true, value: 'Noor' })
  assert.equal(normalizeMiddleName(5).ok, false)
})

test('an optional phone caps at 32 and rejects CR/LF; no UAE-specific format is imposed', () => {
  assert.deepEqual(normalizeMobilePhone(' +971 50 000 0001 '), { ok: true, value: '+971 50 000 0001' })
  assert.deepEqual(normalizeMobilePhone('  '), { ok: true, value: null })
  assert.deepEqual(normalizeMobilePhone('0000'), { ok: true, value: '0000' })
  assert.equal(normalizeMobilePhone('+9715\r\n0000001').ok, false)
  assert.equal(normalizeMobilePhone('9'.repeat(33)).ok, false)
})

test('an optional email keeps a conservative shape check and caps at 254', () => {
  assert.deepEqual(normalizeEmail(' maya.synthetic@example.test '), { ok: true, value: 'maya.synthetic@example.test' })
  assert.deepEqual(normalizeEmail(null), { ok: true, value: null })
  assert.deepEqual(normalizeEmail('   '), { ok: true, value: null })
  for (const bad of ['maya', 'maya@', '@example.test', 'maya@example', 'maya @example.test', 'maya@@example.test', 'maya@.test', 'maya@example..test', 'maya@example.test!', 'maya@exa mple.test'])
    assert.equal(normalizeEmail(bad).ok, false, bad)
  assert.equal(normalizeEmail(`${'a'.repeat(250)}@e.test`).ok, false)
  assert.equal(normalizeEmail('a+b.c@sub.example.test').ok, true)
})

test('dateOfBirth is a strict calendar date: impossible dates, timestamps and the future are rejected', () => {
  assert.deepEqual(normalizeDateOfBirth('1994-08-12', now), { ok: true, value: d('1994-08-12') })
  assert.equal(normalizeDateOfBirth('2026-02-31', now).ok, false)
  assert.equal(normalizeDateOfBirth('1994-13-01', now).ok, false)
  assert.equal(normalizeDateOfBirth('1994-08-12T00:00:00.000Z', now).ok, false)
  assert.equal(normalizeDateOfBirth('12/08/1994', now).ok, false)
  assert.equal(normalizeDateOfBirth(19940812, now).ok, false)
  assert.equal(normalizeDateOfBirth('2024-02-29', now).ok, true)
  assert.equal(normalizeDateOfBirth('2026-09-22', now).ok, false, 'tomorrow is in the future')
  assert.equal(normalizeDateOfBirth('2026-09-21', now).ok, true, 'today itself is allowed')
})

test('unknown and server-owned fields are reported, never silently persisted', () => {
  assert.deepEqual(unknownFields({ givenName: 'Maya', gender: 'F', payerId: 'x' }).sort(), ['gender', 'payerId'])
  assert.deepEqual(unknownFields(validBody), [])
  assert.deepEqual(suppliedImmutableFields({ id: 'x', organizationId: 'y', givenName: 'Maya' }), ['id', 'organizationId'])
  assert.deepEqual(suppliedImmutableFields({ createdAt: 'x', updatedAt: 'y' }), ['createdAt', 'updatedAt'])
})

test('a valid create body normalizes into the stored shape', () => {
  const outcome = validateCreateInput({ ...validBody, givenName: ' Maya ', middleName: '  ' }, now)
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.ok && outcome.value, {
    givenName: 'Maya',
    middleName: null,
    familyName: 'Khan',
    dateOfBirth: d('1994-08-12'),
    mobilePhone: '+971500000001',
    email: 'maya.synthetic@example.test',
  })
})

test('a create body is rejected for missing names, unknown fields, server-owned fields or a bad date', () => {
  assert.equal(validateCreateInput({ ...validBody, givenName: '' }, now).ok, false)
  assert.equal(validateCreateInput({ ...validBody, familyName: undefined }, now).ok, false)
  assert.equal(validateCreateInput({ ...validBody, nationality: 'AE' }, now).ok, false)
  assert.equal(validateCreateInput({ ...validBody, organizationId: '11111111-1111-4111-8111-111111111111' }, now).ok, false)
  assert.equal(validateCreateInput({ ...validBody, dateOfBirth: '2030-01-01' }, now).ok, false)
  assert.equal(validateCreateInput(null, now).ok, false)
  assert.equal(validateCreateInput([], now).ok, false)
})

test('a validation message never echoes the submitted value back', () => {
  const outcome = validateCreateInput({ ...validBody, email: 'maya.secret@example.test!' }, now)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.message.includes('maya.secret'), false)
  const dob = validateCreateInput({ ...validBody, dateOfBirth: '1994-13-45' }, now)
  assert.equal(dob.ok === false && dob.message.includes('1994-13-45'), false)
})

test('a patch carries only what it supplies, and an empty patch is refused', () => {
  const outcome = validateUpdateInput({ familyName: ' Khan-Ali ' }, now)
  assert.deepEqual(outcome.ok && outcome.value, { familyName: 'Khan-Ali' })
  const cleared = validateUpdateInput({ mobilePhone: null }, now)
  assert.deepEqual(cleared.ok && cleared.value, { mobilePhone: null })
  assert.equal(validateUpdateInput({}, now).ok, false)
  assert.equal(validateUpdateInput({ id: 'x' }, now).ok, false)
  assert.equal(validateUpdateInput({ createdAt: 'x' }, now).ok, false)
  assert.equal(validateUpdateInput({ gender: 'F' }, now).ok, false)
  assert.equal(validateUpdateInput({ dateOfBirth: '2026-02-31' }, now).ok, false)
})

test('changedFields reports only real differences, so a no-op patch can be refused without an audit', () => {
  const stored = {
    givenName: 'Maya',
    middleName: null,
    familyName: 'Khan',
    dateOfBirth: d('1994-08-12'),
    mobilePhone: '+971500000001',
    email: 'maya.synthetic@example.test',
  }
  assert.deepEqual(changedFields(stored, { givenName: 'Maya', familyName: 'Khan' }), [])
  assert.deepEqual(changedFields(stored, { familyName: 'Khan-Ali' }), ['familyName'])
  assert.deepEqual(changedFields(stored, { middleName: 'Noor', email: null }).sort(), ['email', 'middleName'])
  assert.deepEqual(changedFields(stored, { dateOfBirth: d('1994-08-12') }), [], 'the same date is not a change')
  assert.deepEqual(changedFields(stored, { dateOfBirth: d('1994-08-13') }), ['dateOfBirth'])
})

test('displayName is derived from the name parts and includes a middle name when present', () => {
  assert.equal(displayNameOf({ givenName: 'Maya', middleName: null, familyName: 'Khan' }), 'Maya Khan')
  assert.equal(displayNameOf({ givenName: 'Maya', middleName: 'Noor', familyName: 'Khan' }), 'Maya Noor Khan')
})

test('the DTO exposes a date-only dateOfBirth and the derived displayName', () => {
  const dto = toPatientDto({
    id: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
    givenName: 'Maya',
    middleName: 'Noor',
    familyName: 'Khan',
    dateOfBirth: d('1994-08-12'),
    mobilePhone: null,
    email: null,
    createdAt: new Date('2026-09-21T09:00:00.000Z'),
    updatedAt: new Date('2026-09-21T09:30:00.000Z'),
  })
  assert.equal(dto.dateOfBirth, '1994-08-12')
  assert.equal(dto.displayName, 'Maya Noor Khan')
  assert.equal(dto.createdAt, '2026-09-21T09:00:00.000Z')
  assert.equal('fullName' in dto, false, 'no redundant persisted name')
})

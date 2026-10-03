import test from 'node:test'
import assert from 'node:assert/strict'
import { requirementAuditSnapshot, toRequirementDto, validateCompletenessTarget, validateRequirementBody } from './evidence-requirement.validation.ts'

// A5.6 — the pure payload and target rules. Synthetic values only.

const body = (overrides: Record<string, unknown> = {}) => ({ documentTypes: ['SYNTHETIC_REPORT'], minimumCount: 1, sourceDateRequired: true, maxSourceAgeDays: 30, ...overrides })
const refused = (value: unknown) => {
  const outcome = validateRequirementBody(value)
  assert.equal(outcome.ok, false)
  return outcome.ok ? '' : outcome.message
}

test('a complete payload is accepted', () => {
  const outcome = validateRequirementBody(body())
  assert.equal(outcome.ok, true)
  if (outcome.ok) assert.deepEqual(outcome.value, { documentTypes: ['SYNTHETIC_REPORT'], minimumCount: 1, sourceDateRequired: true, maxSourceAgeDays: 30 })
})

test('document types are required, trimmed, case-preserved and unique', () => {
  assert.match(refused(body({ documentTypes: [] })), /non-empty/)
  assert.match(refused(body({ documentTypes: 'SYNTHETIC_REPORT' })), /non-empty array/)
  assert.match(refused(body({ documentTypes: ['  '] })), /documentTypes/)
  assert.match(refused(body({ documentTypes: ['A\nB'] })), /documentTypes/)
  assert.match(refused(body({ documentTypes: [7] })), /documentTypes/)
  const trimmed = validateRequirementBody(body({ documentTypes: ['  Report-a  ', 'REPORT-A'] }))
  assert.equal(trimmed.ok, true)
  if (trimmed.ok) assert.deepEqual(trimmed.value.documentTypes, ['Report-a', 'REPORT-A'])
  assert.match(refused(body({ documentTypes: ['X', ' X '] })), /repeat/)
})

test('minimumCount is a positive integer', () => {
  for (const bad of [0, -1, 1.5, '1', null, undefined]) assert.match(refused(body({ minimumCount: bad })), /minimumCount/, String(bad))
  assert.equal(validateRequirementBody(body({ minimumCount: 3 })).ok, true)
})

test('sourceDateRequired is a strict boolean', () => {
  for (const bad of ['true', 1, null, undefined]) assert.match(refused(body({ sourceDateRequired: bad })), /sourceDateRequired/, String(bad))
})

test('maxSourceAgeDays may be null, zero or positive — never negative or fractional', () => {
  for (const ok of [null, undefined, 0, 365]) assert.equal(validateRequirementBody(body({ maxSourceAgeDays: ok })).ok, true, String(ok))
  for (const bad of [-1, 1.5, '30']) assert.match(refused(body({ maxSourceAgeDays: bad })), /maxSourceAgeDays/, String(bad))
})

test('a freshness limit requires a source date', () => {
  assert.match(refused(body({ sourceDateRequired: false, maxSourceAgeDays: 30 })), /requires sourceDateRequired/)
  assert.equal(validateRequirementBody(body({ sourceDateRequired: false, maxSourceAgeDays: null })).ok, true)
})

test('scope and server-owned fields are refused by name', () => {
  for (const field of ['ruleVersionId', 'id', 'payerId', 'providerContractId', 'serviceId', 'diagnosisCodeId', 'jurisdictionCode'])
    assert.match(refused(body({ [field]: 'x' })), new RegExp(field), field)
  assert.match(refused(body({ price: 1 })), /unknown field/)
  assert.match(refused(null), /object/)
})

test('the DTO lists document types in a stable order', () => {
  const dto = toRequirementDto({
    id: '11111111-0000-4000-8000-000000000001', ruleVersionId: '22222222-0000-4000-8000-000000000001', minimumCount: 1,
    sourceDateRequired: false, maxSourceAgeDays: null, createdAt: new Date('2026-06-01T00:00:00.000Z'),
    documentTypes: [{ documentType: 'b' }, { documentType: 'B' }, { documentType: 'a' }],
  })
  assert.deepEqual(dto.documentTypes, ['B', 'a', 'b'])
})

test('the audit snapshot carries identity only', () => {
  const snapshot = requirementAuditSnapshot({ id: 'x', ruleVersionId: 'y', createdAt: new Date('2026-06-01T00:00:00.000Z') })
  assert.deepEqual(Object.keys(snapshot).sort(), ['createdAt', 'id', 'ruleVersionId'])
})

test('the completeness target accepts only the two exact-row references', () => {
  assert.deepEqual(validateCompletenessTarget(undefined), { ok: true, value: { encounterActivityId: null, encounterDiagnosisId: null } })
  assert.deepEqual(validateCompletenessTarget({}), { ok: true, value: { encounterActivityId: null, encounterDiagnosisId: null } })
  const id = '33333333-0000-4000-8000-000000000001'
  assert.deepEqual(validateCompletenessTarget({ encounterActivityId: id, encounterDiagnosisId: null }), { ok: true, value: { encounterActivityId: id, encounterDiagnosisId: null } })
  assert.equal(validateCompletenessTarget({ encounterActivityId: 'nope' }).ok, false)
  for (const forged of ['serviceId', 'procedureCodeId', 'diagnosisCodeId', 'payerId', 'providerContractId', 'tariffScheduleVersionId', 'businessDate', 'ruleVersionId', 'evidenceArtifactVersionId'])
    assert.equal(validateCompletenessTarget({ [forged]: id }).ok, false, forged)
  assert.equal(validateCompletenessTarget([]).ok, false)
})

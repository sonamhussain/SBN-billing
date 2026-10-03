import test from 'node:test'
import assert from 'node:assert/strict'
import { findSensitiveEcho, isFindingCode, validateContextSnapshot, validateFindingDraft, validateRunDraft } from './validation-run.validation.ts'

// A5.7 — the pure draft rules. Synthetic values only.

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const context = (overrides: Record<string, unknown> = {}) => ({
  serviceDate: '2026-06-15',
  facilityId: ID(1),
  facilityRegulatoryProfileId: ID(2),
  insuranceMembershipId: null,
  payerId: null,
  tpaId: null,
  networkId: null,
  insuranceProductId: null,
  providerContractId: null,
  tariffScheduleId: null,
  tariffScheduleVersionId: null,
  ...overrides,
})
const finding = (overrides: Record<string, unknown> = {}) => ({ layer: 'TECHNICAL', outcome: 'PASS', findingCode: 'SYNTHETIC_CHECK', message: 'Synthetic check passed.', ...overrides })
const draft = (overrides: Record<string, unknown> = {}) => ({ encounterId: ID(9), contextSnapshot: context(), validatorVersion: 'A5.7-SYNTHETIC-1', findings: [finding()], ...overrides })

const refused = (value: unknown) => {
  const outcome = validateRunDraft(value)
  assert.equal(outcome.ok, false)
  return outcome.ok ? '' : outcome.message
}
const refusedFinding = (value: unknown) => {
  const outcome = validateFindingDraft(value, 0)
  assert.equal(outcome.ok, false)
  return outcome.ok ? '' : outcome.message
}

test('a complete draft is accepted and every reference is made explicit', () => {
  const outcome = validateRunDraft(draft())
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.value.findings.length, 1)
  const [only] = outcome.value.findings
  assert.equal(only.fieldPath, null)
  assert.equal(only.ruleVersionId, null)
  assert.equal(only.evidenceArtifactVersionId, null)
  assert.deepEqual(outcome.value.contextSnapshot, context())
})

test('a run needs at least one finding and at most 1000', () => {
  assert.match(refused(draft({ findings: [] })), /at least one/)
  assert.match(refused(draft({ findings: 'x' })), /array/)
  assert.match(refused(draft({ findings: Array.from({ length: 1001 }, () => finding()) })), /at most 1000/)
  assert.equal(validateRunDraft(draft({ findings: Array.from({ length: 1000 }, () => finding()) })).ok, true)
})

test('server-owned run fields are refused by name', () => {
  for (const field of ['id', 'evaluatedAt', 'createdAt', 'createdByUserId', 'organizationId', 'status', 'overallOutcome', 'readiness', 'isCurrent', 'isLatest', 'claimLineId', 'payerAccepted'])
    assert.match(refused(draft({ [field]: 'x' })), /server-owned/, field)
  assert.match(refused(draft({ extra: 1 })), /unknown field/)
})

test('server-owned finding fields are refused by name', () => {
  for (const field of ['id', 'sequence', 'validationRunId', 'createdAt', 'claimLineId']) assert.match(refusedFinding(finding({ [field]: 1 })), /server-owned/, field)
  assert.match(refusedFinding(finding({ severity: 'HIGH' })), /unknown field/)
})

test('every layer and outcome of the controlled vocabularies is accepted, nothing else', () => {
  for (const layer of ['TECHNICAL', 'CODING', 'COVERAGE', 'CONTRACT', 'EVIDENCE']) assert.equal(validateFindingDraft(finding({ layer }), 0).ok, true, layer)
  for (const outcome of ['PASS', 'WARNING', 'RESTRICT', 'FAIL']) assert.equal(validateFindingDraft(finding({ outcome }), 0).ok, true, outcome)
  for (const layer of ['technical', 'READINESS', '', null]) assert.match(refusedFinding(finding({ layer })), /layer/)
  for (const outcome of ['pass', 'BLOCK', 'READY', '', null]) assert.match(refusedFinding(finding({ outcome })), /outcome/)
})

test('findingCode is an uppercase stable token of at most 96 characters', () => {
  assert.equal(isFindingCode('A'), true)
  assert.equal(isFindingCode('MISSING_MEMBERSHIP_2'), true)
  assert.equal(isFindingCode(`A${'B'.repeat(95)}`), true)
  for (const code of ['', ' ', 'missing', '1ABC', '_ABC', 'ABC-DEF', 'ABC DEF', 'ABC\n', `A${'B'.repeat(96)}`, 7, null]) assert.equal(isFindingCode(code), false, String(code))
})

test('message is required, trimmed, single-line and at most 512 characters', () => {
  for (const message of ['', '   ', 'a\nb', 'a\tb', 'x'.repeat(513), 7, undefined]) assert.match(refusedFinding(finding({ message })), /message/)
  const trimmed = validateFindingDraft(finding({ message: '  Synthetic.  ' }), 0)
  assert.equal(trimmed.ok, true)
  if (trimmed.ok) assert.equal(trimmed.value.message, 'Synthetic.')
  assert.equal(validateFindingDraft(finding({ message: 'é'.repeat(512) }), 0).ok, true)
})

test('fieldPath is optional, and safe and bounded when present', () => {
  assert.equal(validateFindingDraft(finding({ fieldPath: null }), 0).ok, true)
  const path = validateFindingDraft(finding({ fieldPath: ` encounter.activities[${ID(3)}].procedureCodeId ` }), 0)
  assert.equal(path.ok, true)
  if (path.ok) assert.equal(path.value.fieldPath, `encounter.activities[${ID(3)}].procedureCodeId`)
  for (const fieldPath of ['', '  ', 'a\u0000b', 'a\nb', 'p'.repeat(257), 3]) assert.match(refusedFinding(finding({ fieldPath })), /fieldPath/)
})

test('provenance and target references are UUIDs or null', () => {
  for (const field of ['ruleVersionId', 'governingSourceVersionId', 'referenceDatasetVersionId', 'encounterActivityId', 'evidenceArtifactVersionId']) {
    assert.match(refusedFinding(finding({ [field]: 'not-a-uuid' })), new RegExp(field))
    assert.equal(validateFindingDraft(finding({ [field]: ID(4) }), 0).ok, true)
  }
  const many = validateFindingDraft(finding({ encounterActivityId: ID(5), authorizationLineId: ID(6), evidenceRequirementId: ID(7) }), 0)
  assert.equal(many.ok, true)
})

test('validatorVersion is a required, trimmed label of at most 96 characters', () => {
  for (const validatorVersion of ['', '  ', 'v\n1', 'v'.repeat(97), 1, undefined]) assert.match(refused(draft({ validatorVersion })), /validatorVersion/)
  const trimmed = validateRunDraft(draft({ validatorVersion: '  A5.8-1  ' }))
  assert.equal(trimmed.ok, true)
  if (trimmed.ok) assert.equal(trimmed.value.validatorVersion, 'A5.8-1')
})

test('the context snapshot states every key, with a strict date and UUIDs', () => {
  assert.equal(validateContextSnapshot(context({ insuranceMembershipId: ID(5), payerId: ID(6) })).ok, true)
  const { tpaId: _omitted, ...missing } = context()
  assert.equal(validateContextSnapshot(missing).ok, false)
  for (const serviceDate of ['2026-02-30', '15/06/2026', '2026-06-15T00:00:00Z', null]) assert.equal(validateContextSnapshot(context({ serviceDate })).ok, false, String(serviceDate))
  assert.equal(validateContextSnapshot(context({ facilityId: null })).ok, false)
  assert.equal(validateContextSnapshot(context({ facilityRegulatoryProfileId: null })).ok, false)
  assert.equal(validateContextSnapshot(context({ payerId: 'x' })).ok, false)
  assert.equal(validateContextSnapshot(context({ organizationId: ID(1) })).ok, false)
  assert.match(refused(draft({ encounterId: 'x' })), /encounterId/)
})

test('a message or field path echoing a sensitive value is found, case-insensitively', () => {
  const findings = [
    { ...finding(), fieldPath: null, message: 'Member mem-SYN-123 is inactive.' },
  ] as never
  assert.match(findSensitiveEcho(findings, ['MEM-syn-123']) ?? '', /findings\[0\]\.message/)
  assert.equal(findSensitiveEcho(findings, ['OTHER-VALUE', '  ']), null)
  assert.equal(findSensitiveEcho(findings, []), null)
  const inPath = [{ ...finding(), fieldPath: 'membership.POL-77', message: 'Synthetic.' }] as never
  assert.match(findSensitiveEcho(inPath, ['pol-77']) ?? '', /fieldPath/)
})

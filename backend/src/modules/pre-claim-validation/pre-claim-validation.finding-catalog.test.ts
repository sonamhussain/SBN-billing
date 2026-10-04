import test from 'node:test'
import assert from 'node:assert/strict'
import { scopeOutcomes } from '../authorization-line/authorization-line.types.ts'
import { FINDING_CODE_PATTERN, MAX_MESSAGE_LENGTH } from '../validation-run/validation-run.types.ts'
import {
  activitySummaryCode,
  contractReasonCodes,
  draft,
  type EligibilityRow,
  findingCatalog,
  orderFindings,
  requirementStateCodes,
  scopeOutcomeCodes,
  selectEligibility,
} from './pre-claim-validation.finding-catalog.ts'

// A5.8 — the pure A5-VAL-1 rules. Synthetic values only.

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const DAY = new Date('2026-06-15T00:00:00.000Z')
const NOW = new Date('2026-06-20T10:00:00.000Z')
const context = { insuranceMembershipId: ID(1), payerId: ID(2), tpaId: null, networkId: null, insuranceProductId: null, serviceDate: DAY }
const row = (overrides: Partial<EligibilityRow> = {}): EligibilityRow => ({
  id: ID(10),
  status: 'ELIGIBLE',
  validThrough: new Date('2026-06-30T00:00:00.000Z'),
  authorizationRequired: false,
  ...context,
  ...overrides,
})

test('every catalogue entry is a valid A5.7 finding with a bounded message', () => {
  for (const [code, entry] of Object.entries(findingCatalog)) {
    assert.match(code, FINDING_CODE_PATTERN, code)
    assert.ok(['TECHNICAL', 'CODING', 'COVERAGE', 'CONTRACT', 'EVIDENCE'].includes(entry.layer), code)
    assert.ok(['PASS', 'WARNING', 'RESTRICT', 'FAIL'].includes(entry.outcome), code)
    assert.ok(entry.message.length > 0 && [...entry.message].length <= MAX_MESSAGE_LENGTH && entry.message === entry.message.trim(), code)
    assert.ok(code.startsWith(entry.layer), `${code} belongs to ${entry.layer}`)
  }
})

test('the doc outcome mappings are exact', () => {
  const outcome = (code: keyof typeof findingCatalog) => findingCatalog[code].outcome
  assert.deepEqual(
    scopeOutcomes.map((s) => outcome(scopeOutcomeCodes[s])),
    ['PASS', 'FAIL', 'RESTRICT', 'FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL', 'RESTRICT', 'FAIL'],
  )
  assert.deepEqual(Object.values(contractReasonCodes).map(outcome), ['FAIL', 'FAIL', 'RESTRICT', 'FAIL', 'RESTRICT', 'RESTRICT'])
  assert.deepEqual(['SATISFIED', 'MISSING', 'INCOMPLETE'].map((s) => outcome(requirementStateCodes[s])), ['PASS', 'FAIL', 'RESTRICT'])
  assert.equal(outcome('EVIDENCE_SOURCE_DATE_MISSING'), 'RESTRICT')
  assert.equal(outcome('EVIDENCE_STALE'), 'RESTRICT')
  assert.equal(outcome('EVIDENCE_REQUIREMENT_RESOLUTION_BLOCKED'), 'RESTRICT')
  assert.equal(outcome('EVIDENCE_REQUIREMENT_CONFIGURATION_INCOMPLETE'), 'FAIL')
  assert.equal(outcome('TECHNICAL_CONTEXT_INTEGRITY_FAIL'), 'FAIL')
  assert.equal('TARIFF_INTEGRITY_CONFLICT' in contractReasonCodes, false)
  assert.equal('A4_INTEGRITY_CONFLICT' in contractReasonCodes, false)
})

test('only an exact-context verification is a candidate', () => {
  assert.equal(selectEligibility([], context, NOW).code, 'COVERAGE_ELIGIBILITY_MISSING')
  for (const overrides of [{ payerId: ID(9) }, { tpaId: ID(9) }, { insuranceMembershipId: ID(9) }, { serviceDate: new Date('2026-06-16T00:00:00.000Z') }])
    assert.equal(selectEligibility([row(overrides)], context, NOW).code, 'COVERAGE_ELIGIBILITY_MISSING', JSON.stringify(overrides))
})

test('exactly one fresh verification decides by its status', () => {
  assert.equal(selectEligibility([row()], context, NOW).code, 'COVERAGE_ELIGIBILITY_ELIGIBLE')
  assert.equal(selectEligibility([row()], context, NOW).selected?.id, ID(10))
  assert.equal(selectEligibility([row({ status: 'INELIGIBLE' })], context, NOW).code, 'COVERAGE_ELIGIBILITY_INELIGIBLE')
  assert.equal(selectEligibility([row({ status: 'UNKNOWN' })], context, NOW).code, 'COVERAGE_ELIGIBILITY_UNKNOWN')
  // A stale row beside the one fresh row changes nothing.
  assert.equal(selectEligibility([row({ id: ID(11), validThrough: new Date('2026-06-01T00:00:00.000Z') }), row()], context, NOW).selected?.id, ID(10))
})

test('several fresh verifications are ambiguous in every order; no latest winner', () => {
  const a = row({ id: ID(10) })
  const b = row({ id: ID(11), status: 'INELIGIBLE' })
  for (const rows of [[a, b], [b, a]]) {
    const selection = selectEligibility(rows, context, NOW)
    assert.equal(selection.code, 'COVERAGE_ELIGIBILITY_AMBIGUOUS')
    assert.equal(selection.selected, null)
  }
})

test('stale and unknown freshness are reported, never resolved', () => {
  assert.equal(selectEligibility([row({ validThrough: new Date('2026-06-01T00:00:00.000Z') })], context, NOW).code, 'COVERAGE_ELIGIBILITY_STALE')
  assert.equal(selectEligibility([row({ validThrough: null })], context, NOW).code, 'COVERAGE_ELIGIBILITY_FRESHNESS_UNKNOWN')
  assert.equal(selectEligibility([row({ validThrough: null }), row({ id: ID(11), validThrough: new Date('2026-06-01T00:00:00.000Z') })], context, NOW).code, 'COVERAGE_ELIGIBILITY_STALE')
})

test('an activity summary counts MATCHED across cases without choosing one', () => {
  assert.equal(activitySummaryCode(['MATCHED']), 'COVERAGE_AUTHORIZATION_ACTIVITY_SATISFIED')
  assert.equal(activitySummaryCode(['MATCHED', 'NO_MATCH', 'HEADER_STATUS_NOT_APPROVED']), 'COVERAGE_AUTHORIZATION_ACTIVITY_SATISFIED')
  assert.equal(activitySummaryCode(['MATCHED', 'MATCHED']), 'COVERAGE_AUTHORIZATION_ACTIVITY_AMBIGUOUS')
  assert.equal(activitySummaryCode(['NO_MATCH', 'AMBIGUOUS']), 'COVERAGE_AUTHORIZATION_ACTIVITY_UNSATISFIED')
  assert.equal(activitySummaryCode([]), 'COVERAGE_AUTHORIZATION_ACTIVITY_UNSATISFIED')
})

test('a system finding carries no provenance reference', () => {
  const finding = draft('TECHNICAL_CONTEXT_VALID')
  assert.equal(finding.provenance, null)
  assert.equal(finding.ruleVersionId, null)
  assert.equal(finding.governingSourceVersionId, null)
  assert.equal(finding.referenceDatasetVersionId, null)
})

test('findings are ordered by layer, code, then targets nulls-first, independent of input order', () => {
  const findings = [
    draft('EVIDENCE_NO_REQUIREMENTS_APPLY'),
    draft('COVERAGE_AUTHORIZATION_SCOPE_MATCHED', { encounterActivityId: ID(5) }),
    draft('COVERAGE_AUTHORIZATION_SCOPE_MATCHED', { encounterActivityId: ID(3) }),
    draft('COVERAGE_AUTHORIZATION_SCOPE_MATCHED'),
    draft('CODING_OBSERVATION_INVARIANTS_PASS'),
    draft('TECHNICAL_CONTEXT_VALID'),
    draft('CODING_ACTIVITY_INVARIANTS_PASS'),
    draft('CONTRACT_CONTEXT_RESOLVED'),
  ]
  const expected = [
    'TECHNICAL_CONTEXT_VALID',
    'CODING_ACTIVITY_INVARIANTS_PASS',
    'CODING_OBSERVATION_INVARIANTS_PASS',
    'COVERAGE_AUTHORIZATION_SCOPE_MATCHED:-',
    `COVERAGE_AUTHORIZATION_SCOPE_MATCHED:${ID(3)}`,
    `COVERAGE_AUTHORIZATION_SCOPE_MATCHED:${ID(5)}`,
    'CONTRACT_CONTEXT_RESOLVED',
    'EVIDENCE_NO_REQUIREMENTS_APPLY',
  ]
  const key = (f: ReturnType<typeof draft>) => (f.findingCode === 'COVERAGE_AUTHORIZATION_SCOPE_MATCHED' ? `${f.findingCode}:${f.encounterActivityId ?? '-'}` : f.findingCode)
  assert.deepEqual(orderFindings(findings).map(key), expected)
  assert.deepEqual(orderFindings([...findings].reverse()).map(key), expected)
})

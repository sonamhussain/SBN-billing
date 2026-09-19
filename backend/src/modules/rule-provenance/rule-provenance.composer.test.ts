import test from 'node:test'
import assert from 'node:assert/strict'
import { decidePackVersionUsable, precheckProvenanceInput, toProvenanceContext } from './rule-provenance.validation.ts'
import { provenanceCompositionErrorCodes, provenanceContractVersion } from './rule-provenance.types.ts'
import { APPLICABILITY_DIMENSIONS_V2 } from '../../shared/rules/applicability-context-v2.ts'
import type { RuleResolutionDto } from '../rule-resolution/rule-resolution.types.ts'

// The pure core of the internal A3-PROV-1 composer. Everything that needs exact-ID lookups is
// proven against real rows by test:a3:provenance.

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '22222222-2222-4222-8222-222222222222'
const U = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`

function d(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`)
}

function resolved(overrides: Partial<RuleResolutionDto> = {}): RuleResolutionDto {
  return {
    resolutionStatus: 'RESOLVED',
    precedencePolicyVersion: 'A3-PREC-1',
    ruleDefinitionId: U(1),
    ruleVersionId: U(2),
    ruleVersion: '1',
    governingBindingId: U(3),
    governingSourceInterpretationId: U(4),
    governingSourceVersionId: U(5),
    governingSourceId: U(6),
    supportingBindingIds: [U(7)],
    matchedApplicabilityIds: [U(8)],
    businessDate: '2026-03-15',
    jurisdictionCode: 'AE-DU',
    specificityScore: 1,
    historicalOnly: false,
    blockers: [],
    ...overrides,
  }
}

const baseInput = { authoritativeContext: {}, organizationId: ORG, evaluationTimestamp: new Date('2026-09-19T10:00:00Z') }

test('the contract version is A3-PROV-1 and the internal errors are exactly the four in the package', () => {
  assert.equal(provenanceContractVersion, 'A3-PROV-1')
  assert.deepEqual([...provenanceCompositionErrorCodes], [
    'RESOLUTION_NOT_RESOLVED',
    'PACK_VERSION_NOT_USABLE',
    'PACK_MEMBERSHIP_MISMATCH',
    'PROVENANCE_INVARIANT_VIOLATION',
  ])
})

test('T36 every non-RESOLVED A3.8 status yields RESOLUTION_NOT_RESOLVED and no provenance', () => {
  for (const status of ['REFERENCE_ONLY', 'NO_MATCH', 'BLOCKED_RULE_VERSION_CONFLICT', 'BLOCKED_SOURCE_PRECEDENCE_CONFLICT', 'BLOCKED_EXECUTABILITY'] as const) {
    const outcome = precheckProvenanceInput({ ...baseInput, resolution: resolved({ resolutionStatus: status }) })
    assert.equal(outcome.ok, false, status)
    assert.equal(!outcome.ok && outcome.error.code, 'RESOLUTION_NOT_RESOLVED', status)
  }
})

test('a RESOLVED result missing any winner ID fails closed as an invariant violation', () => {
  for (const key of ['ruleVersionId', 'ruleVersion', 'governingBindingId', 'governingSourceInterpretationId', 'governingSourceVersionId', 'governingSourceId'] as const) {
    const outcome = precheckProvenanceInput({ ...baseInput, resolution: resolved({ [key]: null }) })
    assert.equal(!outcome.ok && outcome.error.code, 'PROVENANCE_INVARIANT_VIOLATION', key)
  }
})

test('non-UUID IDs, a non-UUID organization, an invalid instant or a bad businessDate fail closed', () => {
  const cases = [
    { ...baseInput, resolution: resolved({ governingSourceId: 'EXT-123' }) },
    { ...baseInput, resolution: resolved({ supportingBindingIds: ['not-a-uuid'] }) },
    { ...baseInput, resolution: resolved({ matchedApplicabilityIds: ['x'] }) },
    { ...baseInput, organizationId: 'org-1', resolution: resolved() },
    { ...baseInput, evaluationTimestamp: new Date(Number.NaN), resolution: resolved() },
    { ...baseInput, resolution: resolved({ businessDate: '2026-02-31' }) },
  ]
  for (const input of cases) assert.equal(!precheckProvenanceInput(input).ok && 'fail', 'fail')
})

test('a non-UUID rulePackVersionId is PACK_VERSION_NOT_USABLE; null and absent mean no pack', () => {
  const bad = precheckProvenanceInput({ ...baseInput, resolution: resolved(), rulePackVersionId: 'pack-1' })
  assert.equal(!bad.ok && bad.error.code, 'PACK_VERSION_NOT_USABLE')
  const none = precheckProvenanceInput({ ...baseInput, resolution: resolved(), rulePackVersionId: null })
  assert.equal(none.ok && none.value.rulePackVersionId, null)
  const absent = precheckProvenanceInput({ ...baseInput, resolution: resolved() })
  assert.equal(absent.ok && absent.value.rulePackVersionId, null)
})

test('a valid RESOLVED input passes the gate with its exact winner IDs', () => {
  const outcome = precheckProvenanceInput({ ...baseInput, resolution: resolved() })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok && outcome.value.fields.governingSourceVersionId, U(5))
  assert.equal(outcome.ok && outcome.value.businessDate.toISOString(), '2026-03-15T00:00:00.000Z')
})

test('T42 the provenance context always carries all twelve dimensions, copied exactly, null when absent', () => {
  const ctx = toProvenanceContext({ facilityId: U(10), facilityRegulatoryProfileId: U(11), providerContractId: U(12) })
  assert.deepEqual(Object.keys(ctx).sort(), [...APPLICABILITY_DIMENSIONS_V2].sort())
  assert.equal(ctx.facilityId, U(10))
  assert.equal(ctx.facilityRegulatoryProfileId, U(11))
  assert.equal(ctx.providerContractId, U(12))
  assert.equal(ctx.payerId, null)
  assert.equal(ctx.diagnosisCodeId, null)
})

// --- pack usability (T49, T50) -------------------------------------------------------------

const decision = { organizationId: ORG, jurisdictionCode: 'AE-DU', businessDate: d('2026-03-15') }
const usablePack = {
  effectiveFrom: d('2026-01-01'),
  effectiveTo: d('2026-12-31'),
  verificationStatus: 'VERIFIED',
  activationStatus: 'ACTIVE',
  rulePack: { organizationId: ORG, jurisdictionCode: 'AE-DU' },
}

test('an ACTIVE, VERIFIED, in-period pack of the same organization and jurisdiction is usable', () => {
  assert.deepEqual(decidePackVersionUsable(usablePack, decision), { usable: true })
})

test('T50 a SUPERSEDED pack version is usable for a date inside its own period', () => {
  assert.deepEqual(decidePackVersionUsable({ ...usablePack, activationStatus: 'SUPERSEDED' }, decision), { usable: true })
})

test('T49 each broken pack property makes it not usable', () => {
  const broken = [
    { ...usablePack, rulePack: { organizationId: OTHER_ORG, jurisdictionCode: 'AE-DU' } },
    { ...usablePack, rulePack: { organizationId: ORG, jurisdictionCode: 'AE-AZ' } },
    { ...usablePack, verificationStatus: 'UNVERIFIED', activationStatus: 'INACTIVE' },
    { ...usablePack, activationStatus: 'INACTIVE' },
    { ...usablePack, effectiveFrom: d('2026-06-01') },
    { ...usablePack, effectiveTo: d('2026-02-28') },
  ]
  for (const pack of broken) assert.equal(decidePackVersionUsable(pack, decision).usable, false, JSON.stringify(pack))
})

test('a SYSTEM_SHARED pack is usable by any organization when everything else holds', () => {
  assert.deepEqual(decidePackVersionUsable({ ...usablePack, rulePack: { organizationId: null, jurisdictionCode: 'ae-du' } }, decision), { usable: true })
})

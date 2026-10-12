import test from 'node:test'
import assert from 'node:assert/strict'
import { isClaimDiagnosisRole, validateCreateDiagnosisBody, validateDiagnosisOrderBody } from './claim-diagnosis.validation.ts'

// A6.2 — ClaimDiagnosis request shapes. Synthetic values only.

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'

test('the three canonical roles are accepted exactly', () => {
  for (const roleCode of ['PRIMARY', 'SECONDARY', 'ADMITTING']) {
    assert.deepEqual(validateCreateDiagnosisBody({ encounterDiagnosisId: A, roleCode }), { ok: true, value: { encounterDiagnosisId: A, roleCode } })
  }
})

test('a blank, lowercase, padded, invented or missing role is refused, never normalized', () => {
  for (const roleCode of ['', ' ', 'primary', ' PRIMARY', 'PRIMARY ', 'PRINCIPAL', 'DISCHARGE', 1, null, undefined]) {
    assert.equal(validateCreateDiagnosisBody({ encounterDiagnosisId: A, roleCode }).ok, false, String(roleCode))
    assert.equal(isClaimDiagnosisRole(roleCode), false, String(roleCode))
  }
  assert.equal(validateCreateDiagnosisBody({ encounterDiagnosisId: A }).ok, false)
})

test('server-owned and A2/A4.5 source facts are refused by name on diagnosis create', () => {
  for (const field of ['sequence', 'claimId', 'claimDiagnosisContractVersion', 'removedAt', 'createdByUserId', 'createdAt']) {
    const result = validateCreateDiagnosisBody({ encounterDiagnosisId: A, roleCode: 'PRIMARY', [field]: 'x' })
    assert.ok(!result.ok && result.message.includes(field) && result.message.includes('owned by the server'), field)
  }
  for (const field of ['diagnosisCodeId', 'code', 'displayName', 'icd10', 'isPrimary']) {
    const result = validateCreateDiagnosisBody({ encounterDiagnosisId: A, roleCode: 'PRIMARY', [field]: 'x' })
    assert.ok(!result.ok && result.message.includes(field), field)
  }
  assert.equal(validateCreateDiagnosisBody({ encounterDiagnosisId: 'not-a-uuid', roleCode: 'PRIMARY' }).ok, false)
})

test('a diagnosis order is a UUID list without duplicates', () => {
  assert.deepEqual(validateDiagnosisOrderBody({ claimDiagnosisIds: [B, A] }), { ok: true, value: [B, A] })
  assert.equal(validateDiagnosisOrderBody({ claimDiagnosisIds: [A, A] }).ok, false)
  assert.equal(validateDiagnosisOrderBody({ claimDiagnosisIds: [A], roleCode: 'PRIMARY' }).ok, false)
})

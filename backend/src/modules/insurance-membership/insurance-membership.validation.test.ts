import test from 'node:test'
import assert from 'node:assert/strict'
import {
  changedFields,
  coverageDatesCoherent,
  decideCommercialCoherence,
  isMembershipUuid,
  mergeMembership,
  normalizeMemberIdentifier,
  normalizePolicyIdentifier,
  toMembershipDto,
  validateCreateInput,
  validateUpdateInput,
  type CoherenceFacts,
  type MembershipWriteInput,
} from './insurance-membership.validation.ts'
import { insuranceMembershipAuditSnapshot } from '../audit/audit.snapshot.ts'

// A4.3 — the pure identifier, date, patch and commercial-coherence rules. Synthetic values only.

const d = (text: string) => new Date(`${text}T00:00:00.000Z`)
const ORG = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const PAYER = '11111111-1111-4111-8111-111111111111'
const PAYER2 = '11111111-1111-4111-8111-222222222222'
const TPA = '33333333-3333-4333-8333-333333333333'
const NET = '44444444-4444-4444-8444-444444444444'
const PROD = '55555555-5555-4555-8555-555555555555'
const MEMBER = 'SYN-MEMBER-001'

const stored: MembershipWriteInput = {
  payerId: PAYER,
  tpaId: TPA,
  networkId: NET,
  insuranceProductId: PROD,
  memberIdentifier: MEMBER,
  policyIdentifier: 'SYN-POLICY-001',
  coverageFrom: d('2026-01-01'),
  coverageTo: null,
}

test('a membership id must be UUID-shaped', () => {
  assert.equal(isMembershipUuid(PAYER), true)
  assert.equal(isMembershipUuid('not-a-uuid'), false)
  assert.equal(isMembershipUuid(42), false)
})

test('memberIdentifier is required, trimmed, case-preserved, ≤128 and free of control characters', () => {
  assert.deepEqual(normalizeMemberIdentifier('  syn-Member-001 '), { ok: true, value: 'syn-Member-001' })
  assert.equal(normalizeMemberIdentifier('A'.repeat(128)).ok, true)
  assert.equal(normalizeMemberIdentifier('A'.repeat(129)).ok, false)
  for (const bad of [undefined, null, 7, '', '   ', 'SYN\n001', 'SYN\t001', 'SYN\u0000001']) {
    assert.equal(normalizeMemberIdentifier(bad).ok, false, `rejects ${JSON.stringify(bad)}`)
  }
})

test('policyIdentifier is optional: absent, null and blank become null; bad shapes are rejected', () => {
  assert.deepEqual(normalizePolicyIdentifier(undefined), { ok: true, value: null })
  assert.deepEqual(normalizePolicyIdentifier(null), { ok: true, value: null })
  assert.deepEqual(normalizePolicyIdentifier('   '), { ok: true, value: null })
  assert.deepEqual(normalizePolicyIdentifier(' POL-1 '), { ok: true, value: 'POL-1' })
  assert.equal(normalizePolicyIdentifier('P'.repeat(129)).ok, false)
  assert.equal(normalizePolicyIdentifier(12).ok, false)
  assert.equal(normalizePolicyIdentifier('POL\r1').ok, false)
})

test('a validation message never echoes a submitted member or policy value', () => {
  const secret = 'SECRET-CARD-VALUE'
  const outcomes = [
    normalizeMemberIdentifier(`${secret}\n`),
    normalizeMemberIdentifier(secret.repeat(20)),
    normalizePolicyIdentifier(`${secret}\t`),
    validateCreateInput({ payerId: PAYER, memberIdentifier: `${secret}\n` }),
    validateUpdateInput({ policyIdentifier: secret.repeat(20) }),
  ]
  for (const outcome of outcomes) {
    assert.equal(outcome.ok, false)
    if (!outcome.ok) assert.equal(outcome.message.includes(secret), false)
  }
})

test('coverage dates: either may be unknown; when both exist the end may not precede the start', () => {
  assert.equal(coverageDatesCoherent(null, null), true)
  assert.equal(coverageDatesCoherent(null, d('2026-12-31')), true, 'an end with no start is a recorded fact')
  assert.equal(coverageDatesCoherent(d('2026-01-01'), null), true)
  assert.equal(coverageDatesCoherent(d('2026-01-01'), d('2026-01-01')), true, 'a one-day period')
  assert.equal(coverageDatesCoherent(d('2026-06-30'), d('2026-01-01')), false)
})

test('a minimal create needs only payerId and memberIdentifier; everything else becomes null', () => {
  const outcome = validateCreateInput({ payerId: PAYER, memberIdentifier: MEMBER })
  assert.deepEqual(outcome, {
    ok: true,
    value: { payerId: PAYER, tpaId: null, networkId: null, insuranceProductId: null, memberIdentifier: MEMBER, policyIdentifier: null, coverageFrom: null, coverageTo: null },
  })
})

test('a full create normalizes every field', () => {
  const outcome = validateCreateInput({
    payerId: PAYER,
    tpaId: TPA,
    networkId: NET,
    insuranceProductId: PROD,
    memberIdentifier: ` ${MEMBER} `,
    policyIdentifier: 'SYN-POLICY-001',
    coverageFrom: '2026-01-01',
    coverageTo: '2026-12-31',
  })
  assert.equal(outcome.ok, true)
  if (outcome.ok) {
    assert.equal(outcome.value.memberIdentifier, MEMBER)
    assert.equal(outcome.value.coverageTo?.toISOString().slice(0, 10), '2026-12-31')
  }
})

test('create rejects missing payer, bad UUIDs, strict-date violations and an inverted period', () => {
  const bad = [
    { memberIdentifier: MEMBER },
    { payerId: 'nope', memberIdentifier: MEMBER },
    { payerId: PAYER, tpaId: 'nope', memberIdentifier: MEMBER },
    { payerId: PAYER, networkId: 7, memberIdentifier: MEMBER },
    { payerId: PAYER, insuranceProductId: 'x', memberIdentifier: MEMBER },
    { payerId: PAYER, memberIdentifier: MEMBER, coverageFrom: '2026-02-31' },
    { payerId: PAYER, memberIdentifier: MEMBER, coverageFrom: '2026-01-01T00:00:00.000Z' },
    { payerId: PAYER, memberIdentifier: MEMBER, coverageTo: '31/12/2026' },
    { payerId: PAYER, memberIdentifier: MEMBER, coverageFrom: '2026-06-30', coverageTo: '2026-01-01' },
  ]
  for (const body of bad) assert.equal(validateCreateInput(body).ok, false, JSON.stringify(body))
  assert.equal(validateCreateInput(null).ok, false)
  assert.equal(validateCreateInput([]).ok, false)
})

test('create rejects server-owned and unknown fields, naming a forged patientId as server-owned', () => {
  const forged = validateCreateInput({ payerId: PAYER, memberIdentifier: MEMBER, patientId: PAYER })
  assert.equal(forged.ok, false)
  if (!forged.ok) assert.match(forged.message, /patientId/)
  for (const field of ['id', 'createdAt', 'updatedAt', 'eligible', 'primary', 'providerContractId', 'organizationId']) {
    assert.equal(validateCreateInput({ payerId: PAYER, memberIdentifier: MEMBER, [field]: 'x' }).ok, false, field)
  }
})

test('a patch carries only what it supplies; explicit null clears optional fields only', () => {
  assert.deepEqual(validateUpdateInput({ policyIdentifier: null, tpaId: null }), { ok: true, value: { policyIdentifier: null, tpaId: null } })
  assert.deepEqual(validateUpdateInput({ coverageTo: null, networkId: null, insuranceProductId: null }), {
    ok: true,
    value: { coverageTo: null, networkId: null, insuranceProductId: null },
  })
  assert.equal(validateUpdateInput({ payerId: null }).ok, false, 'payer cannot be cleared')
  assert.equal(validateUpdateInput({ memberIdentifier: null }).ok, false, 'member id cannot be cleared')
  assert.equal(validateUpdateInput({}).ok, false, 'empty patch')
  assert.equal(validateUpdateInput({ id: PAYER }).ok, false)
  assert.equal(validateUpdateInput({ patientId: PAYER }).ok, false)
  assert.equal(validateUpdateInput({ createdAt: '2026-01-01' }).ok, false)
  assert.equal(validateUpdateInput({ status: 'ACTIVE' }).ok, false)
})

test('the merged state is what a patch is judged on', () => {
  const merged = mergeMembership(stored, { payerId: PAYER2, networkId: null })
  assert.equal(merged.payerId, PAYER2)
  assert.equal(merged.insuranceProductId, PROD, 'an untouched product stays, so a payer change can be judged against it')
  assert.equal(merged.networkId, null)
  assert.equal(merged.memberIdentifier, MEMBER)
})

test('changedFields reports only real differences, so a no-op patch can be refused without audit', () => {
  assert.deepEqual(changedFields(stored, { memberIdentifier: MEMBER, coverageFrom: d('2026-01-01') }), [])
  assert.deepEqual(changedFields(stored, { memberIdentifier: 'SYN-MEMBER-002', coverageTo: d('2026-12-31') }), ['memberIdentifier', 'coverageTo'])
  assert.deepEqual(changedFields(stored, { policyIdentifier: null, tpaId: null }), ['tpaId', 'policyIdentifier'])
})

const coherent: CoherenceFacts = {
  patientOrganizationId: ORG,
  payer: { organizationId: ORG },
  tpa: { organizationId: ORG },
  network: { organizationId: ORG },
  product: { organizationId: ORG, payerId: PAYER },
  productNetworkExists: true,
  payerId: PAYER,
}

test('commercial coherence: a same-organization, same-payer, related context is accepted', () => {
  assert.deepEqual(decideCommercialCoherence(coherent), { ok: true })
  assert.deepEqual(
    decideCommercialCoherence({ ...coherent, tpa: 'not-supplied', network: 'not-supplied', product: 'not-supplied', productNetworkExists: 'not-applicable' }),
    { ok: true },
    'payer only',
  )
  assert.deepEqual(decideCommercialCoherence({ ...coherent, product: 'not-supplied', productNetworkExists: 'not-applicable' }), { ok: true }, 'network without product')
  assert.deepEqual(decideCommercialCoherence({ ...coherent, network: 'not-supplied', productNetworkExists: 'not-applicable' }), { ok: true }, 'product without network')
})

test('commercial coherence: missing and foreign masters are refused identically as not found', () => {
  const cases: [Partial<CoherenceFacts>, string][] = [
    [{ payer: null }, 'payer not found'],
    [{ payer: { organizationId: OTHER } }, 'payer not found'],
    [{ tpa: { organizationId: OTHER } }, 'tpa not found'],
    [{ network: null }, 'network not found'],
    [{ network: { organizationId: OTHER } }, 'network not found'],
    [{ product: { organizationId: OTHER, payerId: PAYER } }, 'insurance product not found'],
  ]
  for (const [patch, message] of cases) {
    assert.deepEqual(decideCommercialCoherence({ ...coherent, ...patch }), { ok: false, code: 'NOT_FOUND', message })
  }
})

test('commercial coherence: product/payer and product/network contradictions are validation errors', () => {
  const wrongPayer = decideCommercialCoherence({ ...coherent, product: { organizationId: ORG, payerId: PAYER2 } })
  assert.equal(wrongPayer.ok, false)
  if (!wrongPayer.ok) assert.equal(wrongPayer.code, 'VALIDATION_ERROR')
  const noRelation = decideCommercialCoherence({ ...coherent, productNetworkExists: false })
  assert.equal(noRelation.ok, false)
  if (!noRelation.ok) assert.match(noRelation.message, /ProductNetwork/)
})

const record = {
  id: '66666666-6666-4666-8666-666666666666',
  patientId: '77777777-7777-4777-8777-777777777777',
  ...stored,
  createdAt: new Date('2026-09-23T10:00:00.000Z'),
  updatedAt: new Date('2026-09-23T10:00:00.000Z'),
}

test('the DTO exposes date-only coverage and the exact identifiers, with no eligibility field', () => {
  const dto = toMembershipDto(record)
  assert.equal(dto.coverageFrom, '2026-01-01')
  assert.equal(dto.coverageTo, null)
  assert.equal(dto.memberIdentifier, MEMBER)
  assert.equal(Object.keys(dto).some((key) => /(eligib|status|active|primary|rank|verified|benefit)/i.test(key)), false)
})

test('the audit snapshot carries identifiers, dates and changed field names — never member/policy values', () => {
  const snapshot = insuranceMembershipAuditSnapshot(record, ['memberIdentifier', 'coverageTo'])
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'changedFields',
    'coverageFrom',
    'coverageTo',
    'id',
    'insuranceProductId',
    'networkId',
    'patientId',
    'payerId',
    'tpaId',
    'updatedAt',
  ])
  const text = JSON.stringify(snapshot)
  assert.equal(text.includes(MEMBER), false)
  assert.equal(text.includes('SYN-POLICY-001'), false)
  assert.deepEqual(snapshot.changedFields, ['coverageTo', 'memberIdentifier'])
})

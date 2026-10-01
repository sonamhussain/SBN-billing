import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyTariffDates,
  isContractCandidate,
  resolveContract,
  resolveTariff,
  type CommercialInputs,
  type ContractCandidate,
  type TariffScheduleRow,
  type TariffVersionRow,
} from './pre-claim-commercial-context.resolver.ts'

// A5.5 — the pure contract and tariff resolver. Synthetic identifiers only; no database access.

const ORG = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER_ORG = 'aaaaaaaa-0000-4000-8000-000000000002'
const PAYER = 'bbbbbbbb-0000-4000-8000-000000000001'
const OTHER_PAYER = 'bbbbbbbb-0000-4000-8000-000000000002'
const TPA = 'cccccccc-0000-4000-8000-000000000001'
const NETWORK = 'dddddddd-0000-4000-8000-000000000001'
const PRODUCT = 'eeeeeeee-0000-4000-8000-000000000001'
const OTHER = 'ffffffff-0000-4000-8000-000000000009'
const FACILITY = 'ffffffff-0000-4000-8000-000000000001'
const d = (value: string) => new Date(`${value}T00:00:00.000Z`)
const DATE = d('2026-06-15')

const inputs = (overrides: Partial<CommercialInputs> = {}): CommercialInputs => ({
  organizationId: ORG,
  payerId: PAYER,
  tpaId: TPA,
  networkId: NETWORK,
  insuranceProductId: PRODUCT,
  facilityId: FACILITY,
  serviceDate: DATE,
  ...overrides,
})

let serial = 0
const contract = (overrides: Partial<ContractCandidate> = {}): ContractCandidate => ({
  id: `11111111-0000-4000-8000-${String(++serial).padStart(12, '0')}`,
  organizationId: ORG,
  payerId: PAYER,
  tpaId: null,
  networkId: null,
  insuranceProductId: null,
  effectiveFrom: d('2025-01-01'),
  effectiveTo: null,
  participatesAtFacility: true,
  ...overrides,
})
const version = (overrides: Partial<TariffVersionRow> = {}): TariffVersionRow => ({
  id: `22222222-0000-4000-8000-${String(++serial).padStart(12, '0')}`,
  verificationStatus: 'VERIFIED',
  verifiedAt: d('2025-12-01'),
  effectiveFrom: d('2026-01-01'),
  effectiveTo: null,
  ...overrides,
})
const schedule = (versions: TariffVersionRow[]): TariffScheduleRow => ({ id: `33333333-0000-4000-8000-${String(++serial).padStart(12, '0')}`, versions })

// ---------------------------------------------------------------- contract candidates

test('organization and payer must match exactly', () => {
  assert.equal(isContractCandidate(contract(), inputs()), true)
  assert.equal(isContractCandidate(contract({ organizationId: OTHER_ORG }), inputs()), false)
  assert.equal(isContractCandidate(contract({ payerId: OTHER_PAYER }), inputs()), false)
})

test('a null optional contract dimension is a wildcard', () => {
  assert.equal(isContractCandidate(contract({ tpaId: null, networkId: null, insuranceProductId: null }), inputs({ tpaId: OTHER, networkId: null, insuranceProductId: null })), true)
})

test('a non-null optional contract dimension requires the exact value', () => {
  for (const field of ['tpaId', 'networkId', 'insuranceProductId'] as const) {
    const required = inputs()[field] as string
    assert.equal(isContractCandidate(contract({ [field]: required }), inputs()), true, `${field} exact`)
    assert.equal(isContractCandidate(contract({ [field]: OTHER }), inputs()), false, `${field} different`)
  }
})

test('a required dimension the Encounter does not carry excludes the contract', () => {
  assert.equal(isContractCandidate(contract({ tpaId: TPA }), inputs({ tpaId: null })), false)
  assert.equal(isContractCandidate(contract({ networkId: NETWORK }), inputs({ networkId: null })), false)
  assert.equal(isContractCandidate(contract({ insuranceProductId: PRODUCT }), inputs({ insuranceProductId: null })), false)
})

test('facility participation is required', () => {
  assert.equal(isContractCandidate(contract({ participatesAtFacility: false }), inputs()), false)
})

test('contract dates are inclusive, and an absent end is open', () => {
  assert.equal(isContractCandidate(contract({ effectiveFrom: d('2026-06-16') }), inputs()), false)
  assert.equal(isContractCandidate(contract({ effectiveTo: d('2026-06-14') }), inputs()), false)
  assert.equal(isContractCandidate(contract({ effectiveFrom: DATE, effectiveTo: DATE }), inputs()), true)
  assert.equal(isContractCandidate(contract({ effectiveFrom: d('2020-01-01'), effectiveTo: null }), inputs()), true)
})

// ---------------------------------------------------------------- contract resolution

test('zero candidates is NO_APPLICABLE_CONTRACT', () => {
  const result = resolveContract([contract({ payerId: OTHER_PAYER })], inputs())
  assert.deepEqual(result, { kind: 'unresolved', reason: 'NO_APPLICABLE_CONTRACT', candidateIds: [] })
})

test('exactly one candidate resolves', () => {
  const only = contract()
  assert.deepEqual(resolveContract([only, contract({ payerId: OTHER_PAYER })], inputs()), { kind: 'resolved', contractId: only.id })
})

test('two candidates is AMBIGUOUS_CONTRACT, named in id order', () => {
  const a = contract()
  const b = contract()
  const result = resolveContract([b, a], inputs())
  assert.equal(result.kind, 'unresolved')
  if (result.kind === 'unresolved') {
    assert.equal(result.reason, 'AMBIGUOUS_CONTRACT')
    assert.deepEqual(result.candidateIds, [a.id, b.id].sort())
  }
})

test('a more constrained contract does not outrank a wildcard one', () => {
  const general = contract()
  const specific = contract({ tpaId: TPA, networkId: NETWORK, insuranceProductId: PRODUCT })
  assert.equal(resolveContract([general, specific], inputs()).kind, 'unresolved')
})

test('a later-starting or shorter contract does not outrank another', () => {
  const older = contract({ effectiveFrom: d('2020-01-01') })
  const newer = contract({ effectiveFrom: d('2026-06-01'), effectiveTo: d('2026-06-30') })
  const result = resolveContract([older, newer], inputs())
  assert.equal(result.kind === 'unresolved' && result.reason, 'AMBIGUOUS_CONTRACT')
})

test('shuffling the contracts changes nothing', () => {
  const rows = [contract(), contract({ payerId: OTHER_PAYER }), contract(), contract({ participatesAtFacility: false })]
  const forward = resolveContract(rows, inputs())
  assert.deepEqual(resolveContract([...rows].reverse(), inputs()), forward)
  assert.deepEqual(resolveContract([rows[2], rows[0], rows[3], rows[1]], inputs()), forward)
})

// ---------------------------------------------------------------- tariff dates

test('tariff date classes follow the four stored-date rules', () => {
  assert.equal(classifyTariffDates({ effectiveFrom: d('2026-01-01'), effectiveTo: null }, DATE), 'EFFECTIVE')
  assert.equal(classifyTariffDates({ effectiveFrom: DATE, effectiveTo: DATE }, DATE), 'EFFECTIVE')
  assert.equal(classifyTariffDates({ effectiveFrom: d('2026-06-16'), effectiveTo: null }, DATE), 'NOT_EFFECTIVE')
  assert.equal(classifyTariffDates({ effectiveFrom: d('2026-01-01'), effectiveTo: d('2026-06-14') }, DATE), 'NOT_EFFECTIVE')
  assert.equal(classifyTariffDates({ effectiveFrom: null, effectiveTo: d('2026-06-14') }, DATE), 'NOT_EFFECTIVE')
  assert.equal(classifyTariffDates({ effectiveFrom: null, effectiveTo: null }, DATE), 'INDETERMINATE')
  assert.equal(classifyTariffDates({ effectiveFrom: null, effectiveTo: DATE }, DATE), 'INDETERMINATE')
  assert.equal(classifyTariffDates({ effectiveFrom: null, effectiveTo: d('2026-12-31') }, DATE), 'INDETERMINATE')
})

// ---------------------------------------------------------------- tariff resolution

test('only VERIFIED versions are candidates', () => {
  for (const status of ['UNVERIFIED', 'IN_REVIEW', 'REJECTED']) {
    const result = resolveTariff([schedule([version({ verificationStatus: status, verifiedAt: null })])], DATE)
    assert.equal(result.kind === 'unresolved' && result.reason, 'NO_APPLICABLE_TARIFF_VERSION', status)
  }
})

test('exactly one effective verified pair resolves to that schedule and version', () => {
  const v = version()
  const s = schedule([v, version({ verificationStatus: 'REJECTED', verifiedAt: null })])
  assert.deepEqual(resolveTariff([s], DATE), { kind: 'resolved', tariffScheduleId: s.id, tariffScheduleVersionId: v.id })
})

test('a VERIFIED version with no verifiedAt fails closed, even when its dates exclude it', () => {
  const ended = version({ effectiveFrom: d('2020-01-01'), effectiveTo: d('2020-12-31'), verifiedAt: null })
  const result = resolveTariff([schedule([version(), ended])], DATE)
  assert.equal(result.kind === 'integrity' && result.reason, 'TARIFF_INTEGRITY_CONFLICT')
})

test('a VERIFIED version that ends before it begins fails closed', () => {
  const result = resolveTariff([schedule([version({ effectiveFrom: d('2026-07-01'), effectiveTo: d('2026-06-01') })])], DATE)
  assert.equal(result.kind === 'integrity' && result.reason, 'TARIFF_INTEGRITY_CONFLICT')
})

test('a missing start that has definitely ended does not block', () => {
  const clear = version()
  const s = schedule([clear, version({ effectiveFrom: null, effectiveTo: d('2025-12-31') })])
  assert.deepEqual(resolveTariff([s], DATE), { kind: 'resolved', tariffScheduleId: s.id, tariffScheduleVersionId: clear.id })
})

test('a missing start that could still apply is INDETERMINATE, even beside a clear candidate', () => {
  const unknown = version({ effectiveFrom: null, effectiveTo: null })
  const alone = resolveTariff([schedule([unknown])], DATE)
  assert.equal(alone.kind === 'unresolved' && alone.reason, 'INDETERMINATE_TARIFF_DATES')
  const beside = resolveTariff([schedule([version(), version({ effectiveFrom: null, effectiveTo: d('2026-12-31') })])], DATE)
  assert.equal(beside.kind === 'unresolved' && beside.reason, 'INDETERMINATE_TARIFF_DATES')
})

test('no effective verified version is NO_APPLICABLE_TARIFF_VERSION', () => {
  const result = resolveTariff([schedule([version({ effectiveFrom: d('2026-07-01') })]), schedule([])], DATE)
  assert.deepEqual(result, { kind: 'unresolved', reason: 'NO_APPLICABLE_TARIFF_VERSION', versionIds: [] })
  assert.equal(resolveTariff([], DATE).kind, 'unresolved')
})

test('two effective versions under one schedule are AMBIGUOUS_TARIFF_VERSION', () => {
  const result = resolveTariff([schedule([version(), version({ effectiveFrom: d('2026-06-01') })])], DATE)
  assert.equal(result.kind === 'unresolved' && result.reason, 'AMBIGUOUS_TARIFF_VERSION')
})

test('one effective version under each of two schedules is AMBIGUOUS_TARIFF_VERSION', () => {
  const result = resolveTariff([schedule([version()]), schedule([version()])], DATE)
  assert.equal(result.kind === 'unresolved' && result.reason, 'AMBIGUOUS_TARIFF_VERSION')
})

test('version text never ranks: v10 does not outrank v2', () => {
  // The label is not even an input to the resolver; two effective rows stay ambiguous whatever they
  // are called, and the ambiguous ids are listed by id, never by label or creation.
  const v2 = version({ id: '22222222-0000-4000-8000-ffffffffff02' })
  const v10 = version({ id: '22222222-0000-4000-8000-ffffffffff10' })
  const result = resolveTariff([schedule([v10, v2])], DATE)
  assert.equal(result.kind, 'unresolved')
  if (result.kind === 'unresolved') assert.deepEqual(result.versionIds, [v2.id, v10.id].sort())
})

test('shuffling schedules and versions changes nothing', () => {
  const a = schedule([version(), version({ verificationStatus: 'IN_REVIEW', verifiedAt: null }), version({ effectiveFrom: d('2027-01-01') })])
  const b = schedule([version({ effectiveTo: d('2026-01-31') })])
  const forward = resolveTariff([a, b], DATE)
  assert.equal(forward.kind, 'resolved')
  assert.deepEqual(resolveTariff([b, { ...a, versions: [...a.versions].reverse() }], DATE), forward)
})

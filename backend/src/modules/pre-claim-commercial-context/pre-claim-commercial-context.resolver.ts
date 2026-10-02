import type { ResolutionReason } from './pre-claim-commercial-context.types.ts'

// A5.5 §8–§12 — the resolver. It is pure: every fact it needs is passed in, so the whole decision is
// unit-testable and there is exactly one copy of it.
//
// Two properties hold by construction:
//
//   Fail closed, never rank. Zero candidates is unresolved and more than one is ambiguous. No winner
//   is ever chosen — not by the number of constrained dimensions, createdAt, contractKey, version
//   text or row order. Choosing one would be inventing commercial precedence no governed rule owns.
//
//   Order independent. Candidates are compared as sets and every id list is sorted, so shuffling the
//   rows the repository returned cannot change a single outcome.

const sortIds = (ids: string[]) => [...ids].sort()
const onOrAfter = (date: Date, bound: Date) => date.getTime() >= bound.getTime()
const onOrBefore = (date: Date, bound: Date) => date.getTime() <= bound.getTime()

// ---------------------------------------------------------------- contracts (§8, §9)

// The authoritative commercial context, already verified by A4.9 and A4.3 before it reaches here.
export type CommercialInputs = {
  organizationId: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  facilityId: string
  serviceDate: Date
}

export type ContractCandidate = {
  id: string
  organizationId: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  effectiveFrom: Date
  effectiveTo: Date | null
  // Whether a ContractFacility row links this exact contract to the Encounter's facility.
  participatesAtFacility: boolean
}

// A null optional dimension on the contract is a wildcard; a non-null one is a hard constraint that an
// unknown (null) Encounter value cannot satisfy.
const optionalMatches = (required: string | null, actual: string | null) => required === null || required === actual

export function isContractCandidate(contract: ContractCandidate, inputs: CommercialInputs): boolean {
  if (contract.organizationId !== inputs.organizationId) return false
  if (contract.payerId !== inputs.payerId) return false
  if (!optionalMatches(contract.tpaId, inputs.tpaId)) return false
  if (!optionalMatches(contract.networkId, inputs.networkId)) return false
  if (!optionalMatches(contract.insuranceProductId, inputs.insuranceProductId)) return false
  if (!contract.participatesAtFacility) return false
  // Inclusive on both ends; an absent end is open.
  if (!onOrAfter(inputs.serviceDate, contract.effectiveFrom)) return false
  if (contract.effectiveTo !== null && !onOrBefore(inputs.serviceDate, contract.effectiveTo)) return false
  return true
}

export type ContractResolution =
  | { kind: 'resolved'; contractId: string }
  | { kind: 'unresolved'; reason: 'NO_APPLICABLE_CONTRACT' | 'AMBIGUOUS_CONTRACT'; candidateIds: string[] }

export function resolveContract(contracts: ContractCandidate[], inputs: CommercialInputs): ContractResolution {
  const candidateIds = sortIds(contracts.filter((contract) => isContractCandidate(contract, inputs)).map((contract) => contract.id))
  if (candidateIds.length === 0) return { kind: 'unresolved', reason: 'NO_APPLICABLE_CONTRACT', candidateIds }
  if (candidateIds.length > 1) return { kind: 'unresolved', reason: 'AMBIGUOUS_CONTRACT', candidateIds }
  return { kind: 'resolved', contractId: candidateIds[0] }
}

// ---------------------------------------------------------------- tariffs (§10–§12)

export type TariffVersionRow = {
  id: string
  verificationStatus: string
  verifiedAt: Date | null
  effectiveFrom: Date | null
  effectiveTo: Date | null
}

export type TariffScheduleRow = {
  id: string
  versions: TariffVersionRow[]
}

export type TariffDateClass = 'EFFECTIVE' | 'NOT_EFFECTIVE' | 'INDETERMINATE'

// §11. A missing effectiveFrom is never an automatic open beginning: applicability is then provable
// only in the negative (an end before the service date).
export function classifyTariffDates(version: Pick<TariffVersionRow, 'effectiveFrom' | 'effectiveTo'>, serviceDate: Date): TariffDateClass {
  if (version.effectiveFrom === null) {
    if (version.effectiveTo !== null && version.effectiveTo.getTime() < serviceDate.getTime()) return 'NOT_EFFECTIVE'
    return 'INDETERMINATE'
  }
  if (!onOrAfter(serviceDate, version.effectiveFrom)) return 'NOT_EFFECTIVE'
  if (version.effectiveTo !== null && !onOrBefore(serviceDate, version.effectiveTo)) return 'NOT_EFFECTIVE'
  return 'EFFECTIVE'
}

export type TariffResolution =
  | { kind: 'resolved'; tariffScheduleId: string; tariffScheduleVersionId: string }
  | { kind: 'integrity'; reason: 'TARIFF_INTEGRITY_CONFLICT'; message: string }
  | {
      kind: 'unresolved'
      reason: Extract<ResolutionReason, 'NO_APPLICABLE_TARIFF_VERSION' | 'AMBIGUOUS_TARIFF_VERSION' | 'INDETERMINATE_TARIFF_DATES'>
      versionIds: string[]
    }

export function resolveTariff(schedules: TariffScheduleRow[], serviceDate: Date): TariffResolution {
  const verified = schedules.flatMap((schedule) =>
    schedule.versions.filter((version) => version.verificationStatus === 'VERIFIED').map((version) => ({ scheduleId: schedule.id, version })),
  )

  // Integrity first, across EVERY verified version under the resolved contract (owner decision): a
  // broken row is not trusted to say whether its own dates exclude it.
  const unverifiedAt = verified.filter(({ version }) => version.verifiedAt === null).map(({ version }) => version.id)
  if (unverifiedAt.length > 0)
    return { kind: 'integrity', reason: 'TARIFF_INTEGRITY_CONFLICT', message: 'a VERIFIED tariff schedule version under the resolved contract has no verifiedAt' }
  const contradictory = verified.filter(
    ({ version }) => version.effectiveFrom !== null && version.effectiveTo !== null && version.effectiveTo.getTime() < version.effectiveFrom.getTime(),
  )
  if (contradictory.length > 0)
    return { kind: 'integrity', reason: 'TARIFF_INTEGRITY_CONFLICT', message: 'a VERIFIED tariff schedule version under the resolved contract ends before it begins' }

  const definite: Array<{ scheduleId: string; versionId: string }> = []
  const indeterminate: string[] = []
  for (const { scheduleId, version } of verified) {
    const dates = classifyTariffDates(version, serviceDate)
    if (dates === 'EFFECTIVE') definite.push({ scheduleId, versionId: version.id })
    else if (dates === 'INDETERMINATE') indeterminate.push(version.id)
  }

  // An unknown start that could still apply blocks resolution even beside a clear candidate:
  // choosing the clear one would be guessing that the unknown one does not apply.
  if (indeterminate.length > 0) return { kind: 'unresolved', reason: 'INDETERMINATE_TARIFF_DATES', versionIds: sortIds(indeterminate) }
  if (definite.length === 0) return { kind: 'unresolved', reason: 'NO_APPLICABLE_TARIFF_VERSION', versionIds: [] }
  // Two effective versions under one schedule, or one under each of two schedules: either way the
  // schedule-and-version pair is not unique.
  if (definite.length > 1) return { kind: 'unresolved', reason: 'AMBIGUOUS_TARIFF_VERSION', versionIds: sortIds(definite.map((pair) => pair.versionId)) }
  return { kind: 'resolved', tariffScheduleId: definite[0].scheduleId, tariffScheduleVersionId: definite[0].versionId }
}

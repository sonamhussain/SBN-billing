import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
// A4.9 owns the current Encounter context and the integrity verdict on its exact stored bindings.
// Both are reused unchanged, inside this resolution's own snapshot.
import {
  findEncounterForBillingContext,
  findStoredAssignment,
  findStoredRegulatoryProfile,
  readTransactionTimestamp,
} from '../encounter-billing-context/encounter-billing-context.repository.ts'
import { verifySelectedMembership, verifyStoredAssignment, verifyStoredProfile } from '../encounter-billing-context/encounter-billing-context.validation.ts'
// A4.3 owns commercial coherence of the selected membership. Its decision and its ownership readers
// are reused exactly as written; A5.5 defines no second rule about payers, TPAs, networks or products.
import { decideCommercialCoherence } from '../insurance-membership/insurance-membership.validation.ts'
import {
  findInsuranceProductOwnership,
  findNetworkOwnership,
  findPayerOwnership,
  findTpaOwnership,
} from '../insurance-membership/insurance-membership.repository.ts'
import { findProductNetworkByProductAndNetwork } from '../commercial-coverage/insurance-product.repository.ts'
// REF-01 owns contract-facility participation; its exact-pair reader is reused.
import { findContractFacilityByContractAndFacility } from '../commercial-coverage/provider-contract.repository.ts'
import { resolveContract, resolveTariff } from './pre-claim-commercial-context.resolver.ts'
import type { PreClaimCommercialContextResult, PreClaimCommercialContextV1, ResolutionReason } from './pre-claim-commercial-context.types.ts'
import { findContractsForPayer, findTariffSchedulesWithVersions } from './pre-claim-commercial-context.repository.ts'

// A5.5 §7 — one REPEATABLE READ, READ ONLY snapshot, recomputed on every call. Nothing is written,
// nothing is audited and no row is locked. The business date is the Encounter's own service date;
// no caller can supply a date, a payer, a facility, a contract or a tariff.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isPreClaimUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidShape.test(value)
}

const integrity = (reason: ResolutionReason, message: string): PreClaimCommercialContextResult<never> => ({ ok: false, code: 'INTEGRITY_CONFLICT', reason, message })
const unresolved = (reason: ResolutionReason, message: string): PreClaimCommercialContextResult<never> => ({ ok: false, code: 'COMMERCIAL_CONTEXT_UNRESOLVED', reason, message })

export async function resolvePreClaimCommercialContext(encounterId: unknown, db?: DbClient): Promise<PreClaimCommercialContextResult<PreClaimCommercialContextV1>> {
  if (!isPreClaimUuid(encounterId)) return { ok: false, code: 'VALIDATION_ERROR', message: 'invalid encounter id' }

  return withReadSnapshot(db, async (tx): Promise<PreClaimCommercialContextResult<PreClaimCommercialContextV1>> => {
    // The first statement fixes the snapshot and is also resolvedAt: the database's clock, not the
    // application's.
    const resolvedAt = await readTransactionTimestamp(tx)
    // Acceptance holds the read here, commits a correction from another connection, then releases:
    // everything below must still reflect one state. In normal operation this is a no-op.
    await concurrencyProbe('pre_claim_commercial_context.snapshot')

    // ---- §7 steps 1-2: the Encounter and A4.9's integrity verdict on its exact stored bindings
    const encounter = await findEncounterForBillingContext(encounterId, tx)
    if (!encounter) return { ok: false, code: 'NOT_FOUND', message: 'encounter not found' }
    const binding = {
      id: encounter.id,
      clinicianId: encounter.clinicianId,
      facilityId: encounter.facilityId,
      patientId: encounter.patientId,
      serviceDate: encounter.serviceDate,
      clinicianFacilityAssignmentId: encounter.clinicianFacilityAssignmentId,
      facilityRegulatoryProfileId: encounter.facilityRegulatoryProfileId,
      insuranceMembershipId: encounter.insuranceMembershipId,
    }
    const membershipCheck = verifySelectedMembership(binding, encounter.insuranceMembership)
    if (!membershipCheck.ok) return integrity('A4_INTEGRITY_CONFLICT', membershipCheck.message)
    const assignmentCheck = verifyStoredAssignment(binding, await findStoredAssignment(encounter.clinicianFacilityAssignmentId, tx))
    if (!assignmentCheck.ok) return integrity('A4_INTEGRITY_CONFLICT', assignmentCheck.message)
    const profileCheck = verifyStoredProfile(binding, await findStoredRegulatoryProfile(encounter.facilityRegulatoryProfileId, tx))
    if (!profileCheck.ok) return integrity('A4_INTEGRITY_CONFLICT', profileCheck.message)

    // ---- §7 step 3: commercial resolution needs a selected membership. Its absence is not self-pay
    // and never selects a default contract.
    const membership = encounter.insuranceMembership
    if (membership === null)
      return unresolved('NO_SELECTED_MEMBERSHIP', 'the encounter has no selected insurance membership, so there is no commercial context to resolve')

    // ---- §7 step 4: the stored commercial context re-verified with A4.3's own rule and readers
    const organizationId = encounter.patient.organizationId
    const coherence = decideCommercialCoherence({
      patientOrganizationId: organizationId,
      payerId: membership.payerId,
      payer: await findPayerOwnership(membership.payerId, tx),
      tpa: membership.tpaId ? await findTpaOwnership(membership.tpaId, tx) : ('not-supplied' as const),
      network: membership.networkId ? await findNetworkOwnership(membership.networkId, tx) : ('not-supplied' as const),
      product: membership.insuranceProductId ? await findInsuranceProductOwnership(membership.insuranceProductId, tx) : ('not-supplied' as const),
      productNetworkExists:
        membership.insuranceProductId && membership.networkId
          ? (await findProductNetworkByProductAndNetwork(membership.insuranceProductId, membership.networkId, tx)) !== null
          : ('not-applicable' as const),
    })
    // A4.3's own wording is passed through: it names which master is wrong without saying whose it is.
    if (!coherence.ok) return integrity('A4_INTEGRITY_CONFLICT', coherence.message)

    // ---- §7 step 5: the authoritative inputs, and only then the candidates
    const inputs = {
      organizationId,
      payerId: membership.payerId,
      tpaId: membership.tpaId,
      networkId: membership.networkId,
      insuranceProductId: membership.insuranceProductId,
      facilityId: encounter.facilityId,
      serviceDate: encounter.serviceDate,
    }

    // ---- §8-§9: contracts
    const contracts = []
    for (const row of await findContractsForPayer(organizationId, membership.payerId, tx))
      contracts.push({ ...row, participatesAtFacility: (await findContractFacilityByContractAndFacility(row.id, encounter.facilityId, tx)) !== null })
    const contract = resolveContract(contracts, inputs)
    if (contract.kind === 'unresolved')
      return contract.reason === 'NO_APPLICABLE_CONTRACT'
        ? unresolved('NO_APPLICABLE_CONTRACT', 'no provider contract applies to the encounter commercial context, facility and service date')
        : unresolved('AMBIGUOUS_CONTRACT', `${contract.candidateIds.length} provider contracts apply; A5.5 has no authority to rank them`)

    // ---- §10-§12: the tariff schedule and version pair beneath exactly that contract
    const tariff = resolveTariff(await findTariffSchedulesWithVersions(contract.contractId, tx), encounter.serviceDate)
    if (tariff.kind === 'integrity') return integrity(tariff.reason, tariff.message)
    if (tariff.kind === 'unresolved') {
      if (tariff.reason === 'INDETERMINATE_TARIFF_DATES')
        return unresolved(tariff.reason, 'a VERIFIED tariff schedule version could apply but has no effective start, so its applicability cannot be proven')
      if (tariff.reason === 'NO_APPLICABLE_TARIFF_VERSION')
        return unresolved(tariff.reason, 'no VERIFIED tariff schedule version under the resolved contract is effective on the service date')
      return unresolved(tariff.reason, `${tariff.versionIds.length} VERIFIED tariff schedule versions are effective on the service date; A5.5 has no authority to rank them`)
    }

    return {
      ok: true,
      value: {
        schemaVersion: 'PreClaimCommercialContextV1',
        resolvedAt: resolvedAt.toISOString(),
        organizationId,
        encounterId: encounter.id,
        serviceDate: formatDateOnly(encounter.serviceDate) as string,
        facilityId: encounter.facilityId,
        facilityRegulatoryProfileId: encounter.facilityRegulatoryProfileId,
        payerId: membership.payerId,
        tpaId: membership.tpaId,
        networkId: membership.networkId,
        insuranceProductId: membership.insuranceProductId,
        providerContractId: contract.contractId,
        tariffScheduleId: tariff.tariffScheduleId,
        tariffScheduleVersionId: tariff.tariffScheduleVersionId,
      },
    }
  })
}

// REF-01 §9 (A3.6 ApplicabilityContextV2): "Create/evaluate context validation is hierarchical
// and fail-closed. A coherent context is validated before matching... Missing resource -> 404,
// foreign tenant -> 403, contradictory same-tenant context -> 400. Only after context is coherent
// does the normal AND-within-row / OR-across-rows matcher run." This module implements exactly
// that pre-matching validation pass — the matcher itself (rule-applicability.matcher.ts) stays
// pure and untouched, consuming only an already-coherent context.
import type { DbClient } from '../../shared/database/database.types.ts'
import type { ApplicabilityContext } from './rule-applicability.matcher.ts'
import { applicabilityDimensionKeys, type ApplicabilityDimensionKey } from './rule-applicability.validation.ts'
import { findTargetOrganizationId } from './rule-applicability.repository.ts'
import { findInsuranceProductById, findProductNetworkByProductAndNetwork } from '../commercial-coverage/insurance-product.repository.ts'
import { findContractFacilityByContractAndFacility, findProviderContractById } from '../commercial-coverage/provider-contract.repository.ts'
import { findTariffScheduleById, findTariffScheduleVersionById } from '../commercial-coverage/tariff-schedule.repository.ts'
import { findFacilityRegulatoryProfileById } from '../facility-regulatory/facility-regulatory.repository.ts'

export type CoherenceErrorCode = 'NOT_FOUND' | 'FORBIDDEN' | 'VALIDATION_ERROR'
export type CoherenceResult = { ok: true } | { ok: false; code: CoherenceErrorCode; message: string }

const dimensionLabel: Record<ApplicabilityDimensionKey, string> = {
  facilityId: 'facility',
  facilityRegulatoryProfileId: 'facility regulatory profile',
  payerId: 'payer',
  tpaId: 'tpa',
  networkId: 'network',
  insuranceProductId: 'insurance product',
  providerContractId: 'provider contract',
  tariffScheduleId: 'tariff schedule',
  tariffScheduleVersionId: 'tariff schedule version',
  serviceId: 'service',
  procedureCodeId: 'procedure code',
  diagnosisCodeId: 'diagnosis code',
}

export async function validateApplicabilityContextCoherence(
  context: ApplicabilityContext,
  organizationId: string,
  db: DbClient,
): Promise<CoherenceResult> {
  // Pass 1: every supplied non-null dimension must exist and belong to this organization.
  for (const key of applicabilityDimensionKeys) {
    const value = context[key]
    if (value === undefined || value === null) continue
    const targetOrgId = await findTargetOrganizationId(key, value, db)
    if (targetOrgId === null) return { ok: false, code: 'NOT_FOUND', message: `${dimensionLabel[key]} not found` }
    if (targetOrgId !== organizationId)
      return { ok: false, code: 'FORBIDDEN', message: `${dimensionLabel[key]} belongs to a different organization` }
  }

  // Pass 2: combination coherence against the AUTHORITATIVE ancestry (audit F06).
  //
  // Each supplied child is walked up to its real ancestors — tariff version -> schedule -> contract
  // -> (payer, TPA, network, product, participating facilities) — and every supplied fact is
  // compared with those ancestors whether or not the intermediate IDs were included. Checking only
  // pairs of supplied IDs let a caller omit the middle ID and assert a contradictory combination.
  //
  // This is validation only: derived ancestors are local values, the context is never written to,
  // so stored wildcards, AND/OR matching and specificity are unaffected.
  const fail = (message: string): CoherenceResult => ({ ok: false, code: 'VALIDATION_ERROR', message })

  // Facility chain: a regulatory profile belongs to exactly one facility, so it asserts that
  // facility even when facilityId itself is omitted.
  let facilityId = context.facilityId ?? null
  if (context.facilityRegulatoryProfileId) {
    const profile = await findFacilityRegulatoryProfileById(context.facilityRegulatoryProfileId, db)
    if (profile) {
      if (facilityId && profile.facilityId !== facilityId)
        return fail('facilityRegulatoryProfileId does not belong to the supplied facilityId')
      facilityId = profile.facilityId
    }
  }
  const facilitySubject = context.facilityId ? 'facilityId' : "facilityRegulatoryProfileId's facility"

  let scheduleId = context.tariffScheduleId ?? null
  if (context.tariffScheduleVersionId) {
    const version = await findTariffScheduleVersionById(context.tariffScheduleVersionId, db)
    if (version) {
      if (scheduleId && version.tariffScheduleId !== scheduleId)
        return fail('tariffScheduleVersionId does not belong to the supplied tariffScheduleId')
      scheduleId = version.tariffScheduleId
    }
  }

  let contractId = context.providerContractId ?? null
  if (scheduleId) {
    const schedule = await findTariffScheduleById(scheduleId, db)
    if (schedule) {
      if (contractId && schedule.providerContractId !== contractId)
        return fail(
          context.tariffScheduleId
            ? 'tariffScheduleId does not belong to the supplied providerContractId'
            : 'tariffScheduleVersionId does not belong to the supplied providerContractId',
        )
      contractId = schedule.providerContractId
    }
  }

  // Which supplied child the contract was derived from, for precise messages.
  const contractSubject = context.providerContractId
    ? 'providerContractId'
    : context.tariffScheduleId
      ? "tariffScheduleId's provider contract"
      : "tariffScheduleVersionId's provider contract"

  let payerId = context.payerId ?? null
  if (contractId) {
    const contract = await findProviderContractById(contractId, db)
    if (contract) {
      if (payerId && contract.payerId !== payerId) return fail(`${contractSubject} belongs to a different payer than the supplied payerId`)
      // A null commercial dimension on the contract keeps the safe rejection: its meaning
      // (unrestricted / unknown / not applicable) has not been decided, so a supplied value is
      // never assumed to be covered by it.
      if (context.tpaId && contract.tpaId !== context.tpaId) return fail(`${contractSubject} does not match the supplied tpaId`)
      if (context.networkId && contract.networkId !== context.networkId) return fail(`${contractSubject} does not match the supplied networkId`)
      if (context.insuranceProductId && contract.insuranceProductId !== context.insuranceProductId)
        return fail(`${contractSubject} does not match the supplied insuranceProductId`)

      if (facilityId) {
        const link = await findContractFacilityByContractAndFacility(contract.id, facilityId, db)
        if (!link) return fail(`${facilitySubject} does not participate in ${contractSubject}`)
      }
      payerId = payerId ?? contract.payerId
    }
  }

  if (context.insuranceProductId) {
    const product = await findInsuranceProductById(context.insuranceProductId, db)
    if (product && payerId && product.payerId !== payerId)
      return fail(
        context.payerId
          ? 'insuranceProductId belongs to a different payer than the supplied payerId'
          : `insuranceProductId belongs to a different payer than ${contractSubject}`,
      )
  }

  if (context.insuranceProductId && context.networkId) {
    const productNetwork = await findProductNetworkByProductAndNetwork(context.insuranceProductId, context.networkId, db)
    if (!productNetwork) return fail('insuranceProductId and networkId have no existing ProductNetwork relationship')
  }

  return { ok: true }
}

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

  // Pass 2: cross-dimension hierarchy consistency.
  if (context.insuranceProductId && context.payerId) {
    const product = await findInsuranceProductById(context.insuranceProductId, db)
    if (product && product.payerId !== context.payerId)
      return { ok: false, code: 'VALIDATION_ERROR', message: 'insuranceProductId belongs to a different payer than the supplied payerId' }
  }

  if (context.insuranceProductId && context.networkId) {
    const productNetwork = await findProductNetworkByProductAndNetwork(context.insuranceProductId, context.networkId, db)
    if (!productNetwork)
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'insuranceProductId and networkId have no existing ProductNetwork relationship',
      }
  }

  if (context.providerContractId) {
    const contract = await findProviderContractById(context.providerContractId, db)
    if (contract) {
      if (context.payerId && contract.payerId !== context.payerId)
        return { ok: false, code: 'VALIDATION_ERROR', message: 'providerContractId belongs to a different payer than the supplied payerId' }
      if (context.tpaId && contract.tpaId !== context.tpaId)
        return { ok: false, code: 'VALIDATION_ERROR', message: 'providerContractId does not match the supplied tpaId' }
      if (context.networkId && contract.networkId !== context.networkId)
        return { ok: false, code: 'VALIDATION_ERROR', message: 'providerContractId does not match the supplied networkId' }
      if (context.insuranceProductId && contract.insuranceProductId !== context.insuranceProductId)
        return { ok: false, code: 'VALIDATION_ERROR', message: 'providerContractId does not match the supplied insuranceProductId' }

      if (context.facilityId) {
        const link = await findContractFacilityByContractAndFacility(context.providerContractId, context.facilityId, db)
        if (!link)
          return {
            ok: false,
            code: 'VALIDATION_ERROR',
            message: 'facilityId does not participate in the supplied providerContractId',
          }
      }
    }
  }

  if (context.tariffScheduleId) {
    const schedule = await findTariffScheduleById(context.tariffScheduleId, db)
    if (schedule && context.providerContractId && schedule.providerContractId !== context.providerContractId)
      return { ok: false, code: 'VALIDATION_ERROR', message: 'tariffScheduleId does not belong to the supplied providerContractId' }
  }

  if (context.tariffScheduleVersionId) {
    const version = await findTariffScheduleVersionById(context.tariffScheduleVersionId, db)
    if (version && context.tariffScheduleId && version.tariffScheduleId !== context.tariffScheduleId)
      return { ok: false, code: 'VALIDATION_ERROR', message: 'tariffScheduleVersionId does not belong to the supplied tariffScheduleId' }
  }

  if (context.facilityRegulatoryProfileId && context.facilityId) {
    const profile = await findFacilityRegulatoryProfileById(context.facilityRegulatoryProfileId, db)
    if (profile && profile.facilityId !== context.facilityId)
      return { ok: false, code: 'VALIDATION_ERROR', message: 'facilityRegulatoryProfileId does not belong to the supplied facilityId' }
  }

  return { ok: true }
}

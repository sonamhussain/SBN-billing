import type { DbClient } from '../../shared/database/database.types.ts'
// A4.9 owns the integrity verdict on the Encounter's exact stored bindings; A4.3 owns commercial
// coherence of the selected membership. Both are reused unchanged — exactly the set A5.5 reports as
// A4_INTEGRITY_CONFLICT (owner decision: the TECHNICAL gate is that whole set).
import { findEncounterForBillingContext, findStoredAssignment, findStoredRegulatoryProfile } from '../encounter-billing-context/encounter-billing-context.repository.ts'
import { verifySelectedMembership, verifyStoredAssignment, verifyStoredProfile } from '../encounter-billing-context/encounter-billing-context.validation.ts'
import { decideCommercialCoherence } from '../insurance-membership/insurance-membership.validation.ts'
import { findInsuranceProductOwnership, findNetworkOwnership, findPayerOwnership, findTpaOwnership } from '../insurance-membership/insurance-membership.repository.ts'
import { findProductNetworkByProductAndNetwork } from '../commercial-coverage/insurance-product.repository.ts'
import { draft } from './pre-claim-validation.finding-catalog.ts'
import type { FindingDraft } from './pre-claim-validation.types.ts'

export type LoadedEncounter = NonNullable<Awaited<ReturnType<typeof findEncounterForBillingContext>>>

export type MembershipFacts = {
  insuranceMembershipId: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
}

export type TechnicalResult =
  | { passed: true; finding: FindingDraft; membership: MembershipFacts | null }
  | { passed: false; finding: FindingDraft }

// §8 — the stored context is verified, never repaired. Any contradiction is one FAIL finding, and the
// caller stops every dependent layer: nothing is computed on a context already proven contradictory.
export async function evaluateTechnical(encounter: LoadedEncounter, tx: DbClient): Promise<TechnicalResult> {
  const fail = (): TechnicalResult => ({ passed: false, finding: draft('TECHNICAL_CONTEXT_INTEGRITY_FAIL') })
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
  if (!verifySelectedMembership(binding, encounter.insuranceMembership).ok) return fail()
  if (!verifyStoredAssignment(binding, await findStoredAssignment(encounter.clinicianFacilityAssignmentId, tx)).ok) return fail()
  if (!verifyStoredProfile(binding, await findStoredRegulatoryProfile(encounter.facilityRegulatoryProfileId, tx)).ok) return fail()

  const membership = encounter.insuranceMembership
  if (membership === null) return { passed: true, finding: draft('TECHNICAL_CONTEXT_VALID'), membership: null }

  const coherence = decideCommercialCoherence({
    patientOrganizationId: encounter.patient.organizationId,
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
  if (!coherence.ok) return fail()

  // §6 — only once integrity holds are the exact current membership facts copied into the run context.
  return {
    passed: true,
    finding: draft('TECHNICAL_CONTEXT_VALID'),
    membership: {
      insuranceMembershipId: membership.id,
      payerId: membership.payerId,
      tpaId: membership.tpaId,
      networkId: membership.networkId,
      insuranceProductId: membership.insuranceProductId,
    },
  }
}

import { prisma } from '../../shared/database/prisma.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
import type {
  EligibilityVerificationDto,
  EligibilityVerificationListDto,
  EligibilityVerificationResult,
  VerificationContext,
} from './eligibility-verification.types.ts'
import { isVerificationUuid, toVerificationDto, validateVerificationBody, verificationAuditSnapshot } from './eligibility-verification.validation.ts'
import {
  createVerificationRecord,
  findEncounterContext,
  findEvidenceVersionOrganization,
  findMembershipCommercialContext,
  findVerificationById,
  findVerificationsByEncounter,
} from './eligibility-verification.repository.ts'

// A4.3 owns commercial coherence. Its decision is reused here exactly as written — A5.2 defines no
// second rule about payers, TPAs, networks or products, and the readers below are A4.3's own.
import { decideCommercialCoherence } from '../insurance-membership/insurance-membership.validation.ts'
import {
  findInsuranceProductOwnership,
  findNetworkOwnership,
  findPayerOwnership,
  findTpaOwnership,
} from '../insurance-membership/insurance-membership.repository.ts'
import { findProductNetworkByProductAndNetwork } from '../commercial-coverage/insurance-product.repository.ts'


// A5.2 — recording an eligibility verification and reading verification history.
//
// One write exists and it is atomic with its audit record. There is no update and no delete,
// because a correction to a verification is a new verification. There is also no /verify endpoint
// and nothing here opens a network connection: A5.2 records what a verification reported, it does
// not perform one. Real payer transport belongs to A9.
//
// The context a verification is judged against is derived here, inside the transaction, never
// accepted from the caller. The Encounter row is locked first and the selected membership second,
// so a concurrent correction to either cannot land halfway through this snapshot: what is recorded
// is wholly the state before that correction or wholly the state after it, never a mixture.

function contextError(message: string): EligibilityVerificationResult<never> {
  return { ok: false, code: 'VALIDATION_ERROR', message }
}

export async function createEligibilityVerification(
  encounterId: string,
  body: unknown,
  actorUserId: string,
): Promise<EligibilityVerificationResult<EligibilityVerificationDto>> {
  if (!isVerificationUuid(encounterId)) return contextError('invalid encounter id')

  const validated = validateVerificationBody(body, new Date())
  if (!validated.ok) return contextError(validated.message)
  const input = validated.value

  const outcome = await prisma.$transaction(async (tx) => {
    // Lock the Encounter first, then re-read it. A concurrent Encounter correction — a new service
    // date, a different selected membership — serializes here, so the snapshot below cannot be
    // assembled from two different versions of the truth.
    const encounterLocked = await lockRowForUpdate(tx, 'encounters', encounterId)
    if (!encounterLocked) return { kind: 'encounter-missing' as const }

    await concurrencyProbe('eligibility_verification.encounter_locked')

    const encounter = await findEncounterContext(encounterId, tx)
    if (!encounter) return { kind: 'encounter-missing' as const }
    // The organization that owns the Encounter's Patient. It is read here, under the lock,
    // rather than passed in, so the evidence-tenancy check below cannot be aimed at a different
    // tenant than the one this Encounter actually belongs to.
    const organizationId = encounter.patient.organizationId

    // An Encounter with no selected membership is not a self-pay or ineligible verification: it is
    // an Encounter this package cannot verify against anything. Manufacturing a meaning from the
    // absence would be exactly the inference A5.2 exists to refuse.
    if (encounter.insuranceMembershipId === null) return { kind: 'no-membership' as const }

    // Lock the selected membership too, then re-read it. A concurrent membership correction — a
    // different payer, TPA, network or product — serializes here as well.
    const membershipLocked = await lockRowForUpdate(tx, 'insurance_memberships', encounter.insuranceMembershipId)
    if (!membershipLocked) return { kind: 'membership-missing' as const }

    await concurrencyProbe('eligibility_verification.membership_locked')

    const membership = await findMembershipCommercialContext(encounter.insuranceMembershipId, tx)
    if (!membership) return { kind: 'membership-missing' as const }

    // The membership must belong to the Encounter's Patient. This is the one coherence rule A5.2
    // enforces. It deliberately does NOT check that the service date falls inside the membership's
    // recorded coverage period: that period is registration truth, and refusing to record a
    // verification because of it would turn coverage dates into an eligibility gate — which is
    // precisely what this package exists to prevent. A verification reporting INELIGIBLE for an
    // encounter outside the recorded period is the case that matters most.
    if (membership.patientId !== encounter.patientId) return { kind: 'membership-mismatch' as const }

        // A4.3 checks commercial coherence when a membership is WRITTEN, and nothing re-checks it
    // afterwards. A master can be moved to another organization, or a ProductNetwork relationship
    // removed, long after the membership was created — and this is the moment those values stop
    // being a live reference and become a frozen, immutable snapshot that can never be corrected.
    // So the stored context is re-verified here, under the lock, immediately before it is frozen.
    //
    // The decision is A4.3's own `decideCommercialCoherence`, read through A4.3's own ownership
    // readers, inside this transaction. A5.2 defines no second rule: it assembles the facts and
    // asks the owner. memberIdentifier and policyIdentifier are still never read.
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
    // Fail closed. A contradictory stored context produces no verification and no audit event, and
    // nothing is substituted or inferred in its place: there is no correct value to guess, and a
    // guess would be frozen forever.
    if (!coherence.ok) return { kind: 'incoherent-context' as const, code: coherence.code, message: coherence.message }
      
    // Both evidence versions must belong to the same organization as the Encounter's Patient. Only
    // the owning organization is read; the storage reference, hash and document type are never
    // loaded, let alone inspected to decide anything.
    for (const [field, versionId] of [
      ['responseEvidenceVersionId', input.responseEvidenceVersionId],
      ['requestEvidenceVersionId', input.requestEvidenceVersionId],
    ] as const) {
      if (versionId === null) continue
      const version = await findEvidenceVersionOrganization(versionId, tx)
      // A missing version and a foreign-tenant version are refused identically, so a caller never
      // learns that another organization's evidence exists.
      if (!version || version.evidenceArtifact.organizationId !== organizationId)
        return { kind: 'evidence-not-found' as const, field }
    }

    const context: VerificationContext = {
      encounterId: encounter.id,
      insuranceMembershipId: membership.id,
      // Copied from the Encounter as it stands under the lock, so a later date correction cannot
      // rewrite what date this verification was evaluated for.
      serviceDate: encounter.serviceDate,
      payerId: membership.payerId,
      tpaId: membership.tpaId,
      networkId: membership.networkId,
      insuranceProductId: membership.insuranceProductId,
    }

    const verification = await createVerificationRecord(context, input, tx)

    await recordAuditEvent(
      {
        organizationId,
        actorUserId,
        actionCode: 'eligibility_verification.created',
        entityType: 'ELIGIBILITY_VERIFICATION',
        entityId: verification.id,
        beforeState: null,
        afterState: verificationAuditSnapshot(verification),
      },
      tx,
    )

    // Acceptance forces a failure here to prove the verification and its audit are one unit. In
    // normal operation it is a no-op.
    await concurrencyProbe('eligibility_verification.created')

    return { kind: 'created' as const, verification }
  })

  if (outcome.kind === 'encounter-missing') return { ok: false, code: 'NOT_FOUND', message: 'encounter not found' }
  if (outcome.kind === 'membership-missing') return { ok: false, code: 'NOT_FOUND', message: 'the selected insurance membership was not found' }
  if (outcome.kind === 'no-membership')
    return contextError('the encounter has no selected insurance membership, so there is nothing to verify against')
  if (outcome.kind === 'membership-mismatch')
    return contextError('the selected insurance membership does not belong to the encounter patient')
  if (outcome.kind === 'evidence-not-found') return { ok: false, code: 'NOT_FOUND', message: `${outcome.field} was not found` }
  // A4.3's own wording is passed through unchanged. It names which master is wrong without
  // revealing that an id belongs to another organization: a foreign master and a missing one are
  // both simply "not found".
  if (outcome.kind === 'incoherent-context') return { ok: false, code: outcome.code, message: outcome.message }

  return { ok: true, value: toVerificationDto(outcome.verification, new Date()) }
}

export async function listEligibilityVerifications(encounterId: string): Promise<EligibilityVerificationResult<EligibilityVerificationListDto>> {
  if (!isVerificationUuid(encounterId)) return contextError('invalid encounter id')
  const rows = await findVerificationsByEncounter(encounterId)
  // Freshness is evaluated once for the whole list, so every row in one response answers the same
  // question: "as of this instant". Evaluating per row would let two rows in one reply disagree
  // about what time it is.
  const asOf = new Date()
  return { ok: true, value: { items: rows.map((row) => toVerificationDto(row, asOf)) } }
}

export async function getEligibilityVerification(verificationId: string): Promise<EligibilityVerificationResult<EligibilityVerificationDto>> {
  if (!isVerificationUuid(verificationId)) return contextError('invalid eligibility verification id')
  const row = await findVerificationById(verificationId)
  if (!row) return { ok: false, code: 'NOT_FOUND', message: 'eligibility verification not found' }
  return { ok: true, value: toVerificationDto(row, new Date()) }
}

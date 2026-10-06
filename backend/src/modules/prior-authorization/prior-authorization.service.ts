import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { lockRowForUpdate } from '../../shared/database/row-lock.ts'
import { concurrencyProbe } from '../../shared/testing/concurrency-probe.ts'
import { recordAuditEvent } from '../audit/audit.service.ts'
// A4.3 owns commercial coherence. Its decision is reused here exactly as written — A5.3 defines no
// second rule about payers, TPAs, networks or products, and the readers below are A4.3's own.
import { decideCommercialCoherence } from '../insurance-membership/insurance-membership.validation.ts'
import {
  findInsuranceProductOwnership,
  findNetworkOwnership,
  findPayerOwnership,
  findTpaOwnership,
} from '../insurance-membership/insurance-membership.repository.ts'
import { findProductNetworkByProductAndNetwork } from '../commercial-coverage/insurance-product.repository.ts'
import type {
  AuthorizationContext,
  PriorAuthorizationDto,
  PriorAuthorizationListDto,
  PriorAuthorizationResult,
  PriorAuthorizationVersionDto,
  PriorAuthorizationVersionListDto,
  VersionInput,
} from './prior-authorization.types.ts'
import {
  authorizationAuditSnapshot,
  eligibilityContextMatches,
  isAuthorizationUuid,
  nextVersionNumber,
  toAuthorizationDto,
  toVersionDto,
  validateVersionBody,
  versionAuditSnapshot,
} from './prior-authorization.validation.ts'
import {
  createAuthorizationRecord,
  createEvidenceLinkRecords,
  createVersionRecord,
  findAuthorizationById,
  findAuthorizationsByEncounter,
  findEligibilityVerificationContext,
  findEncounterContext,
  findEvidenceVersionOrganization,
  findLatestVersion,
  findMaxVersionNumber,
  findMembershipCommercialContext,
  findVersionById,
  findVersionsByAuthorization,
} from './prior-authorization.repository.ts'

// A5.3 — recording an authorization case and appending its immutable lifecycle versions.
//
// Two writes exist and both are atomic with their evidence links and audit records: creating a case
// together with its first version, and appending a later version. Nothing else writes. There is no
// update and no delete, because a correction is a new version. There is also no request or submit
// endpoint and nothing here opens a network connection: A5.3 records what an authorization source
// reported, it does not perform an authorization. Real payer transport belongs to A9.
//
// The context a case is frozen against is derived here, inside the transaction, never accepted from
// the caller. The Encounter row is locked first and the selected membership second, so a concurrent
// correction to either cannot land halfway through the snapshot.

function invalid(message: string): PriorAuthorizationResult<never> {
  return { ok: false, code: 'VALIDATION_ERROR', message }
}

type ContextOutcome =
  | { kind: 'ok'; context: AuthorizationContext; organizationId: string }
  | { kind: 'encounter-missing' }
  | { kind: 'membership-missing' }
  | { kind: 'no-membership' }
  | { kind: 'membership-mismatch' }
  | { kind: 'incoherent'; code: 'NOT_FOUND' | 'VALIDATION_ERROR'; message: string }

// Steps 1-7 of §7, in order, inside the caller's transaction.
async function resolveAuthorizationContext(encounterId: string, tx: DbClient): Promise<ContextOutcome> {
  const encounterLocked = await lockRowForUpdate(tx, 'encounters', encounterId)
  if (!encounterLocked) return { kind: 'encounter-missing' }

  await concurrencyProbe('prior_authorization.encounter_locked')

  const encounter = await findEncounterContext(encounterId, tx)
  if (!encounter) return { kind: 'encounter-missing' }

  // An Encounter with no selected membership is not a self-pay authorization: it is an Encounter
  // this package cannot freeze a commercial context against. Manufacturing a meaning from the
  // absence would be an inference A5.3 has no authority to make.
  if (encounter.insuranceMembershipId === null) return { kind: 'no-membership' }

  const membershipLocked = await lockRowForUpdate(tx, 'insurance_memberships', encounter.insuranceMembershipId)
  if (!membershipLocked) return { kind: 'membership-missing' }

  await concurrencyProbe('prior_authorization.membership_locked')

  const membership = await findMembershipCommercialContext(encounter.insuranceMembershipId, tx)
  if (!membership) return { kind: 'membership-missing' }
  if (membership.patientId !== encounter.patientId) return { kind: 'membership-mismatch' }

  const organizationId = encounter.patient.organizationId

  // §7 step 5 and §26 — A4.3 checks commercial coherence when a membership is WRITTEN, and nothing
  // re-checks it afterwards. This is the moment those values stop being a live reference and become
  // a frozen snapshot that can never be corrected, so the stored context is re-verified here using
  // A4.3's own decision read through A4.3's own ownership readers. A5.3 defines no second rule.
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
  if (!coherence.ok) return { kind: 'incoherent', code: coherence.code, message: coherence.message }

  return {
    kind: 'ok',
    organizationId,
    context: {
      encounterId: encounter.id,
      insuranceMembershipId: membership.id,
      payerId: membership.payerId,
      tpaId: membership.tpaId,
      networkId: membership.networkId,
      insuranceProductId: membership.insuranceProductId,
      // Copied from the Encounter as it stands under the lock, so a later correction cannot rewrite
      // the provider or date this authorization was recorded for.
      facilityId: encounter.facilityId,
      clinicianId: encounter.clinicianId,
      serviceDate: encounter.serviceDate,
    },
  }
}

type LinkOutcome = { kind: 'ok' } | { kind: 'evidence-not-found' } | { kind: 'eligibility-not-found' } | { kind: 'eligibility-mismatch' }

// Every linked evidence version must belong to the same organization as the Encounter's Patient, and
// an optional eligibility verification must describe the SAME situation this authorization is frozen
// against. Only ownership and context are read; no evidence metadata and no eligibility decision.
async function verifyLinks(
  input: VersionInput,
  context: AuthorizationContext,
  organizationId: string,
  tx: DbClient,
): Promise<LinkOutcome> {
  for (const link of input.evidenceLinks) {
    const version = await findEvidenceVersionOrganization(link.evidenceArtifactVersionId, tx)
    // A missing version and a foreign-tenant version are refused identically, so a caller never
    // learns that another organization's evidence exists.
    if (!version || version.evidenceArtifact.organizationId !== organizationId) return { kind: 'evidence-not-found' }
  }

  if (input.eligibilityVerificationId !== null) {
    const verification = await findEligibilityVerificationContext(input.eligibilityVerificationId, tx)
    if (!verification || verification.encounter.patient.organizationId !== organizationId) return { kind: 'eligibility-not-found' }
    // The link is provenance, not a decision input: the verification's status and freshness are
    // never consulted. What must hold is that it describes the same encounter, membership,
    // commercial context and service date.
    if (!eligibilityContextMatches(context, verification)) return { kind: 'eligibility-mismatch' }
  }

  return { kind: 'ok' }
}

function surfaceContext(outcome: ContextOutcome): PriorAuthorizationResult<never> | null {
  if (outcome.kind === 'encounter-missing') return { ok: false, code: 'NOT_FOUND', message: 'encounter not found' }
  if (outcome.kind === 'membership-missing') return { ok: false, code: 'NOT_FOUND', message: 'the selected insurance membership was not found' }
  if (outcome.kind === 'no-membership')
    return invalid('the encounter has no selected insurance membership, so there is no commercial context to authorize against')
  if (outcome.kind === 'membership-mismatch') return invalid('the selected insurance membership does not belong to the encounter patient')
  // A4.3's own wording is passed through unchanged: it names which master is wrong without revealing
  // that an id belongs to another organization.
  if (outcome.kind === 'incoherent') return { ok: false, code: outcome.code, message: outcome.message }
  return null
}

function surfaceLinks(outcome: LinkOutcome): PriorAuthorizationResult<never> | null {
  if (outcome.kind === 'evidence-not-found') return { ok: false, code: 'NOT_FOUND', message: 'an evidence version was not found' }
  if (outcome.kind === 'eligibility-not-found') return { ok: false, code: 'NOT_FOUND', message: 'eligibilityVerificationId was not found' }
  if (outcome.kind === 'eligibility-mismatch')
    return invalid('the eligibility verification was recorded for a different encounter, membership, commercial context or service date')
  return null
}

export async function createPriorAuthorization(
  encounterId: string,
  body: unknown,
  actorUserId: string,
): Promise<PriorAuthorizationResult<PriorAuthorizationDto>> {
  if (!isAuthorizationUuid(encounterId)) return invalid('invalid encounter id')

  const validated = validateVersionBody(body, 'first')
  if (!validated.ok) return invalid(validated.message)
  const input = validated.value

  const outcome = await prisma.$transaction(async (tx) => {
    const resolved = await resolveAuthorizationContext(encounterId, tx)
    if (resolved.kind !== 'ok') return { kind: 'context' as const, outcome: resolved }

    const links = await verifyLinks(input, resolved.context, resolved.organizationId, tx)
    if (links.kind !== 'ok') return { kind: 'links' as const, outcome: links }

    // The case, its version 1, the evidence links and both audit records are one transaction. An
    // authorization case with no version, or a version nobody can point evidence at, would be a
    // record of nothing.
    const authorization = await createAuthorizationRecord(resolved.context, tx)
    const version = await createVersionRecord(authorization.id, 1, input, actorUserId, tx)
    const evidenceLinks = await createEvidenceLinkRecords(version.id, input.evidenceLinks, tx)

    await recordAuditEvent(
      {
        organizationId: resolved.organizationId,
        actorUserId,
        actionCode: 'prior_authorization.created',
        entityType: 'PRIOR_AUTHORIZATION',
        entityId: authorization.id,
        beforeState: null,
        afterState: authorizationAuditSnapshot(authorization),
      },
      tx,
    )
    await recordAuditEvent(
      {
        organizationId: resolved.organizationId,
        actorUserId,
        actionCode: 'prior_authorization_version.created',
        entityType: 'PRIOR_AUTHORIZATION_VERSION',
        entityId: version.id,
        beforeState: null,
        afterState: versionAuditSnapshot(version),
      },
      tx,
    )

    // Acceptance forces a failure here to prove the whole unit rolls back. In normal operation it
    // is a no-op.
    await concurrencyProbe('prior_authorization.created')

    return { kind: 'created' as const, authorization, version, evidenceLinks }
  })

  if (outcome.kind === 'context') return surfaceContext(outcome.outcome) as PriorAuthorizationResult<PriorAuthorizationDto>
  if (outcome.kind === 'links') return surfaceLinks(outcome.outcome) as PriorAuthorizationResult<PriorAuthorizationDto>

  return {
    ok: true,
    value: toAuthorizationDto(outcome.authorization, toVersionDto({ ...outcome.version, evidenceLinks: outcome.evidenceLinks })),
  }
}

export async function appendPriorAuthorizationVersion(
  authorizationId: string,
  body: unknown,
  actorUserId: string,
): Promise<PriorAuthorizationResult<PriorAuthorizationVersionDto>> {
  if (!isAuthorizationUuid(authorizationId)) return invalid('invalid prior authorization id')

  const validated = validateVersionBody(body, 'append')
  if (!validated.ok) return invalid(validated.message)
  const input = validated.value

  const outcome = await prisma.$transaction(async (tx) => {
    // Lock the authorization case first. Every append for this case serializes here, so the maximum
    // version read below cannot be invalidated between reading it and claiming the next number.
    const locked = await lockRowForUpdate(tx, 'prior_authorizations', authorizationId)
    if (!locked) return { kind: 'missing' as const }

    await concurrencyProbe('prior_authorization_version.locked')

    const authorization = await tx.priorAuthorization.findUniqueOrThrow({
      where: { id: authorizationId },
      select: {
        id: true,
        encounterId: true,
        insuranceMembershipId: true,
        payerId: true,
        tpaId: true,
        networkId: true,
        insuranceProductId: true,
        facilityId: true,
        clinicianId: true,
        serviceDate: true,
        encounter: { select: { patient: { select: { organizationId: true } } } },
      },
    })
    const organizationId = authorization.encounter.patient.organizationId

    // An appended version is checked against the context the CASE was frozen against, not against
    // the Encounter as it stands now. The case is immutable, so that frozen context is what the new
    // snapshot belongs to.
    const links = await verifyLinks(input, authorization, organizationId, tx)
    if (links.kind !== 'ok') return { kind: 'links' as const, outcome: links }

    const currentMax = await findMaxVersionNumber(authorizationId, tx)
    const version = await createVersionRecord(authorizationId, nextVersionNumber(currentMax), input, actorUserId, tx)
    const evidenceLinks = await createEvidenceLinkRecords(version.id, input.evidenceLinks, tx)

    await recordAuditEvent(
      {
        organizationId,
        actorUserId,
        actionCode: 'prior_authorization_version.created',
        entityType: 'PRIOR_AUTHORIZATION_VERSION',
        entityId: version.id,
        beforeState: null,
        afterState: versionAuditSnapshot(version),
      },
      tx,
    )

    await concurrencyProbe('prior_authorization_version.created')

    return { kind: 'created' as const, version, evidenceLinks }
  })

  if (outcome.kind === 'missing') return { ok: false, code: 'NOT_FOUND', message: 'prior authorization not found' }
  if (outcome.kind === 'links') return surfaceLinks(outcome.outcome) as PriorAuthorizationResult<PriorAuthorizationVersionDto>

  return { ok: true, value: toVersionDto({ ...outcome.version, evidenceLinks: outcome.evidenceLinks }) }
}

export async function listPriorAuthorizations(encounterId: string): Promise<PriorAuthorizationResult<PriorAuthorizationListDto>> {
  if (!isAuthorizationUuid(encounterId)) return invalid('invalid encounter id')
  const rows = await findAuthorizationsByEncounter(encounterId)
  return {
    ok: true,
    value: {
      // Every case has a version 1, so the include always yields one; the guard is here because a
      // case that somehow had none would be a broken record, not an empty list entry.
      items: rows.filter((row) => row.versions.length > 0).map((row) => toAuthorizationDto(row, toVersionDto(row.versions[0]))),
    },
  }
}

export async function getPriorAuthorization(authorizationId: string): Promise<PriorAuthorizationResult<PriorAuthorizationDto>> {
  if (!isAuthorizationUuid(authorizationId)) return invalid('invalid prior authorization id')
  const row = await findAuthorizationById(authorizationId)
  if (!row) return { ok: false, code: 'NOT_FOUND', message: 'prior authorization not found' }
  const latest = await findLatestVersion(authorizationId)
  if (!latest) return { ok: false, code: 'NOT_FOUND', message: 'prior authorization not found' }
  return { ok: true, value: toAuthorizationDto(row, toVersionDto(latest)) }
}

export async function listPriorAuthorizationVersions(
  authorizationId: string,
): Promise<PriorAuthorizationResult<PriorAuthorizationVersionListDto>> {
  if (!isAuthorizationUuid(authorizationId)) return invalid('invalid prior authorization id')
  const rows = await findVersionsByAuthorization(authorizationId)
  if (rows.length === 0) return { ok: false, code: 'NOT_FOUND', message: 'prior authorization not found' }
  return { ok: true, value: { items: rows.map((row) => toVersionDto(row)) } }
}

export async function getPriorAuthorizationVersion(versionId: string): Promise<PriorAuthorizationResult<PriorAuthorizationVersionDto>> {
  if (!isAuthorizationUuid(versionId)) return invalid('invalid prior authorization version id')
  const row = await findVersionById(versionId)
  if (!row) return { ok: false, code: 'NOT_FOUND', message: 'prior authorization version not found' }
  return { ok: true, value: toVersionDto(row) }
}

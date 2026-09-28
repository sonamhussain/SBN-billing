import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import type { VerificationContext, VerificationInput } from './eligibility-verification.types.ts'

// A5.2 — Prisma access only. Every read is a minimal projection: authorization must be able to
// resolve ownership without ever loading a member identifier, a policy identifier or any evidence
// metadata, because a read that pulls those before the caller is authorized has already exposed
// them.
//
// There is deliberately no update, delete or upsert function anywhere in this file. A correction to
// a verification is a new verification, and the database refuses the alternative outright.

// Ownership for an Encounter-nested route, resolved through the Encounter's Patient.
export async function findEncounterOwnership(encounterId: string, db: DbClient = prisma) {
  return db.encounter.findUnique({ where: { id: encounterId }, select: { patient: { select: { organizationId: true } } } })
}

// The Encounter facts a verification is recorded against. Read inside the write transaction, after
// the row is locked, so the service decides on state that cannot change underneath it.
export async function findEncounterContext(encounterId: string, db: DbClient) {
  return db.encounter.findUnique({
    where: { id: encounterId },
    select: {
      id: true,
      patientId: true,
      insuranceMembershipId: true,
      serviceDate: true,
      // The owning organization is read here, under the Encounter lock, so the evidence-tenancy
      // check below uses the same state the snapshot is taken from.
      patient: { select: { organizationId: true } },
    },
  })
}

// The commercial context carried by the selected membership. memberIdentifier and policyIdentifier
// are deliberately not selected: A5.2 never copies them, so it never reads them either.
export async function findMembershipCommercialContext(membershipId: string, db: DbClient) {
  return db.insuranceMembership.findUnique({
    where: { id: membershipId },
    select: { id: true, patientId: true, payerId: true, tpaId: true, networkId: true, insuranceProductId: true },
  })
}

// An evidence version's owning organization, resolved through its artifact. Only the organization
// is read — never the storage reference, hash or document type, which A5.2 has no business seeing.
export async function findEvidenceVersionOrganization(versionId: string, db: DbClient) {
  return db.evidenceArtifactVersion.findUnique({
    where: { id: versionId },
    select: { id: true, evidenceArtifact: { select: { organizationId: true } } },
  })
}

export async function createVerificationRecord(context: VerificationContext, input: VerificationInput, db: DbClient) {
  return db.eligibilityVerification.create({
    data: {
      encounterId: context.encounterId,
      insuranceMembershipId: context.insuranceMembershipId,
      serviceDate: context.serviceDate,
      payerId: context.payerId,
      tpaId: context.tpaId,
      networkId: context.networkId,
      insuranceProductId: context.insuranceProductId,
      verificationMethod: input.verificationMethod,
      status: input.status,
      requestedAt: input.requestedAt,
      respondedAt: input.respondedAt,
      validThrough: input.validThrough,
      authorizationRequired: input.authorizationRequired,
      referralRequired: input.referralRequired,
      requestEvidenceVersionId: input.requestEvidenceVersionId,
      responseEvidenceVersionId: input.responseEvidenceVersionId,
    },
  })
}

export async function findVerificationById(id: string, db: DbClient = prisma) {
  return db.eligibilityVerification.findUnique({ where: { id } })
}

// Ownership for a by-id read, resolved through the verification's Encounter and that Encounter's
// Patient. Nothing about the verification itself is returned, so a caller who is refused learns
// only that they may not have it.
export async function findVerificationOwnership(id: string, db: DbClient = prisma) {
  return db.eligibilityVerification.findUnique({
    where: { id },
    select: { encounter: { select: { patient: { select: { organizationId: true } } } } },
  })
}

// A history reads newest first. The order is fully deterministic — respondedAt, then createdAt,
// then id — so two verifications recorded in the same instant never swap places between reads.
// This is an ordering, not a ranking: nothing here names a current or winning verification.
export async function findVerificationsByEncounter(encounterId: string, db: DbClient = prisma) {
  return db.eligibilityVerification.findMany({
    where: { encounterId },
    orderBy: [{ respondedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
  })
}

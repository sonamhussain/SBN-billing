import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import type { AuthorizationContext, EvidenceLinkInput, VersionInput } from './prior-authorization.types.ts'

// A5.3 — Prisma access only. Every read is a minimal projection: authorization must be able to
// resolve ownership without loading a member identifier, a policy identifier or any evidence
// metadata, because a read that pulls those before the caller is authorized has already exposed
// them.
//
// There is deliberately no update, delete or upsert function anywhere in this file. A correction to
// an authorization is a new version, and the database refuses the alternative outright.

const versionInclude = {
  evidenceLinks: { orderBy: [{ role: 'asc' as const }, { createdAt: 'asc' as const }, { id: 'asc' as const }] },
}

// Ownership for an Encounter-nested route, resolved through the Encounter's Patient.
export async function findEncounterOwnership(encounterId: string, db: DbClient = prisma) {
  return db.encounter.findUnique({ where: { id: encounterId }, select: { patient: { select: { organizationId: true } } } })
}

// The Encounter facts an authorization case is frozen against. Read inside the write transaction,
// after the row is locked, so the service decides on state that cannot change underneath it.
export async function findEncounterContext(encounterId: string, db: DbClient) {
  return db.encounter.findUnique({
    where: { id: encounterId },
    select: {
      id: true,
      patientId: true,
      insuranceMembershipId: true,
      serviceDate: true,
      facilityId: true,
      clinicianId: true,
      patient: { select: { organizationId: true } },
    },
  })
}

// The commercial context carried by the selected membership. memberIdentifier and policyIdentifier
// are deliberately not selected: A5.3 never copies them, so it never reads them either.
export async function findMembershipCommercialContext(membershipId: string, db: DbClient) {
  return db.insuranceMembership.findUnique({
    where: { id: membershipId },
    select: { id: true, patientId: true, payerId: true, tpaId: true, networkId: true, insuranceProductId: true },
  })
}

// An evidence version's owning organization, resolved through its artifact. Only the organization is
// read — never the storage reference, hash or document type, which A5.3 has no business seeing.
export async function findEvidenceVersionOrganization(versionId: string, db: DbClient) {
  return db.evidenceArtifactVersion.findUnique({
    where: { id: versionId },
    select: { id: true, evidenceArtifact: { select: { organizationId: true } } },
  })
}

// The A5.2 verification's own frozen context, for the exact-match check. Its status and validity are
// deliberately not selected: A5.3 links a verification, it never reads its decision.
export async function findEligibilityVerificationContext(verificationId: string, db: DbClient) {
  return db.eligibilityVerification.findUnique({
    where: { id: verificationId },
    select: {
      id: true,
      encounterId: true,
      insuranceMembershipId: true,
      payerId: true,
      tpaId: true,
      networkId: true,
      insuranceProductId: true,
      serviceDate: true,
      encounter: { select: { patient: { select: { organizationId: true } } } },
    },
  })
}

export async function createAuthorizationRecord(context: AuthorizationContext, db: DbClient) {
  return db.priorAuthorization.create({ data: { ...context } })
}

export async function createVersionRecord(
  priorAuthorizationId: string,
  version: number,
  input: VersionInput,
  createdByUserId: string,
  db: DbClient,
) {
  return db.priorAuthorizationVersion.create({
    data: {
      priorAuthorizationId,
      version,
      versionKind: input.versionKind,
      status: input.status,
      authorizationReference: input.authorizationReference,
      eligibilityVerificationId: input.eligibilityVerificationId,
      requestedAt: input.requestedAt,
      respondedAt: input.respondedAt,
      validFrom: input.validFrom,
      validThrough: input.validThrough,
      createdByUserId,
    },
  })
}

export async function createEvidenceLinkRecords(versionId: string, links: EvidenceLinkInput[], db: DbClient) {
  return db.priorAuthorizationVersionEvidence.createManyAndReturn({
    data: links.map((link) => ({
      priorAuthorizationVersionId: versionId,
      evidenceArtifactVersionId: link.evidenceArtifactVersionId,
      role: link.role,
    })),
  })
}

export async function findAuthorizationById(id: string, db: DbClient = prisma) {
  return db.priorAuthorization.findUnique({ where: { id } })
}

// Ownership for a by-id read, resolved through the authorization's Encounter and that Encounter's
// Patient. Nothing about the authorization itself is returned, so a caller who is refused learns
// only that they may not have it.
export async function findAuthorizationOwnership(id: string, db: DbClient = prisma) {
  return db.priorAuthorization.findUnique({
    where: { id },
    select: { encounter: { select: { patient: { select: { organizationId: true } } } } },
  })
}

export async function findVersionOwnership(id: string, db: DbClient = prisma) {
  return db.priorAuthorizationVersion.findUnique({
    where: { id },
    select: { priorAuthorization: { select: { encounter: { select: { patient: { select: { organizationId: true } } } } } } },
  })
}

export async function findVersionById(id: string, db: DbClient = prisma) {
  return db.priorAuthorizationVersion.findUnique({ where: { id }, include: versionInclude })
}

// A history reads forwards: version ascending, so the sequence of what actually happened is read in
// the order it happened.
export async function findVersionsByAuthorization(priorAuthorizationId: string, db: DbClient = prisma) {
  return db.priorAuthorizationVersion.findMany({
    where: { priorAuthorizationId },
    orderBy: { version: 'asc' },
    include: versionInclude,
  })
}

// The most recently recorded version. This is "latest recorded" and nothing more: it is not the
// current, usable or satisfied version.
export async function findLatestVersion(priorAuthorizationId: string, db: DbClient = prisma) {
  return db.priorAuthorizationVersion.findFirst({
    where: { priorAuthorizationId },
    orderBy: { version: 'desc' },
    include: versionInclude,
  })
}

// Parent list ordering is deterministic and carries no ranking: created order, then id. Nothing here
// names a primary or current authorization case.
export async function findAuthorizationsByEncounter(encounterId: string, db: DbClient = prisma) {
  return db.priorAuthorization.findMany({
    where: { encounterId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { versions: { orderBy: { version: 'desc' }, take: 1, include: versionInclude } },
  })
}

export async function findMaxVersionNumber(priorAuthorizationId: string, db: DbClient): Promise<number | null> {
  const row = await db.priorAuthorizationVersion.aggregate({
    where: { priorAuthorizationId },
    _max: { version: true },
  })
  return row._max.version
}

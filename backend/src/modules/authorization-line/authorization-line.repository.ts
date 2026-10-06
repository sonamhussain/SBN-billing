import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import type { AuthorizationLineInput } from './authorization-line.types.ts'

// A5.4 — Prisma access only. Every ownership read is a minimal projection through the parent chain
// PriorAuthorizationVersion -> PriorAuthorization -> Encounter -> Patient, so authorization can be
// decided without loading a member identifier, a policy identifier, an authorization reference or
// any evidence metadata.
//
// There is deliberately no update, delete or upsert function anywhere in this file, and nothing that
// writes a match result: matching is computed on every read and never stored.
//
// Service, ProcedureCode and DiagnosisCode ownership is read with A4.6 and A4.5's own readers, which
// the service imports directly rather than this file re-declaring them.

const organizationOfVersion = {
  priorAuthorization: { select: { encounter: { select: { patient: { select: { organizationId: true } } } } } },
} as const

export async function findVersionOwnership(versionId: string, db: DbClient = prisma) {
  return db.priorAuthorizationVersion.findUnique({ where: { id: versionId }, select: organizationOfVersion })
}

export async function findLineOwnership(lineId: string, db: DbClient = prisma) {
  return db.authorizationLine.findUnique({
    where: { id: lineId },
    select: { priorAuthorizationVersion: { select: organizationOfVersion } },
  })
}

// The version facts line capture needs: that it exists and which organization owns it. Nothing else.
export async function findVersionOrganization(versionId: string, db: DbClient) {
  return db.priorAuthorizationVersion.findUnique({
    where: { id: versionId },
    select: { id: true, ...organizationOfVersion },
  })
}

export async function countLinesForVersion(versionId: string, db: DbClient) {
  return db.authorizationLine.count({ where: { priorAuthorizationVersionId: versionId } })
}

// sequence is assigned here from the array position and nowhere else: 1..N, in submitted order.
export async function createLineRecords(versionId: string, lines: AuthorizationLineInput[], createdByUserId: string, db: DbClient) {
  return db.authorizationLine.createManyAndReturn({
    data: lines.map((line, index) => ({
      priorAuthorizationVersionId: versionId,
      sequence: index + 1,
      serviceId: line.serviceId,
      procedureCodeId: line.procedureCodeId,
      diagnosisCodeId: line.diagnosisCodeId,
      // Exact decimal strings go to NUMERIC(18,4) unchanged; no Number() conversion anywhere.
      requestedQty: line.requestedQty,
      approvedQty: line.approvedQty,
      unitCode: line.unitCode,
      approvedFrom: line.approvedFrom,
      approvedThrough: line.approvedThrough,
      status: line.status,
      createdByUserId,
    })),
  })
}

// Sequence ascending: the order the source reported the lines in. Display order only, never
// precedence.
export async function findLinesByVersion(versionId: string, db: DbClient = prisma) {
  return db.authorizationLine.findMany({ where: { priorAuthorizationVersionId: versionId }, orderBy: { sequence: 'asc' } })
}

export async function findLineById(lineId: string, db: DbClient = prisma) {
  return db.authorizationLine.findUnique({ where: { id: lineId } })
}

export async function versionExists(versionId: string, db: DbClient = prisma) {
  return (await db.priorAuthorizationVersion.findUnique({ where: { id: versionId }, select: { id: true } })) !== null
}

// The exact version's header facts and the frozen context of its parent case — what scope
// evaluation compares against the Encounter as it stands now. The authorization reference, the
// eligibility link and the evidence links are deliberately not selected: scope evaluation does not
// use them, so it does not read them.
export async function findVersionForEvaluation(versionId: string, db: DbClient) {
  return db.priorAuthorizationVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      status: true,
      validFrom: true,
      validThrough: true,
      priorAuthorization: {
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
        },
      },
    },
  })
}

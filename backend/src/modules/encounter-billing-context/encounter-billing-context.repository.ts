import type { DbClient } from '../../shared/database/database.types.ts'
import { findExternalIdentifiersForEncounterContext } from '../external-identifier/external-identifier.repository.ts'

// A4.9 — data loading only. Every function here takes the caller's transaction client, because the
// whole bundle must come from ONE snapshot: a context assembled from several independent
// connections could combine facts that were never true together.
//
// Two rules shape these queries:
//
// 1. The provider and regulatory rows are fetched BY THEIR STORED IDS. There is deliberately no
//    query here that resolves an assignment from clinician/facility/date, or a profile from
//    facility/date/status. A4.4 already decided those at write time, and a later administrative
//    change does not authorize substituting a newer row into a historical context.
// 2. Only what the contract needs is selected. The Patient projection in particular omits phone and
//    email: this is a billing handoff, and no downstream requirement has proven a need for contact
//    details.

export async function findEncounterForBillingContext(encounterId: string, db: DbClient) {
  return db.encounter.findUnique({
    where: { id: encounterId },
    select: {
      id: true,
      patientId: true,
      facilityId: true,
      clinicianId: true,
      insuranceMembershipId: true,
      serviceDate: true,
      clinicianFacilityAssignmentId: true,
      facilityRegulatoryProfileId: true,
      createdAt: true,
      updatedAt: true,
      // The billing-identity projection. mobilePhone and email are intentionally absent.
      patient: {
        select: {
          id: true,
          organizationId: true,
          givenName: true,
          middleName: true,
          familyName: true,
          dateOfBirth: true,
          updatedAt: true,
        },
      },
      facility: { select: { id: true, name: true } },
      clinician: { select: { id: true, displayName: true } },
      insuranceMembership: true,
    },
  })
}

// BY STORED ID ONLY. Never by clinician/facility/serviceDate.
export async function findStoredAssignment(assignmentId: string, db: DbClient) {
  return db.clinicianFacilityAssignment.findUnique({ where: { id: assignmentId } })
}

// BY STORED ID ONLY. Never by facility/serviceDate, and never filtered on status: the profile's
// current lifecycle state must not decide which historical row an encounter bound itself to.
export async function findStoredRegulatoryProfile(profileId: string, db: DbClient) {
  return db.facilityRegulatoryProfile.findUnique({ where: { id: profileId } })
}

// Active diagnoses in recorded order, with the code master joined so the DTO carries code and
// display name without A4.9 inventing a snapshot of them.
export async function findActiveDiagnoses(encounterId: string, db: DbClient) {
  return db.encounterDiagnosis.findMany({
    where: { encounterId, removedAt: null },
    orderBy: { sequence: 'asc' },
    include: { diagnosisCode: { select: { code: true, displayName: true } } },
  })
}

// Active activities with their modifiers in stored order.
export async function findActiveActivities(encounterId: string, db: DbClient) {
  return db.encounterActivity.findMany({
    where: { encounterId, removedAt: null },
    orderBy: { createdAt: 'asc' },
    include: { modifiers: { orderBy: { sequence: 'asc' } } },
  })
}

// Active observations, each with the anchor state A4.9 must verify: which encounter the anchored
// activity belongs to, and whether it has since been removed.
export async function findActiveObservations(encounterId: string, db: DbClient) {
  return db.encounterObservation.findMany({
    where: { encounterId, removedAt: null },
    orderBy: { createdAt: 'asc' },
    include: { encounterActivity: { select: { id: true, encounterId: true, removedAt: true } } },
  })
}

export { findExternalIdentifiersForEncounterContext }

// The transaction's own timestamp. `new Date()` would be the application clock, which can differ
// from the database's and would not correspond to the snapshot the bundle was read from.
export async function readTransactionTimestamp(db: DbClient): Promise<Date> {
  const rows = await db.$queryRaw<{ ts: Date }[]>`SELECT transaction_timestamp() AS ts`
  return rows[0].ts
}

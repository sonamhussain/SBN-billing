import type { DbClient } from '../../shared/database/database.types.ts'
import { isExternalIdentifierUuid } from './external-identifier.validation.ts'

export const targetTypes = [
  'ORGANIZATION',
  'FACILITY',
  'CLINICIAN',
  'SPECIALTY',
  'PAYER',
  'TPA',
  'NETWORK',
  'SERVICE',
  'PROCEDURE_CODE',
  'DIAGNOSIS_CODE',
  // A4.8 — the two additive targets. A2.9 was built with typed nullable FKs precisely so
  // this list could grow without a second identity model; nothing else is added here.
  'PATIENT',
  'ENCOUNTER',
] as const

export type TargetType = (typeof targetTypes)[number]

export function isTargetType(value: unknown): value is TargetType {
  return typeof value === 'string' && (targetTypes as readonly string[]).includes(value)
}

const targetForeignKeyColumns: Record<TargetType, string> = {
  ORGANIZATION: 'organizationTargetId',
  FACILITY: 'facilityId',
  CLINICIAN: 'clinicianId',
  SPECIALTY: 'specialtyId',
  PAYER: 'payerId',
  TPA: 'tpaId',
  NETWORK: 'networkId',
  SERVICE: 'serviceId',
  PROCEDURE_CODE: 'procedureCodeId',
  DIAGNOSIS_CODE: 'diagnosisCodeId',
  PATIENT: 'patientId',
  ENCOUNTER: 'encounterId',
}

export function targetForeignKeyColumn(type: TargetType): string {
  return targetForeignKeyColumns[type]
}

export type PersistedTargetColumns = {
  organizationTargetId: string | null
  facilityId: string | null
  clinicianId: string | null
  specialtyId: string | null
  payerId: string | null
  tpaId: string | null
  networkId: string | null
  serviceId: string | null
  procedureCodeId: string | null
  diagnosisCodeId: string | null
  patientId: string | null
  encounterId: string | null
}

export function deriveTargetFromRecord(record: PersistedTargetColumns): { type: TargetType; id: string } {
  if (record.organizationTargetId) return { type: 'ORGANIZATION', id: record.organizationTargetId }
  if (record.facilityId) return { type: 'FACILITY', id: record.facilityId }
  if (record.clinicianId) return { type: 'CLINICIAN', id: record.clinicianId }
  if (record.specialtyId) return { type: 'SPECIALTY', id: record.specialtyId }
  if (record.payerId) return { type: 'PAYER', id: record.payerId }
  if (record.tpaId) return { type: 'TPA', id: record.tpaId }
  if (record.networkId) return { type: 'NETWORK', id: record.networkId }
  if (record.serviceId) return { type: 'SERVICE', id: record.serviceId }
  if (record.procedureCodeId) return { type: 'PROCEDURE_CODE', id: record.procedureCodeId }
  if (record.diagnosisCodeId) return { type: 'DIAGNOSIS_CODE', id: record.diagnosisCodeId }
  if (record.patientId) return { type: 'PATIENT', id: record.patientId }
  if (record.encounterId) return { type: 'ENCOUNTER', id: record.encounterId }
  throw new Error('external identifier record has no target set')
}

export type ResolvedTarget = { type: TargetType; id: string; organizationId: string }

export type ResolveTargetResult =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; reason: 'INVALID_TYPE' | 'INVALID_ID' | 'NOT_FOUND' }

async function lookupTargetOwner(
  type: TargetType,
  id: string,
  db: DbClient,
): Promise<{ id: string; organizationId: string } | null> {
  switch (type) {
    case 'ORGANIZATION': {
      const record = await db.organization.findUnique({ where: { id } })
      return record ? { id: record.id, organizationId: record.id } : null
    }
    case 'FACILITY': {
      const record = await db.facility.findUnique({ where: { id } })
      return record ? { id: record.id, organizationId: record.organizationId } : null
    }
    case 'CLINICIAN': {
      const record = await db.clinician.findUnique({ where: { id } })
      return record ? { id: record.id, organizationId: record.organizationId } : null
    }
    case 'SPECIALTY': {
      const record = await db.specialty.findUnique({ where: { id } })
      return record ? { id: record.id, organizationId: record.organizationId } : null
    }
    case 'PAYER': {
      const record = await db.payer.findUnique({ where: { id } })
      return record ? { id: record.id, organizationId: record.organizationId } : null
    }
    case 'TPA': {
      const record = await db.tpa.findUnique({ where: { id } })
      return record ? { id: record.id, organizationId: record.organizationId } : null
    }
    case 'NETWORK': {
      const record = await db.network.findUnique({ where: { id } })
      return record ? { id: record.id, organizationId: record.organizationId } : null
    }
    case 'SERVICE': {
      const record = await db.service.findUnique({ where: { id } })
      return record ? { id: record.id, organizationId: record.organizationId } : null
    }
    case 'PROCEDURE_CODE': {
      const record = await db.procedureCode.findUnique({ where: { id } })
      return record ? { id: record.id, organizationId: record.organizationId } : null
    }
    case 'DIAGNOSIS_CODE': {
      const record = await db.diagnosisCode.findUnique({ where: { id } })
      return record ? { id: record.id, organizationId: record.organizationId } : null
    }
    // A4.8 — external identity needs ownership and nothing else, so these two read the
    // narrowest possible projection. A Patient row carries names, date of birth, phone and
    // email; selecting the whole row to answer "who owns this?" would pull that into memory
    // for no reason. The A4.4 regulatory/provider resolution is deliberately not reused.
    case 'PATIENT': {
      const record = await db.patient.findUnique({ where: { id }, select: { id: true, organizationId: true } })
      return record ? { id: record.id, organizationId: record.organizationId } : null
    }
    // An Encounter has no organizationId of its own: ownership is derived through its Patient,
    // which is the single canonical source. A foreign Encounter therefore resolves to a foreign
    // organization and is refused by the caller, never adopted.
    case 'ENCOUNTER': {
      const record = await db.encounter.findUnique({
        where: { id },
        select: { id: true, patient: { select: { organizationId: true } } },
      })
      return record ? { id: record.id, organizationId: record.patient.organizationId } : null
    }
  }
}

export async function resolveTarget(input: unknown, db: DbClient): Promise<ResolveTargetResult> {
  if (typeof input !== 'object' || input === null) return { ok: false, reason: 'INVALID_TYPE' }

  const { type, id } = input as { type?: unknown; id?: unknown }

  if (!isTargetType(type)) return { ok: false, reason: 'INVALID_TYPE' }
  if (typeof id !== 'string' || !isExternalIdentifierUuid(id)) return { ok: false, reason: 'INVALID_ID' }

  const owner = await lookupTargetOwner(type, id, db)
  if (!owner) return { ok: false, reason: 'NOT_FOUND' }

  return { ok: true, target: { type, id: owner.id, organizationId: owner.organizationId } }
}

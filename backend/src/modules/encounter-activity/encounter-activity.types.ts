import type { Prisma } from '../../../generated/prisma/client.ts'

// A4.6 — EncounterActivity answers: which service/procedure activity was recorded under this
// Encounter, in what exact quantity, with which optional unit and ordered modifier codes, and
// whether it was later removed/corrected. It does not decide claim-line order, price, tariff,
// diagnosis pointers, eligibility, authorization sufficiency, medical necessity or payer acceptance.

export type EncounterActivityDto = {
  id: string
  encounterId: string
  serviceId: string | null
  procedureCodeId: string | null
  // Canonical decimal string (never a JavaScript binary float).
  quantity: string
  unitCode: string | null
  // In stored order (modifier sequence 1..N).
  modifierCodes: string[]
  removedAt: string | null
  createdAt: string
  updatedAt: string
}

export type EncounterActivityCreateInput = {
  serviceId: string | null
  procedureCodeId: string | null
  quantity: Prisma.Decimal
  unitCode: string | null
  modifierCodes: string[]
}

export type EncounterActivityErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN' | 'INTEGRITY_CONFLICT'

export type EncounterActivityResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: EncounterActivityErrorCode; message: string }

// The only fields a client may supply on create; the remove body must be empty.
export const createBodyFields = ['serviceId', 'procedureCodeId', 'quantity', 'unitCode', 'modifierCodes'] as const
// Server-owned fields named explicitly so a forged value is reported as such.
export const serverOwnedFields = ['id', 'encounterId', 'removedAt', 'createdAt', 'updatedAt'] as const

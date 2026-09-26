import type { Prisma } from '../../../generated/prisma/client.ts'

// A4.7 — EncounterObservation answers: what additional structured billing fact was recorded, was it
// about the Encounter generally or one Activity, what was its exact typed value, and was it later
// corrected/removed. It never executes the fact: no operator, formula, condition, rule, clinical
// meaning, eligibility, authorization, pricing, claim or payer semantics.

// The four approved typed values. There is deliberately no CODE, JSON, list or expression type.
export type ObservationValue =
  | { type: 'TEXT'; text: string }
  | { type: 'DECIMAL'; decimal: string; unitCode: string | null }
  | { type: 'BOOLEAN'; boolean: boolean }
  | { type: 'DATE'; date: string }

export const observationValueTypes = ['TEXT', 'DECIMAL', 'BOOLEAN', 'DATE'] as const
export type ObservationValueType = (typeof observationValueTypes)[number]

export type EncounterObservationCreateInput = {
  encounterActivityId: string | null
  factKey: string
  value: ObservationValue
}

// The typed columns one validated value maps onto (exactly one value column is populated).
export type ObservationColumns = {
  factKey: string
  valueType: ObservationValueType
  valueText: string | null
  valueDecimal: Prisma.Decimal | null
  valueBoolean: boolean | null
  valueDate: Date | null
  unitCode: string | null
}

export type EncounterObservationDto = {
  id: string
  encounterId: string
  encounterActivityId: string | null
  factKey: string
  value: ObservationValue
  removedAt: string | null
  createdAt: string
  updatedAt: string
}

export type EncounterObservationErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN' | 'INTEGRITY_CONFLICT'

export type EncounterObservationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: EncounterObservationErrorCode; message: string }

// The only top-level fields a client may supply on create; the remove body must be empty.
export const createBodyFields = ['encounterActivityId', 'factKey', 'value'] as const
// Server-owned fields named explicitly so a forged value is reported as such.
export const serverOwnedFields = ['id', 'encounterId', 'removedAt', 'createdAt', 'updatedAt'] as const

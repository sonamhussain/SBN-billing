// FE-03 — the A4.7 EncounterObservation contract: one structured billing fact with an exact typed value,
// about the Encounter generally or one of its activities. It is recorded only: no operator, formula,
// threshold, rule or clinical meaning is applied anywhere in the frontend.
export type ObservationValue =
  | { type: 'TEXT'; text: string }
  | { type: 'DECIMAL'; decimal: string; unitCode: string | null }
  | { type: 'BOOLEAN'; boolean: boolean }
  | { type: 'DATE'; date: string }

export type ObservationValueType = ObservationValue['type']

export type EncounterObservation = {
  id: string
  encounterId: string
  encounterActivityId: string | null
  factKey: string
  value: ObservationValue
  removedAt: string | null
  createdAt: string
  updatedAt: string
}

export type EncounterObservationInput = {
  encounterActivityId: string | null
  factKey: string
  value: ObservationValue
}

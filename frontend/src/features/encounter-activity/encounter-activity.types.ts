// FE-03 — the A4.6 EncounterActivity contract. Service and ProcedureCode are independent identities (at
// least one is recorded). Quantity is an exact decimal string and is never converted to a JavaScript
// number. Modifier codes are opaque and keep their recorded order. There is no edit: a correction is
// remove + add.
export type EncounterActivity = {
  id: string
  encounterId: string
  serviceId: string | null
  procedureCodeId: string | null
  quantity: string
  unitCode: string | null
  modifierCodes: string[]
  removedAt: string | null
  createdAt: string
  updatedAt: string
}

export type EncounterActivityInput = {
  serviceId: string | null
  procedureCodeId: string | null
  quantity: string
  unitCode: string | null
  modifierCodes: string[]
}

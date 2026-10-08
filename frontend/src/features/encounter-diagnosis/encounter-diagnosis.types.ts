// FE-03 — the A4.5 EncounterDiagnosis contract: which DiagnosisCode is attached to an Encounter and its
// position among the active diagnoses. The position is an order, never a principal/primary meaning.
export type EncounterDiagnosis = {
  id: string
  encounterId: string
  diagnosisCodeId: string
  // 1-based position among the Encounter's active diagnoses.
  sequence: number
  // Joined from the organization's diagnosis code master at read time.
  diagnosisCode: { code: string; displayName: string }
  createdAt: string
  updatedAt: string
}

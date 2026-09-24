// A4.5 — EncounterDiagnosis answers: which A2.8 DiagnosisCode identities are attached to this
// Encounter, in what deterministic order, and what was corrected/removed. It does not decide which
// diagnosis is medically principal, whether a payer accepts it, which procedure it supports,
// whether authorization is satisfied or whether a claim is ready.

export type EncounterDiagnosisDto = {
  id: string
  encounterId: string
  diagnosisCodeId: string
  // 1-based position among the Encounter's active diagnoses.
  sequence: number
  // Joined from the A2.8 master at read time — never stored on the link row.
  diagnosisCode: {
    code: string
    displayName: string
  }
  createdAt: string
  updatedAt: string
}

export type EncounterDiagnosisErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN' | 'INTEGRITY_CONFLICT'

export type EncounterDiagnosisResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: EncounterDiagnosisErrorCode; message: string }

// The only field a client may supply on add; the order and remove bodies are validated separately.
export const addBodyFields = ['diagnosisCodeId'] as const
export const orderBodyFields = ['encounterDiagnosisIds'] as const
// Server-owned fields named explicitly so a forged value is reported as such.
export const serverOwnedFields = ['id', 'encounterId', 'sequence', 'removedAt', 'createdAt', 'updatedAt'] as const

// Offset used by the two-phase sequence rewrite so no intermediate state collides with the active
// (encounter_id, sequence) partial unique index.
export const SEQUENCE_PARKING_OFFSET = 1_000_000

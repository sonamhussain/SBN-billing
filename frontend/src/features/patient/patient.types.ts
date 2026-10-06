// FE-02 — the A4.1 Patient contract exactly as the backend returns it. displayName is derived by the
// backend for display only.
export type Patient = {
  id: string
  organizationId: string
  givenName: string
  middleName: string | null
  familyName: string
  displayName: string
  dateOfBirth: string
  mobilePhone: string | null
  email: string | null
  createdAt: string
  updatedAt: string
}

export type PatientCreateInput = {
  givenName: string
  middleName: string | null
  familyName: string
  dateOfBirth: string
  mobilePhone: string | null
  email: string | null
}

export type PatientPatch = Partial<PatientCreateInput>

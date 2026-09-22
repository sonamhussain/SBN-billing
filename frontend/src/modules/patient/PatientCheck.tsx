import { useState, type FormEvent } from 'react'
import { createPatient, getPatient, listPatients, patchPatient, type Patient, type PatientInput } from './patient.api.ts'

// A4.1 — minimal developer check only: create, list, get, patch and the viewer denial. This is not
// the front-desk registration screen. Synthetic values only; nothing is stored in the browser and
// no demographic value is logged or put into a URL.

const emptyInput: PatientInput = {
  givenName: '',
  middleName: '',
  familyName: '',
  dateOfBirth: '',
  mobilePhone: '',
  email: '',
}

const fields: { key: keyof PatientInput; label: string }[] = [
  { key: 'givenName', label: 'givenName (required)' },
  { key: 'middleName', label: 'middleName (optional)' },
  { key: 'familyName', label: 'familyName (required)' },
  { key: 'dateOfBirth', label: 'dateOfBirth (YYYY-MM-DD, not in the future)' },
  { key: 'mobilePhone', label: 'mobilePhone (optional)' },
  { key: 'email', label: 'email (optional)' },
]

export default function PatientCheck() {
  const [organizationId, setOrganizationId] = useState('')
  const [input, setInput] = useState<PatientInput>(emptyInput)
  const [patientId, setPatientId] = useState('')
  const [patchField, setPatchField] = useState('familyName')
  const [patchValue, setPatchValue] = useState('')
  const [patient, setPatient] = useState<Patient | null>(null)
  const [items, setItems] = useState<Patient[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  function handleCreate(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      const created = await createPatient(organizationId, input)
      setPatient(created)
      setPatientId(created.id)
    })
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Patient Identity Check (A4.1)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. A Patient is one person inside one Organization — it carries no insurance, no facility
        and no encounter, and it cannot be deleted. Duplicate names and dates of birth are allowed on purpose.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleCreate}>
        <input
          className={inputClass}
          value={organizationId}
          onChange={(event) => setOrganizationId(event.target.value)}
          placeholder="Organization UUID"
          aria-label="Organization UUID"
        />
        {fields.map((field) => (
          <input
            key={field.key}
            className={inputClass}
            value={input[field.key]}
            onChange={(event) => setInput((prev) => ({ ...prev, [field.key]: event.target.value }))}
            placeholder={field.label}
            aria-label={field.label}
          />
        ))}
        <button className={buttonClass} disabled={busy} type="submit">
          Create Patient
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className={buttonClass}
          disabled={busy}
          type="button"
          onClick={() => void run(async () => setItems(await listPatients(organizationId)))}
        >
          List Patients
        </button>
        <input
          className={inputClass}
          value={patientId}
          onChange={(event) => setPatientId(event.target.value)}
          placeholder="Patient UUID"
          aria-label="Patient UUID"
        />
        <button className={buttonClass} disabled={busy} type="button" onClick={() => void run(async () => setPatient(await getPatient(patientId)))}>
          Get Patient
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <select className={inputClass} value={patchField} onChange={(event) => setPatchField(event.target.value)} aria-label="Field to patch">
          {fields.map((field) => (
            <option key={field.key} value={field.key}>
              {field.key}
            </option>
          ))}
        </select>
        <input
          className={inputClass}
          value={patchValue}
          onChange={(event) => setPatchValue(event.target.value)}
          placeholder="new value (blank clears an optional field)"
          aria-label="New value"
        />
        <button
          className={buttonClass}
          disabled={busy}
          type="button"
          onClick={() => void run(async () => setPatient(await patchPatient(patientId, { [patchField]: patchValue.trim() === '' ? null : patchValue })))}
        >
          Patch Patient
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {patient && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm">
          <p>
            id: {patient.id} — displayName: <strong>{patient.displayName}</strong>
          </p>
          <p>
            dateOfBirth: {patient.dateOfBirth} — mobilePhone: {patient.mobilePhone ?? 'null'} — email: {patient.email ?? 'null'}
          </p>
          <p>
            organizationId: {patient.organizationId} — updatedAt: {patient.updatedAt}
          </p>
        </div>
      )}

      {items && (
        <p className="mt-3 text-sm text-slate-700">
          {items.length} patient(s) in this organization: {items.map((item) => item.displayName).join(', ') || 'none'}
        </p>
      )}
    </section>
  )
}

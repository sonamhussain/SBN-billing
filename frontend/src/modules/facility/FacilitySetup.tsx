import { useState, type FormEvent } from 'react'
import { createFacility, type Facility } from './facility.api.ts'

export default function FacilitySetup() {
  const [organizationId, setOrganizationId] = useState('')
  const [name, setName] = useState('Synthetic Main Branch')
  const [facility, setFacility] = useState<Facility | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')

    try {
      const created = await createFacility(organizationId, name)
      setFacility(created)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Facility Setup</h2>
      <p className="mt-1 text-sm text-slate-600">Synthetic development data only.</p>

      <form className="mt-4 grid gap-2" onSubmit={handleSubmit}>
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={organizationId}
          onChange={(event) => setOrganizationId(event.target.value)}
          placeholder="Organization SBN UUID"
          aria-label="Organization SBN UUID"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label="Facility name"
        />
        <button
          className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
          disabled={saving}
          type="submit"
        >
          {saving ? 'Saving...' : 'Create Facility'}
        </button>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {facility && (
        <div className="mt-4 rounded-md bg-slate-100 p-3 text-sm">
          <p><strong>Name:</strong> {facility.name}</p>
          <p><strong>SBN ID:</strong> {facility.id}</p>
          <p><strong>Organization ID:</strong> {facility.organizationId}</p>
        </div>
      )}
    </section>
  )
}

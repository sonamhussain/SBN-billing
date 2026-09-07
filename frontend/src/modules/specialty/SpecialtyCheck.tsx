import { useState, type FormEvent } from 'react'
import { createSpecialty, loadSpecialties, type Specialty } from './specialty.api.ts'

export default function SpecialtyCheck() {
  const [organizationId, setOrganizationId] = useState('')
  const [displayName, setDisplayName] = useState('Synthetic Dermatology')
  const [specialties, setSpecialties] = useState<Specialty[] | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await createSpecialty(organizationId, displayName)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleLoad() {
    setLoading(true)
    setError('')
    try {
      setSpecialties(await loadSpecialties(organizationId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Specialty Check</h2>
      <p className="mt-1 text-sm text-slate-600">Synthetic development data only.</p>

      <form className="mt-4 grid gap-2" onSubmit={handleCreate}>
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={organizationId}
          onChange={(event) => setOrganizationId(event.target.value)}
          placeholder="Organization SBN UUID"
          aria-label="Organization SBN UUID"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          aria-label="Specialty display name"
        />
        <div className="flex gap-2">
          <button
            className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
            disabled={saving}
            type="submit"
          >
            {saving ? 'Saving...' : 'Create Specialty'}
          </button>
          <button
            className="rounded-md bg-slate-700 px-4 py-2 text-white disabled:opacity-50"
            disabled={loading}
            type="button"
            onClick={handleLoad}
          >
            {loading ? 'Loading...' : 'Load Specialties'}
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {specialties && specialties.length === 0 && (
        <p className="mt-3 text-sm text-slate-600">No specialties yet.</p>
      )}

      {specialties && specialties.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium text-slate-700">Loaded specialties:</p>
          {specialties.map((item) => (
            <div key={item.id} className="rounded-md bg-slate-100 p-3 text-sm">
              <p><strong>{item.displayName}</strong> — {item.id}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

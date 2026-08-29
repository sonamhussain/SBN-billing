import { useState, type FormEvent } from 'react'
import { createOrganization, type Organization } from './organization.api.ts'

export default function OrganizationSetup() {
  const [name, setName] = useState('Synthetic Demo Polyclinic')
  const [organization, setOrganization] = useState<Organization | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')

    try {
      const created = await createOrganization(name)
      setOrganization(created)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Organization Setup</h2>
      <p className="mt-1 text-sm text-slate-600">Synthetic development data only.</p>

      <form className="mt-4 flex gap-2" onSubmit={handleSubmit}>
        <input
          className="flex-1 rounded-md border border-slate-300 px-3 py-2"
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label="Organization name"
        />
        <button
          className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
          disabled={saving}
          type="submit"
        >
          {saving ? 'Saving...' : 'Create'}
        </button>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {organization && (
        <div className="mt-4 rounded-md bg-slate-100 p-3 text-sm">
          <p><strong>Name:</strong> {organization.name}</p>
          <p><strong>SBN ID:</strong> {organization.id}</p>
        </div>
      )}
    </section>
  )
}

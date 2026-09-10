import { useState, type FormEvent } from 'react'
import {
  createExternalIdentifier,
  loadExternalIdentifiers,
  targetTypes,
  type ExternalIdentifier,
  type TargetType,
} from './external-identifier.api.ts'

export default function ExternalIdentifierCheck() {
  const [organizationId, setOrganizationId] = useState('')
  const [sourceSystem, setSourceSystem] = useState('SYNTHETIC_PAYER_SYSTEM')
  const [externalValue, setExternalValue] = useState('PAYER-001')
  const [targetType, setTargetType] = useState<TargetType>('PAYER')
  const [targetId, setTargetId] = useState('')
  const [identifiers, setIdentifiers] = useState<ExternalIdentifier[] | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await createExternalIdentifier(organizationId, sourceSystem, externalValue, targetType, targetId)
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
      setIdentifiers(await loadExternalIdentifiers(organizationId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">External Identifier Check</h2>
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
          value={sourceSystem}
          onChange={(event) => setSourceSystem(event.target.value)}
          aria-label="Source system"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={externalValue}
          onChange={(event) => setExternalValue(event.target.value)}
          aria-label="External value"
        />
        <select
          className="rounded-md border border-slate-300 px-3 py-2"
          value={targetType}
          onChange={(event) => setTargetType(event.target.value as TargetType)}
          aria-label="Target type"
        >
          {targetTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={targetId}
          onChange={(event) => setTargetId(event.target.value)}
          placeholder="Target SBN UUID"
          aria-label="Target SBN UUID"
        />
        <div className="flex gap-2">
          <button
            className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
            disabled={saving}
            type="submit"
          >
            {saving ? 'Saving...' : 'Create Identifier'}
          </button>
          <button
            className="rounded-md bg-slate-700 px-4 py-2 text-white disabled:opacity-50"
            disabled={loading}
            type="button"
            onClick={handleLoad}
          >
            {loading ? 'Loading...' : 'Load Identifiers'}
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {identifiers && identifiers.length === 0 && (
        <p className="mt-3 text-sm text-slate-600">No external identifiers yet.</p>
      )}

      {identifiers && identifiers.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium text-slate-700">Loaded external identifiers:</p>
          {identifiers.map((item) => (
            <div key={item.id} className="rounded-md bg-slate-100 p-3 text-sm">
              <p>
                <strong>{item.sourceSystem}</strong> — {item.externalValue} — target: {item.target.type} (
                {item.target.id}) — {item.id}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

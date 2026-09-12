import { useState, type FormEvent } from 'react'
import { createRuleSourceVersion, loadRuleSourceVersions, type RuleSourceVersion } from './rule-source-version.api.ts'

export default function RuleSourceVersionCheck() {
  const [sourceId, setSourceId] = useState('')
  const [version, setVersion] = useState('2026.1')
  const [rawEvidenceRef, setRawEvidenceRef] = useState('synthetic-evidence://rule-source/demo/2026.1')
  const [versions, setVersions] = useState<RuleSourceVersion[] | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await createRuleSourceVersion(sourceId, version, rawEvidenceRef)
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
      setVersions(await loadRuleSourceVersions(sourceId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Rule Source Version Check</h2>
      <p className="mt-1 text-sm text-slate-600">Synthetic development data only. Versions are immutable once created — no edit form.</p>

      <form className="mt-4 grid gap-2" onSubmit={handleCreate}>
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
          placeholder="Rule Source UUID"
          aria-label="Rule Source UUID"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={version}
          onChange={(event) => setVersion(event.target.value)}
          aria-label="Version"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={rawEvidenceRef}
          onChange={(event) => setRawEvidenceRef(event.target.value)}
          aria-label="Raw evidence reference"
        />
        <div className="flex gap-2">
          <button
            className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
            disabled={saving}
            type="submit"
          >
            {saving ? 'Saving...' : 'Create Version'}
          </button>
          <button
            className="rounded-md bg-slate-700 px-4 py-2 text-white disabled:opacity-50"
            disabled={loading}
            type="button"
            onClick={handleLoad}
          >
            {loading ? 'Loading...' : 'Load Versions'}
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {versions && versions.length === 0 && (
        <p className="mt-3 text-sm text-slate-600">No versions yet.</p>
      )}

      {versions && versions.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium text-slate-700">Loaded versions:</p>
          {versions.map((item) => (
            <div key={item.id} className="rounded-md bg-slate-100 p-3 text-sm">
              <p>
                <strong>{item.version}</strong> — {item.rawEvidenceRef} — {item.id}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

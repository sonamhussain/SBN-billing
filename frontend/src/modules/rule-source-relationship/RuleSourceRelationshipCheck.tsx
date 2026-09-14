import { useState, type FormEvent } from 'react'
import {
  createRelationship,
  loadRelationships,
  relationshipTypes,
  type RelationshipType,
  type RuleSourceRelationship,
} from './rule-source-relationship.api.ts'

export default function RuleSourceRelationshipCheck() {
  const [fromVersionId, setFromVersionId] = useState('')
  const [toSourceVersionId, setToSourceVersionId] = useState('')
  const [relationshipType, setRelationshipType] = useState<RelationshipType>('REFERENCES')
  const [relationships, setRelationships] = useState<RuleSourceRelationship[] | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await createRelationship(fromVersionId, toSourceVersionId, relationshipType)
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
      setRelationships(await loadRelationships(fromVersionId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Rule Source Relationship Check</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. Append-only — no edit/delete form. FROM must be your own organization's version.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleCreate}>
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={fromVersionId}
          onChange={(event) => setFromVersionId(event.target.value)}
          placeholder="FROM Rule Source Version UUID"
          aria-label="FROM Rule Source Version UUID"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={toSourceVersionId}
          onChange={(event) => setToSourceVersionId(event.target.value)}
          placeholder="TO Rule Source Version UUID"
          aria-label="TO Rule Source Version UUID"
        />
        <select
          className="rounded-md border border-slate-300 px-3 py-2"
          value={relationshipType}
          onChange={(event) => setRelationshipType(event.target.value as RelationshipType)}
          aria-label="Relationship type"
        >
          {relationshipTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <div className="flex gap-2">
          <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={saving} type="submit">
            {saving ? 'Saving...' : 'Create Relationship'}
          </button>
          <button
            className="rounded-md bg-slate-700 px-4 py-2 text-white disabled:opacity-50"
            disabled={loading}
            type="button"
            onClick={handleLoad}
          >
            {loading ? 'Loading...' : 'Load Relationships (FROM as version)'}
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {relationships && relationships.length === 0 && <p className="mt-3 text-sm text-slate-600">No relationships yet.</p>}

      {relationships && relationships.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium text-slate-700">Loaded relationships:</p>
          {relationships.map((item) => (
            <div key={item.id} className="rounded-md bg-slate-100 p-3 text-sm">
              <p>
                <strong>{item.direction}</strong> — {item.relationshipType} — {item.fromSourceVersionId} → {item.toSourceVersionId} —{' '}
                {item.id}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

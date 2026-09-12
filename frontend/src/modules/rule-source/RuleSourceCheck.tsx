import { useState, type FormEvent } from 'react'
import { createRuleSource, loadRuleSources, sourceCategories, type RuleSource, type SourceCategory } from './rule-source.api.ts'

export default function RuleSourceCheck() {
  const [organizationId, setOrganizationId] = useState('')
  const [jurisdictionCode, setJurisdictionCode] = useState('AE-DU')
  const [issuingAuthority, setIssuingAuthority] = useState('Synthetic Authority')
  const [sourceCategory, setSourceCategory] = useState<SourceCategory>('CLAIMS_STANDARD')
  const [referenceNumber, setReferenceNumber] = useState('SYN-CS-001')
  const [title, setTitle] = useState('Synthetic Claims Standard')
  const [ruleSources, setRuleSources] = useState<RuleSource[] | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await createRuleSource(organizationId, jurisdictionCode, issuingAuthority, sourceCategory, referenceNumber, title)
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
      setRuleSources(await loadRuleSources(organizationId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Rule Source Check</h2>
      <p className="mt-1 text-sm text-slate-600">Synthetic development data only. Organization-owned sources only.</p>

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
          value={jurisdictionCode}
          onChange={(event) => setJurisdictionCode(event.target.value)}
          aria-label="Jurisdiction code"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={issuingAuthority}
          onChange={(event) => setIssuingAuthority(event.target.value)}
          aria-label="Issuing authority"
        />
        <select
          className="rounded-md border border-slate-300 px-3 py-2"
          value={sourceCategory}
          onChange={(event) => setSourceCategory(event.target.value as SourceCategory)}
          aria-label="Source category"
        >
          {sourceCategories.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={referenceNumber}
          onChange={(event) => setReferenceNumber(event.target.value)}
          aria-label="Reference number"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-label="Title"
        />
        <div className="flex gap-2">
          <button
            className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
            disabled={saving}
            type="submit"
          >
            {saving ? 'Saving...' : 'Create Rule Source'}
          </button>
          <button
            className="rounded-md bg-slate-700 px-4 py-2 text-white disabled:opacity-50"
            disabled={loading}
            type="button"
            onClick={handleLoad}
          >
            {loading ? 'Loading...' : 'Load Rule Sources'}
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {ruleSources && ruleSources.length === 0 && (
        <p className="mt-3 text-sm text-slate-600">No rule sources yet.</p>
      )}

      {ruleSources && ruleSources.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium text-slate-700">Loaded rule sources:</p>
          {ruleSources.map((item) => (
            <div key={item.id} className="rounded-md bg-slate-100 p-3 text-sm">
              <p>
                <strong>{item.title}</strong> — {item.jurisdictionCode} — {item.sourceCategory} — {item.referenceNumber} — {item.id}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

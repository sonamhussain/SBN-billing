import { useState, type FormEvent } from 'react'
import { createRuleDefinition, loadRuleDefinitions, type RuleDefinition } from './rule-definition.api.ts'

export default function RuleDefinitionCheck() {
  const [organizationId, setOrganizationId] = useState('')
  const [ruleKey, setRuleKey] = useState('CLAIM_FORMAT_BASE')
  const [displayName, setDisplayName] = useState('Synthetic Claim Format Rule')
  const [jurisdictionCode, setJurisdictionCode] = useState('AE-DU')
  const [ruleDefinitions, setRuleDefinitions] = useState<RuleDefinition[] | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await createRuleDefinition(organizationId, ruleKey, displayName, jurisdictionCode)
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
      setRuleDefinitions(await loadRuleDefinitions(organizationId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Rule Definition Check</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. Organization-owned rule definitions only. No source binding, no execution.
      </p>

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
          value={ruleKey}
          onChange={(event) => setRuleKey(event.target.value)}
          aria-label="Rule key"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          aria-label="Display name"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={jurisdictionCode}
          onChange={(event) => setJurisdictionCode(event.target.value)}
          aria-label="Jurisdiction code"
        />
        <div className="flex gap-2">
          <button
            className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
            disabled={saving}
            type="submit"
          >
            {saving ? 'Saving...' : 'Create Rule Definition'}
          </button>
          <button
            className="rounded-md bg-slate-700 px-4 py-2 text-white disabled:opacity-50"
            disabled={loading}
            type="button"
            onClick={handleLoad}
          >
            {loading ? 'Loading...' : 'Load Rule Definitions'}
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {ruleDefinitions && ruleDefinitions.length === 0 && (
        <p className="mt-3 text-sm text-slate-600">No rule definitions yet.</p>
      )}

      {ruleDefinitions && ruleDefinitions.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium text-slate-700">Loaded rule definitions:</p>
          {ruleDefinitions.map((item) => (
            <div key={item.id} className="rounded-md bg-slate-100 p-3 text-sm">
              <p>
                <strong>{item.displayName}</strong> — {item.ruleKey} — {item.jurisdictionCode} — {item.ownershipScope} — {item.id}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

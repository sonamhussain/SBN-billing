import { useState, type FormEvent } from 'react'
import { createRuleSourceScope, loadRuleSourceScopes, type RuleSourceScope, type ScopeDimensions } from './rule-source-scope.api.ts'

const emptyDimensions: ScopeDimensions = {
  facilityId: '',
  payerId: '',
  tpaId: '',
  networkId: '',
  insuranceProductId: '',
  providerContractId: '',
  tariffScheduleId: '',
  tariffScheduleVersionId: '',
}

export default function RuleSourceScopeCheck() {
  const [sourceId, setSourceId] = useState('')
  const [dimensions, setDimensions] = useState<ScopeDimensions>(emptyDimensions)
  const [scopes, setScopes] = useState<RuleSourceScope[] | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)

  function updateDimension(key: keyof ScopeDimensions, value: string) {
    setDimensions((prev) => ({ ...prev, [key]: value }))
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await createRuleSourceScope(sourceId, dimensions)
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
      setScopes(await loadRuleSourceScopes(sourceId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  const dimensionFields: { key: keyof ScopeDimensions; label: string }[] = [
    { key: 'facilityId', label: 'Facility UUID (blank = wildcard)' },
    { key: 'payerId', label: 'Payer UUID (blank = wildcard)' },
    { key: 'tpaId', label: 'TPA UUID (blank = wildcard)' },
    { key: 'networkId', label: 'Network UUID (blank = wildcard)' },
    { key: 'insuranceProductId', label: 'Insurance Product UUID (blank = wildcard)' },
    { key: 'providerContractId', label: 'Provider Contract UUID (blank = wildcard)' },
    { key: 'tariffScheduleId', label: 'Tariff Schedule UUID (blank = wildcard)' },
    { key: 'tariffScheduleVersionId', label: 'Tariff Schedule Version UUID (blank = wildcard)' },
  ]

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Rule Source Scope Check (REF-01 / R4)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. Typed commercial context proof for a tenant-owned RuleSource. No PATCH/DELETE.
      </p>

      <input
        className="mt-4 w-full rounded-md border border-slate-300 px-3 py-2"
        value={sourceId}
        onChange={(event) => setSourceId(event.target.value)}
        placeholder="Rule Source UUID"
        aria-label="Rule Source UUID"
      />

      <form className="mt-3 grid gap-2" onSubmit={handleCreate}>
        {dimensionFields.map((field) => (
          <input
            key={field.key}
            className="rounded-md border border-slate-300 px-3 py-2"
            value={dimensions[field.key]}
            onChange={(event) => updateDimension(field.key, event.target.value)}
            placeholder={field.label}
            aria-label={field.label}
          />
        ))}
        <div className="flex gap-2">
          <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={saving} type="submit">
            {saving ? 'Saving...' : 'Create Scope Row'}
          </button>
          <button className="rounded-md bg-slate-700 px-4 py-2 text-white disabled:opacity-50" disabled={loading} type="button" onClick={handleLoad}>
            {loading ? 'Loading...' : 'Load Scopes'}
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {scopes && scopes.length === 0 && <p className="mt-3 text-sm text-slate-600">No scope rows yet.</p>}

      {scopes && scopes.length > 0 && (
        <div className="mt-4 space-y-2">
          {scopes.map((item) => (
            <div key={item.id} className="rounded-md bg-slate-100 p-3 text-sm">
              <p>
                facility={item.facilityId ?? 'null'} payer={item.payerId ?? 'null'} tpa={item.tpaId ?? 'null'} network=
                {item.networkId ?? 'null'} product={item.insuranceProductId ?? 'null'} contract={item.providerContractId ?? 'null'}{' '}
                tariffSchedule={item.tariffScheduleId ?? 'null'} tariffVersion={item.tariffScheduleVersionId ?? 'null'} — {item.id}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

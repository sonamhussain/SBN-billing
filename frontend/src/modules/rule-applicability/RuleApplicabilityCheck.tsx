import { useState, type FormEvent } from 'react'
import {
  createRuleApplicability,
  evaluateRuleApplicability,
  loadRuleApplicabilities,
  type ApplicabilityDimensions,
  type RuleApplicability,
} from './rule-applicability.api.ts'

const emptyDimensions: ApplicabilityDimensions = {
  facilityId: '',
  facilityRegulatoryProfileId: '',
  payerId: '',
  tpaId: '',
  networkId: '',
  insuranceProductId: '',
  providerContractId: '',
  tariffScheduleId: '',
  tariffScheduleVersionId: '',
  serviceId: '',
  procedureCodeId: '',
  diagnosisCodeId: '',
}

export default function RuleApplicabilityCheck() {
  const [ruleVersionId, setRuleVersionId] = useState('')
  const [dimensions, setDimensions] = useState<ApplicabilityDimensions>(emptyDimensions)
  const [applicabilities, setApplicabilities] = useState<RuleApplicability[] | null>(null)
  const [evaluateResult, setEvaluateResult] = useState<{ matches: boolean; matchedApplicabilityIds: string[] } | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [evaluating, setEvaluating] = useState(false)

  function updateDimension(key: keyof ApplicabilityDimensions, value: string) {
    setDimensions((prev) => ({ ...prev, [key]: value }))
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await createRuleApplicability(ruleVersionId, dimensions)
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
      setApplicabilities(await loadRuleApplicabilities(ruleVersionId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleEvaluate(event: FormEvent) {
    event.preventDefault()
    setEvaluating(true)
    setError('')
    try {
      setEvaluateResult(await evaluateRuleApplicability(ruleVersionId, dimensions))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setEvaluating(false)
    }
  }

  const dimensionFields: { key: keyof ApplicabilityDimensions; label: string }[] = [
    { key: 'facilityId', label: 'Facility UUID (blank = wildcard)' },
    { key: 'facilityRegulatoryProfileId', label: 'Facility Regulatory Profile UUID (blank = wildcard)' },
    { key: 'payerId', label: 'Payer UUID (blank = wildcard)' },
    { key: 'tpaId', label: 'TPA UUID (blank = wildcard)' },
    { key: 'networkId', label: 'Network UUID (blank = wildcard)' },
    { key: 'insuranceProductId', label: 'Insurance Product UUID (blank = wildcard)' },
    { key: 'providerContractId', label: 'Provider Contract UUID (blank = wildcard)' },
    { key: 'tariffScheduleId', label: 'Tariff Schedule UUID (blank = wildcard)' },
    { key: 'tariffScheduleVersionId', label: 'Tariff Schedule Version UUID (blank = wildcard)' },
    { key: 'serviceId', label: 'Service UUID (blank = wildcard)' },
    { key: 'procedureCodeId', label: 'Procedure Code UUID (blank = wildcard)' },
    { key: 'diagnosisCodeId', label: 'Diagnosis Code UUID (blank = wildcard)' },
  ]

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Rule Applicability Check</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. Applicability != executability != precedence. No PATCH/DELETE.
      </p>

      <input
        className="mt-4 w-full rounded-md border border-slate-300 px-3 py-2"
        value={ruleVersionId}
        onChange={(event) => setRuleVersionId(event.target.value)}
        placeholder="Rule Version UUID"
        aria-label="Rule Version UUID"
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
            {saving ? 'Saving...' : 'Create Applicability Row'}
          </button>
          <button
            className="rounded-md bg-slate-700 px-4 py-2 text-white disabled:opacity-50"
            disabled={loading}
            type="button"
            onClick={handleLoad}
          >
            {loading ? 'Loading...' : 'Load Applicabilities'}
          </button>
          <button
            className="rounded-md bg-slate-600 px-4 py-2 text-white disabled:opacity-50"
            disabled={evaluating}
            type="button"
            onClick={handleEvaluate}
          >
            {evaluating ? 'Evaluating...' : 'Evaluate (non-mutating)'}
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {evaluateResult && (
        <p className="mt-3 text-sm text-slate-700">
          matches: <strong>{String(evaluateResult.matches)}</strong> — matched IDs: {evaluateResult.matchedApplicabilityIds.join(', ') || 'none'}
        </p>
      )}

      {applicabilities && applicabilities.length === 0 && <p className="mt-3 text-sm text-slate-600">No applicability rows yet.</p>}

      {applicabilities && applicabilities.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium text-slate-700">Loaded applicability rows:</p>
          {applicabilities.map((item) => (
            <div key={item.id} className="rounded-md bg-slate-100 p-3 text-sm">
              <p>
                facility={item.facilityId ?? 'null'} regProfile={item.facilityRegulatoryProfileId ?? 'null'} payer=
                {item.payerId ?? 'null'} tpa={item.tpaId ?? 'null'} network={item.networkId ?? 'null'} product=
                {item.insuranceProductId ?? 'null'} contract={item.providerContractId ?? 'null'} tariffSchedule=
                {item.tariffScheduleId ?? 'null'} tariffVersion={item.tariffScheduleVersionId ?? 'null'} service=
                {item.serviceId ?? 'null'} procedure={item.procedureCodeId ?? 'null'} diagnosis={item.diagnosisCodeId ?? 'null'} — {item.id}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

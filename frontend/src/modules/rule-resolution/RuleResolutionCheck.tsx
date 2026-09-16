import { useState, type FormEvent } from 'react'
import {
  evaluateRuleResolution,
  type ResolutionContextInputs,
  type RuleResolution,
} from './rule-resolution.api.ts'

const emptyContext: ResolutionContextInputs = {
  facilityId: '',
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

const contextFields: { key: keyof ResolutionContextInputs; label: string }[] = [
  { key: 'facilityId', label: 'facilityId (optional; resolves facilityRegulatoryProfileId server-side)' },
  { key: 'payerId', label: 'payerId (optional)' },
  { key: 'tpaId', label: 'tpaId (optional)' },
  { key: 'networkId', label: 'networkId (optional)' },
  { key: 'insuranceProductId', label: 'insuranceProductId (optional)' },
  { key: 'providerContractId', label: 'providerContractId (optional)' },
  { key: 'tariffScheduleId', label: 'tariffScheduleId (optional)' },
  { key: 'tariffScheduleVersionId', label: 'tariffScheduleVersionId (optional)' },
  { key: 'serviceId', label: 'serviceId (optional)' },
  { key: 'procedureCodeId', label: 'procedureCodeId (optional)' },
  { key: 'diagnosisCodeId', label: 'diagnosisCodeId (optional)' },
]

export default function RuleResolutionCheck() {
  const [ruleDefinitionId, setRuleDefinitionId] = useState('')
  const [businessDate, setBusinessDate] = useState('2026-10-15')
  const [context, setContext] = useState<ResolutionContextInputs>(emptyContext)
  const [resolution, setResolution] = useState<RuleResolution | null>(null)
  const [error, setError] = useState('')
  const [evaluating, setEvaluating] = useState(false)

  function updateContext(key: keyof ResolutionContextInputs, value: string) {
    setContext((prev) => ({ ...prev, [key]: value }))
  }

  async function handleEvaluate(event: FormEvent) {
    event.preventDefault()
    setEvaluating(true)
    setError('')
    try {
      setResolution(await evaluateRuleResolution(ruleDefinitionId, businessDate, context))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setEvaluating(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Deterministic Resolution Check (A3.8)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. Read-only resolver: it writes no row and no AuditEvent. RESOLVED is not a billing
        decision, and historicalOnly is provenance only — never permission to execute.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleEvaluate}>
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={ruleDefinitionId}
          onChange={(event) => setRuleDefinitionId(event.target.value)}
          placeholder="Rule Definition UUID"
          aria-label="Rule Definition UUID"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={businessDate}
          onChange={(event) => setBusinessDate(event.target.value)}
          placeholder="businessDate (YYYY-MM-DD)"
          aria-label="Business date"
        />
        {contextFields.map((field) => (
          <input
            key={field.key}
            className="rounded-md border border-slate-300 px-3 py-2"
            value={context[field.key]}
            onChange={(event) => updateContext(field.key, event.target.value)}
            placeholder={field.label}
            aria-label={field.label}
          />
        ))}
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={evaluating} type="submit">
          {evaluating ? 'Resolving...' : 'Evaluate Resolution'}
        </button>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {resolution && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm">
          <p>
            resolutionStatus: <strong>{resolution.resolutionStatus}</strong> — policy: {resolution.precedencePolicyVersion} —
            historicalOnly: <strong>{String(resolution.historicalOnly)}</strong>
          </p>
          <p>
            ruleVersionId: {resolution.ruleVersionId ?? 'null'} — version: {resolution.ruleVersion ?? 'null'} — specificityScore:{' '}
            {resolution.specificityScore ?? 'null'}
          </p>
          <p>jurisdictionCode: {resolution.jurisdictionCode} — businessDate: {resolution.businessDate}</p>
          <p>governingBindingId: {resolution.governingBindingId ?? 'null'}</p>
          <p>governingSourceInterpretationId: {resolution.governingSourceInterpretationId ?? 'null'}</p>
          <p>governingSourceVersionId: {resolution.governingSourceVersionId ?? 'null'}</p>
          <p>governingSourceId: {resolution.governingSourceId ?? 'null'}</p>
          <p>supportingBindingIds: {resolution.supportingBindingIds.join(', ') || 'none'}</p>
          <p>matchedApplicabilityIds: {resolution.matchedApplicabilityIds.join(', ') || 'none'}</p>
          <p>blockers: {resolution.blockers.join(', ') || 'none'}</p>
        </div>
      )}
    </section>
  )
}

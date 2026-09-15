import { useState, type FormEvent } from 'react'
import {
  createRuleSourceBinding,
  evaluateExecutability,
  loadRuleSourceBindings,
  sourceRoles,
  type ExecutabilityEvaluation,
  type RuleSourceBinding,
  type SourceRole,
} from './rule-source-binding.api.ts'

export default function RuleSourceBindingCheck() {
  const [ruleVersionId, setRuleVersionId] = useState('')
  const [sourceInterpretationId, setSourceInterpretationId] = useState('')
  const [sourceRole, setSourceRole] = useState<SourceRole>('GOVERNING')
  const [bindings, setBindings] = useState<RuleSourceBinding[] | null>(null)
  const [businessDate, setBusinessDate] = useState('2026-10-15')
  const [payerId, setPayerId] = useState('')
  const [tpaId, setTpaId] = useState('')
  const [networkId, setNetworkId] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [procedureCodeId, setProcedureCodeId] = useState('')
  const [diagnosisCodeId, setDiagnosisCodeId] = useState('')
  const [evaluation, setEvaluation] = useState<ExecutabilityEvaluation | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [evaluating, setEvaluating] = useState(false)

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await createRuleSourceBinding(ruleVersionId, sourceInterpretationId, sourceRole)
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
      setBindings(await loadRuleSourceBindings(ruleVersionId))
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
      setEvaluation(
        await evaluateExecutability(ruleVersionId, businessDate, {
          payerId,
          tpaId,
          networkId,
          serviceId,
          procedureCodeId,
          diagnosisCodeId,
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setEvaluating(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Rule Source Binding &amp; Executability Check</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. POTENTIALLY_ALLOWED != executed != precedence winner. No PATCH/DELETE.
      </p>

      <input
        className="mt-4 w-full rounded-md border border-slate-300 px-3 py-2"
        value={ruleVersionId}
        onChange={(event) => setRuleVersionId(event.target.value)}
        placeholder="Rule Version UUID"
        aria-label="Rule Version UUID"
      />

      <form className="mt-3 grid gap-2" onSubmit={handleCreate}>
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={sourceInterpretationId}
          onChange={(event) => setSourceInterpretationId(event.target.value)}
          placeholder="Source Interpretation UUID"
          aria-label="Source Interpretation UUID"
        />
        <select
          className="rounded-md border border-slate-300 px-3 py-2"
          value={sourceRole}
          onChange={(event) => setSourceRole(event.target.value as SourceRole)}
          aria-label="Source role"
        >
          {sourceRoles.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
        <div className="flex gap-2">
          <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={saving} type="submit">
            {saving ? 'Saving...' : 'Create Binding'}
          </button>
          <button
            className="rounded-md bg-slate-700 px-4 py-2 text-white disabled:opacity-50"
            disabled={loading}
            type="button"
            onClick={handleLoad}
          >
            {loading ? 'Loading...' : 'Load Bindings'}
          </button>
        </div>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleEvaluate}>
        <p className="text-sm font-medium text-slate-700">Executability evaluate (non-mutating)</p>
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={businessDate}
          onChange={(event) => setBusinessDate(event.target.value)}
          placeholder="businessDate (YYYY-MM-DD)"
          aria-label="Business date"
        />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={payerId} onChange={(e) => setPayerId(e.target.value)} placeholder="payerId (optional)" aria-label="Payer id" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={tpaId} onChange={(e) => setTpaId(e.target.value)} placeholder="tpaId (optional)" aria-label="Tpa id" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={networkId} onChange={(e) => setNetworkId(e.target.value)} placeholder="networkId (optional)" aria-label="Network id" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={serviceId} onChange={(e) => setServiceId(e.target.value)} placeholder="serviceId (optional)" aria-label="Service id" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={procedureCodeId} onChange={(e) => setProcedureCodeId(e.target.value)} placeholder="procedureCodeId (optional)" aria-label="Procedure code id" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={diagnosisCodeId} onChange={(e) => setDiagnosisCodeId(e.target.value)} placeholder="diagnosisCodeId (optional)" aria-label="Diagnosis code id" />
        <button className="rounded-md bg-slate-600 px-4 py-2 text-white disabled:opacity-50" disabled={evaluating} type="submit">
          {evaluating ? 'Evaluating...' : 'Evaluate Executability'}
        </button>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {evaluation && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm">
          <p>
            gateStatus: <strong>{evaluation.gateStatus}</strong> — policy: {evaluation.compatibilityPolicyVersion}
          </p>
          <p>blockers: {evaluation.blockers.join(', ') || 'none'}</p>
          <p>governingBindingIds: {evaluation.governingBindingIds.join(', ') || 'none'}</p>
          <p>supportingBindingIds: {evaluation.supportingBindingIds.join(', ') || 'none'}</p>
          <p>candidateSourceInterpretationIds: {evaluation.candidateSourceInterpretationIds.join(', ') || 'none'}</p>
        </div>
      )}

      {bindings && bindings.length === 0 && <p className="mt-3 text-sm text-slate-600">No bindings yet.</p>}

      {bindings && bindings.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium text-slate-700">Loaded bindings:</p>
          {bindings.map((item) => (
            <div key={item.id} className="rounded-md bg-slate-100 p-3 text-sm">
              <p>
                {item.sourceRole} — interpretation={item.sourceInterpretationId} — {item.id}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

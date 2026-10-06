import { useState, type FormEvent } from 'react'
import { executeValidation, type PreClaimValidationExecution } from './pre-claim-validation.api.ts'

// A5.8 — minimal engineering check: execute one deterministic pre-claim validation for an Encounter.
// The result is a new immutable run; its findings are read through the A5.7 check. Only the run id,
// time, validator version and finding count are shown. Nothing is logged or kept in browser storage.
// A recorded run is not readiness, payer acceptance or submission authority.

export default function PreClaimValidationCheck() {
  const [encounterId, setEncounterId] = useState('')
  const [execution, setExecution] = useState<PreClaimValidationExecution | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleExecute(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    try {
      setExecution(await executeValidation(encounterId.trim()))
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Pre-Claim Validation Check (A5.8)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. Each execution records a new immutable validation run under validator contract A5-VAL-1. FAIL and RESTRICT
        findings are recorded results, not errors; a run is not claim readiness or payer acceptance.
      </p>
      <form className="mt-4 grid gap-2" onSubmit={handleExecute}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={encounterId} onChange={(event) => setEncounterId(event.target.value)} placeholder="Encounter UUID" aria-label="Encounter UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Execute validation
        </button>
      </form>
      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}
      {execution && (
        <p className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          Run {execution.validationRunId} recorded at {execution.evaluatedAt} under {execution.validatorVersion} with {execution.findingCount} finding(s).
        </p>
      )}
    </section>
  )
}

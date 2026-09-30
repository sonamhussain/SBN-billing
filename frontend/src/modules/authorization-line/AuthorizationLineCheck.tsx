import { useState, type FormEvent } from 'react'
import { captureLines, evaluateScope, listLines, type AuthorizationLine, type LineStatus, type ScopeEvaluation } from './authorization-line.api.ts'

// A5.4 — minimal engineering check: capture one synthetic line for an exact A5.3 version, list the
// captured lines, and run the read-only scope evaluation.
//
// It shows sequence numbers, reported statuses, quantities and scope outcomes, and nothing else. No
// member, policy, authorization reference or evidence value is displayed, nothing is logged, and
// nothing is kept in browser storage. This is not the authorization workflow UI, and a MATCHED row
// here is a scope fact — not claim readiness and not payer acceptance.

const STATUSES: LineStatus[] = ['REQUESTED', 'PENDING', 'APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'UNKNOWN']

const orNull = (value: string) => (value.trim() === '' ? null : value.trim())

export default function AuthorizationLineCheck() {
  const [versionId, setVersionId] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [procedureCodeId, setProcedureCodeId] = useState('')
  const [requestedQty, setRequestedQty] = useState('1')
  const [approvedQty, setApprovedQty] = useState('')
  const [unitCode, setUnitCode] = useState('')
  const [status, setStatus] = useState<LineStatus>('APPROVED')
  const [lines, setLines] = useState<AuthorizationLine[] | null>(null)
  const [evaluation, setEvaluation] = useState<ScopeEvaluation | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  function handleCapture(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      setLines(
        await captureLines(versionId.trim(), [
          {
            serviceId: orNull(serviceId),
            procedureCodeId: orNull(procedureCodeId),
            diagnosisCodeId: null,
            // Sent exactly as typed; the server owns the strict decimal grammar.
            requestedQty: requestedQty.trim(),
            approvedQty: orNull(approvedQty),
            unitCode: orNull(unitCode),
            approvedFrom: null,
            approvedThrough: null,
            status,
          },
        ]),
      )
    })
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Authorization Line Check (A5.4)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. Lines are captured once per exact A5.3 version and never edited — a correction is a new A5.3 version. Scope
        evaluation is read-only: two candidate lines are <strong>AMBIGUOUS</strong>, never a guessed winner, and <strong>MATCHED</strong> is not claim
        readiness.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleCapture}>
        <input className={inputClass} value={versionId} onChange={(event) => setVersionId(event.target.value)} placeholder="Prior authorization version UUID (A5.3)" aria-label="Prior authorization version UUID" />
        <input className={inputClass} value={serviceId} onChange={(event) => setServiceId(event.target.value)} placeholder="Service UUID (optional)" aria-label="Service UUID" />
        <input className={inputClass} value={procedureCodeId} onChange={(event) => setProcedureCodeId(event.target.value)} placeholder="Procedure code UUID (optional)" aria-label="Procedure code UUID" />
        <input className={inputClass} value={requestedQty} onChange={(event) => setRequestedQty(event.target.value)} placeholder="Requested quantity, e.g. 2.5" aria-label="Requested quantity" />
        <input className={inputClass} value={approvedQty} onChange={(event) => setApprovedQty(event.target.value)} placeholder="Approved quantity (blank = not supplied)" aria-label="Approved quantity" />
        <input className={inputClass} value={unitCode} onChange={(event) => setUnitCode(event.target.value)} placeholder="Unit code (blank = no unit restriction)" aria-label="Unit code" />
        <select className={inputClass} value={status} onChange={(event) => setStatus(event.target.value as LineStatus)} aria-label="Reported line status">
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <div className="flex flex-wrap gap-2">
          <button className={buttonClass} disabled={busy} type="submit">
            Capture synthetic line batch
          </button>
          <button className={buttonClass} disabled={busy} type="button" onClick={() => void run(async () => setLines(await listLines(versionId.trim())))}>
            Load lines
          </button>
          <button className={buttonClass} disabled={busy} type="button" onClick={() => void run(async () => setEvaluation(await evaluateScope(versionId.trim())))}>
            Evaluate scope
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {lines && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>{lines.length} immutable line(s), in reported order:</p>
          <ul className="mt-1 grid gap-1">
            {lines.map((line) => (
              <li key={line.id}>
                #{line.sequence} — reported <strong>{line.status}</strong> — requested {line.requestedQty}, approved {line.approvedQty ?? 'not supplied'}
                {line.unitCode ? ` ${line.unitCode}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {evaluation && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            Context {evaluation.contextMatch ? 'matches' : <strong>no longer matches</strong>} the frozen authorization — {evaluation.activities.length} active
            activit{evaluation.activities.length === 1 ? 'y' : 'ies'} evaluated.
          </p>
          <ul className="mt-1 grid gap-1">
            {evaluation.activities.map((activity, index) => (
              <li key={activity.encounterActivityId}>
                activity {index + 1}: <strong>{activity.outcome}</strong>
                {activity.candidateAuthorizationLineIds.length > 1 ? ` (${activity.candidateAuthorizationLineIds.length} candidate lines)` : ''}
              </li>
            ))}
          </ul>
          {evaluation.lineUtilization.length > 0 && (
            <ul className="mt-2 grid gap-1">
              {evaluation.lineUtilization.map((row, index) => (
                <li key={row.authorizationLineId}>
                  line {index + 1}: matched {row.matchedQty} of {row.approvedQty ?? 'unknown'} — {row.quantityOutcome}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-slate-600">Computed now and stored nowhere. Satisfaction, readiness and claims belong to A5.8, A5.9 and A6.</p>
        </div>
      )}
    </section>
  )
}

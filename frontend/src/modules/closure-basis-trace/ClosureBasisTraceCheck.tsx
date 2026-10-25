import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A7.6 — minimal read-only engineering check for the basis trace of one recorded closure-prerequisite assessment.
// Synthetic development data only. The page never assesses, adjudicates, pays, posts or closes anything, and keeps
// nothing in browser storage. A trace only explains why a closure prerequisite is ABSENT: never a payment, a balance,
// a payer decision or a closed account.

type TraceItem = {
  ordinal: number
  sourceEvidenceId: string
  classificationId: string | null
  readinessId: string | null
  sourceReasonCode: string
  readinessCode: string | null
  readinessReasonCode: string | null
  explanationCode: string
}

type BasisTrace = {
  contractVersion: string
  assessmentId: string
  caseId: string
  caseManifestSha256: string
  assessmentCode: string
  basisCode: string
  sourceCount: number
  itemCount: number
  traceCode: string
  traceItems: TraceItem[]
  evaluatedAt: string
}

export default function ClosureBasisTraceCheck() {
  const [assessmentId, setAssessmentId] = useState('')
  const [trace, setTrace] = useState<BasisTrace | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleRead(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    setTrace(null)
    try {
      const response = await fetch(`/api/closure-prerequisite-assessments/${assessmentId.trim()}/basis-trace`)
      if (!response.ok) {
        const apiError = await readApiError(response)
        throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
      }
      setTrace((await response.json()) as BasisTrace)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Closure Basis Trace Check (A7.6)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. A trace explains which recorded case items stand behind one closure-prerequisite assessment; it is not a
        payment, a balance, a payer decision or a closed account.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={assessmentId} onChange={(event) => setAssessmentId(event.target.value)} placeholder="Closure-prerequisite assessment UUID" aria-label="Closure-prerequisite assessment UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read basis trace (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {trace && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p className="break-all">
            {trace.traceCode} / {trace.basisCode} — {trace.itemCount} item(s) — case {trace.caseManifestSha256.slice(0, 12)}… — evaluated {trace.evaluatedAt}
          </p>
          <ol className="mt-2 grid gap-1">
            {trace.traceItems.length === 0 && <li>No source item in this case.</li>}
            {trace.traceItems.map((item) => (
              <li key={item.ordinal} className="break-all">
                {item.ordinal}. {item.sourceReasonCode} → {item.explanationCode}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}

import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A7.3 — minimal read-only engineering check for the internal readiness results recorded for one evidence
// classification. Synthetic development data only. The page never records a result, adjudicates, verifies, asserts
// a payment or sends anything, and keeps nothing in browser storage. A readiness result only says whether trusted
// payer evidence exists: it is never an insurer decision, a payment, an amount or a claim status.

type ReadinessResult = {
  readinessId: string
  classificationId: string
  sourceEvidenceId: string
  contractVersion: string
  readinessCode: string
  reasonCode: string
  recordedByUserId: string
  recordedAt: string
}

export default function EvidenceGateCheck() {
  const [classificationId, setClassificationId] = useState('')
  const [items, setItems] = useState<ReadinessResult[] | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleRead(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    setItems(null)
    try {
      const response = await fetch(`/api/revenue-evidence-classifications/${classificationId.trim()}/adjudication-readiness`)
      if (!response.ok) {
        const apiError = await readApiError(response)
        throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
      }
      setItems(((await response.json()) as { items: ReadinessResult[] }).items)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Evidence Gate Check (A7.3)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. A readiness result says whether trusted payer evidence exists for a classified source; it is not an insurer
        decision, a payment or a claim status.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={classificationId} onChange={(event) => setClassificationId(event.target.value)} placeholder="Classification UUID" aria-label="Classification UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read readiness results (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {items && (
        <ol className="mt-3 grid gap-1 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          {items.length === 0 && <li>No readiness result recorded for this classification.</li>}
          {items.map((item) => (
            <li key={item.readinessId} className="break-all">
              {item.readinessCode} ({item.reasonCode}) — {item.recordedAt} — {item.contractVersion}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

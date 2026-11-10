import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A8.7 — minimal read-only engineering check that shows the internal resolution history and derived disposition of one
// exception intake. Synthetic development data only. The page reads once on request, never records an event, never
// polls, keeps nothing in browser storage and logs nothing. RESOLVED_INTERNAL is an internal decision only: nothing is
// executed, corrected, closed, paid or sent, and RETURNED_FOR_REWORK is terminal in v1.

type ResolutionEvent = {
  resolutionEventId: string
  sequence: number
  eventCode: string
  verificationEventId: string | null
  requestEventId: string | null
  reasonCode: string | null
  decisionCode: string | null
  returnReasonCode: string | null
  recordedByMembershipId: string
  recordedAt: string
}

type History = { items: ResolutionEvent[] }

type Disposition = {
  state: string
  verificationEventId: string | null
  request: { resolutionEventId: string; sequence: number } | null
  decision: { decisionCode: string; returnReasonCode: string | null; sequence: number } | null
  eventCount: number
  evaluatedAt: string
}

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(path)
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return (await response.json()) as T
}

export default function ExceptionResolutionCheck() {
  const [claimId, setClaimId] = useState('')
  const [intakeId, setIntakeId] = useState('')
  const [history, setHistory] = useState<History | null>(null)
  const [disposition, setDisposition] = useState<Disposition | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleRead(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    setHistory(null)
    setDisposition(null)
    const base = `/api/claims/${claimId.trim()}/exceptions/${intakeId.trim()}`
    try {
      setHistory(await readJson<History>(`${base}/resolution-history`))
      setDisposition(await readJson<Disposition>(`${base}/resolution-disposition`))
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Exception Resolution Check (A8.7)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. Shows the internal resolution request and independent decision of one exception intake in sequence and
        the disposition derived from them. RESOLVED_INTERNAL is an internal decision only; nothing is executed, corrected, closed, paid or sent.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={intakeId} onChange={(event) => setIntakeId(event.target.value)} placeholder="Exception intake UUID" aria-label="Exception intake UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read resolution (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {disposition && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            {disposition.state}
            {disposition.verificationEventId && ` — verified work ${disposition.verificationEventId}`}
            {disposition.request && ` — request (event ${disposition.request.sequence})`}
            {disposition.decision && ` — ${disposition.decision.decisionCode}${disposition.decision.returnReasonCode ? ` (${disposition.decision.returnReasonCode})` : ''}`} ({disposition.eventCount} event(s),
            evaluated {disposition.evaluatedAt})
          </p>
        </div>
      )}

      {history && (
        <ol className="mt-3 grid gap-1 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          {history.items.map((item) => (
            <li key={item.resolutionEventId} className="break-all">
              {item.sequence}. {item.recordedAt} — {item.eventCode}
              {item.verificationEventId && ` ${item.reasonCode} citing ${item.verificationEventId}`}
              {item.decisionCode && ` ${item.decisionCode}${item.returnReasonCode ? ` (${item.returnReasonCode})` : ''} of ${item.requestEventId}`} — membership {item.recordedByMembershipId}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

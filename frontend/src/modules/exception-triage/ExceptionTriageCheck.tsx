import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A8.2 — minimal read-only engineering check that shows the triage history and derived disposition of one exception
// intake. Synthetic development data only. The page reads once on request, never records an event, never polls, keeps
// nothing in browser storage and logs nothing. A disposition is an internal triage state: never a resolution, a payer
// decision, a payment or a closed claim.

type TriageEvent = {
  triageEventId: string
  sequence: number
  eventCode: string
  categoryCode: string | null
  priorityCode: string | null
  assignedMemberId: string | null
  reasonCode: string | null
  recordedAt: string
}

type History = { items: TriageEvent[] }

type Disposition = {
  dispositionCode: string
  categoryCode: string | null
  priorityCode: string | null
  assignedMemberId: string | null
  assigneeCurrentlyEligible: boolean | null
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

export default function ExceptionTriageCheck() {
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
      setHistory(await readJson<History>(`${base}/triage-history`))
      setDisposition(await readJson<Disposition>(`${base}/triage-disposition`))
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Exception Triage Check (A8.2)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. Shows the triage events of one exception intake in sequence and the disposition derived from them. A
        disposition is not a resolution, a payer decision, a payment or a closed claim.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={intakeId} onChange={(event) => setIntakeId(event.target.value)} placeholder="Exception intake UUID" aria-label="Exception intake UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read triage (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {disposition && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            {disposition.dispositionCode}
            {disposition.categoryCode && ` — ${disposition.categoryCode} / ${disposition.priorityCode}`}
            {disposition.assignedMemberId && ` — member ${disposition.assignedMemberId} (${disposition.assigneeCurrentlyEligible ? 'currently eligible' : 'no longer eligible'})`} ({disposition.eventCount} event(s), evaluated {disposition.evaluatedAt})
          </p>
        </div>
      )}

      {history && (
        <ol className="mt-3 grid gap-1 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          {history.items.map((item) => (
            <li key={item.triageEventId} className="break-all">
              {item.sequence}. {item.recordedAt} — {item.eventCode}
              {item.categoryCode && ` ${item.categoryCode}/${item.priorityCode}`}
              {item.assignedMemberId && ` member ${item.assignedMemberId}`}
              {item.reasonCode && ` reason ${item.reasonCode}`}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

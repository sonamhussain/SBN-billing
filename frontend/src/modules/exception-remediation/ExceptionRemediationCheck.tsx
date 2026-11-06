import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A8.5 — minimal read-only engineering check that shows the remediation history and derived disposition of one exception
// intake. Synthetic development data only. The page reads once on request, never records an event, never polls, keeps
// nothing in browser storage and logs nothing. An approved proposal is planning authorization only: nothing is executed,
// corrected, resolved, closed, paid or sent.

type RemediationEvent = {
  remediationEventId: string
  sequence: number
  eventCode: string
  actionCode: string | null
  findingEventId: string | null
  rationaleCode: string | null
  proposalEventId: string | null
  decisionCode: string | null
  reviewReasonCode: string | null
  recordedByMembershipId: string
  recordedAt: string
}

type History = { items: RemediationEvent[] }

type Disposition = {
  state: string
  pendingProposal: { remediationEventId: string; actionCode: string; sequence: number } | null
  latestDecision: { decisionCode: string; reviewReasonCode: string | null; sequence: number } | null
  approvedProposalEventId: string | null
  proposalCount: number
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

export default function ExceptionRemediationCheck() {
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
      setHistory(await readJson<History>(`${base}/remediation-history`))
      setDisposition(await readJson<Disposition>(`${base}/remediation-disposition`))
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Exception Remediation Check (A8.5)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. Shows the proposals and independent review decisions of one exception intake in sequence and the
        disposition derived from them. An approval authorizes internal planning only; nothing is executed, corrected or resolved.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={intakeId} onChange={(event) => setIntakeId(event.target.value)} placeholder="Exception intake UUID" aria-label="Exception intake UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read remediation (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {disposition && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            {disposition.state} — {disposition.proposalCount} proposal(s)
            {disposition.pendingProposal && ` — awaiting review: ${disposition.pendingProposal.actionCode} (event ${disposition.pendingProposal.sequence})`}
            {disposition.latestDecision && ` — latest decision ${disposition.latestDecision.decisionCode}${disposition.latestDecision.reviewReasonCode ? ` (${disposition.latestDecision.reviewReasonCode})` : ''}`} ({disposition.eventCount}{' '}
            event(s), evaluated {disposition.evaluatedAt})
          </p>
        </div>
      )}

      {history && (
        <ol className="mt-3 grid gap-1 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          {history.items.map((item) => (
            <li key={item.remediationEventId} className="break-all">
              {item.sequence}. {item.recordedAt} — {item.eventCode}
              {item.actionCode && ` ${item.actionCode} (${item.rationaleCode}) on finding ${item.findingEventId}`}
              {item.decisionCode && ` ${item.decisionCode}${item.reviewReasonCode ? ` (${item.reviewReasonCode})` : ''} of ${item.proposalEventId}`} — membership {item.recordedByMembershipId}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

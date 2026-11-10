import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A8.6 — minimal read-only engineering check that shows the remediation work history and derived disposition of one
// exception intake. Synthetic development data only. The page reads once on request, never records an event, never
// polls, keeps nothing in browser storage and logs nothing. A verification confirms only that the cited internal record
// and the work report agree: nothing is executed, corrected, resolved, closed, paid or sent.

type WorkEvent = {
  workEventId: string
  sequence: number
  eventCode: string
  approvedProposalEventId: string
  workCode: string | null
  basisReferenceKind: string | null
  basisReferenceId: string | null
  workReportEventId: string | null
  verificationCode: string | null
  reasonCode: string | null
  recordedByMembershipId: string
  recordedAt: string
}

type History = { items: WorkEvent[] }

type Disposition = {
  state: string
  approvedProposalEventId: string | null
  report: { workEventId: string; workCode: string; sequence: number } | null
  verification: { verificationCode: string; reasonCode: string | null; sequence: number } | null
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

export default function ExceptionRemediationWorkCheck() {
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
      setHistory(await readJson<History>(`${base}/remediation-work-history`))
      setDisposition(await readJson<Disposition>(`${base}/remediation-work-disposition`))
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Exception Remediation Work Check (A8.6)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. Shows the work report and independent verification of one exception intake in sequence and the
        disposition derived from them. A verification confirms only that the cited internal record and the report agree; nothing is executed, corrected or
        resolved.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={intakeId} onChange={(event) => setIntakeId(event.target.value)} placeholder="Exception intake UUID" aria-label="Exception intake UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read remediation work (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {disposition && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            {disposition.state}
            {disposition.approvedProposalEventId && ` — approved proposal ${disposition.approvedProposalEventId}`}
            {disposition.report && ` — report: ${disposition.report.workCode} (event ${disposition.report.sequence})`}
            {disposition.verification && ` — ${disposition.verification.verificationCode}${disposition.verification.reasonCode ? ` (${disposition.verification.reasonCode})` : ''}`} ({disposition.eventCount}{' '}
            event(s), evaluated {disposition.evaluatedAt})
          </p>
        </div>
      )}

      {history && (
        <ol className="mt-3 grid gap-1 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          {history.items.map((item) => (
            <li key={item.workEventId} className="break-all">
              {item.sequence}. {item.recordedAt} — {item.eventCode}
              {item.workCode && ` ${item.workCode} citing ${item.basisReferenceKind} ${item.basisReferenceId}`}
              {item.verificationCode && ` ${item.verificationCode}${item.reasonCode ? ` (${item.reasonCode})` : ''} of ${item.workReportEventId}`} — membership {item.recordedByMembershipId}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

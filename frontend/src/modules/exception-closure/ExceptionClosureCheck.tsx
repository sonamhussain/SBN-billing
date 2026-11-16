import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A8.9 — minimal read-only engineering check that shows the internal closure history of one exception intake and the
// historical reconstruction of its basis. Synthetic development data only. The page reads once on request, never records
// an event, never polls, keeps nothing in browser storage and logs nothing. CLOSED_INTERNAL is an internal process
// position only: nothing is adjudicated, paid, corrected or sent, and a recorded coding status is shown exactly as its
// owner reports it.

type ClosureEvent = {
  closureEventId: string
  sequence: number
  eventCode: string
  resolutionDecisionEventId: string
  closureReasonCode: string
  basisReferenceKind: string
  basisReferenceId: string
  recordedByMembershipId: string
  recordedAt: string
}

type History = { items: ClosureEvent[] }

type Reconstruction = {
  state: string
  recordedClosure: ClosureEvent | null
  chain: { position: number; owner: string; ownerContractVersion: string; recordId: string; sequence: number | null; eventCode: string | null }[]
  submissions: { submissionId: string; codingVerificationStatus: string }[]
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

export default function ExceptionClosureCheck() {
  const [claimId, setClaimId] = useState('')
  const [intakeId, setIntakeId] = useState('')
  const [history, setHistory] = useState<History | null>(null)
  const [reconstruction, setReconstruction] = useState<Reconstruction | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleRead(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    setHistory(null)
    setReconstruction(null)
    const base = `/api/claims/${claimId.trim()}/exceptions/${intakeId.trim()}`
    try {
      setHistory(await readJson<History>(`${base}/closure-history`))
      setReconstruction(await readJson<Reconstruction>(`${base}/closure-reconstruction`))
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Exception Closure Check (A8.9)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. Shows the internal closure of one exception intake and the reconstruction of the recorded basis it rests on.
        CLOSED_INTERNAL is an internal process position only; nothing is adjudicated, paid, corrected or sent.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={intakeId} onChange={(event) => setIntakeId(event.target.value)} placeholder="Exception intake UUID" aria-label="Exception intake UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read closure (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {reconstruction && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            {reconstruction.state}
            {reconstruction.recordedClosure && ` — ${reconstruction.recordedClosure.closureReasonCode} on ${reconstruction.recordedClosure.basisReferenceKind}`} ({reconstruction.chain.length} anchored record(s),
            evaluated {reconstruction.evaluatedAt})
          </p>
          <ol className="mt-2 grid gap-1">
            {reconstruction.chain.map((entry) => (
              <li key={`${entry.owner}-${entry.recordId}`} className="break-all">
                {entry.position}. {entry.owner} {entry.eventCode ?? 'intake'} {entry.sequence !== null ? `#${entry.sequence}` : ''} — {entry.recordId}
              </li>
            ))}
          </ol>
          {reconstruction.submissions.map((submission) => (
            <p key={submission.submissionId} className="break-all">
              submission {submission.submissionId}: {submission.codingVerificationStatus}
            </p>
          ))}
        </div>
      )}

      {history && (
        <ol className="mt-3 grid gap-1 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          {history.items.map((item) => (
            <li key={item.closureEventId} className="break-all">
              {item.sequence}. {item.recordedAt} — {item.eventCode} {item.closureReasonCode} citing {item.resolutionDecisionEventId} — membership {item.recordedByMembershipId}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

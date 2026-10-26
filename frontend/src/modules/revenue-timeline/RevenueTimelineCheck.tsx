import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A7.7 — minimal read-only engineering check for the revenue evidence timeline of one Claim. Synthetic development data
// only. The page reads once on request, never polls, keeps nothing in browser storage and logs nothing. A timeline is
// the recorded history of a Claim's frozen submissions with their cases and assessments: never a current or latest
// claim, a payment, a balance, a payer decision or a closed account.

type SubmissionEntry = {
  ordinal: number
  claimSubmissionId: string
  priorSubmissionId: string | null
  correctionLinkId: string | null
  frozenAt: string
  caseSummaries: { caseId: string; assemblyCode: string; itemCount: number }[]
  prerequisiteSummaries: { assessmentId: string; assessmentCode: string; basisCode: string }[]
}

type Timeline = { contractVersion: string; claimId: string; evaluatedAt: string; chainCode: string; submissions: SubmissionEntry[]; historyCount: number }

export default function RevenueTimelineCheck() {
  const [claimId, setClaimId] = useState('')
  const [timeline, setTimeline] = useState<Timeline | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleRead(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    setTimeline(null)
    try {
      const response = await fetch(`/api/claims/${claimId.trim()}/revenue-evidence-timeline`)
      if (!response.ok) {
        const apiError = await readApiError(response)
        throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
      }
      setTimeline((await response.json()) as Timeline)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Revenue Evidence Timeline Check (A7.7)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. The timeline lists a claim's frozen submissions in correction order with the cases and assessments
        recorded for each; it does not pick a current claim and is not a payment, a balance, a payer decision or a closed account.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read timeline (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {timeline && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p className="break-all">
            {timeline.chainCode} — {timeline.historyCount} frozen submission(s) — evaluated {timeline.evaluatedAt}
          </p>
          <ol className="mt-2 grid gap-1">
            {timeline.submissions.map((entry) => (
              <li key={entry.claimSubmissionId} className="break-all">
                {entry.ordinal}. frozen {entry.frozenAt}
                {entry.correctionLinkId ? ' (correction)' : ' (root)'} — {entry.caseSummaries.length === 0 ? 'no case recorded' : entry.caseSummaries.map((c) => `${c.assemblyCode} (${c.itemCount} item(s))`).join(', ')} —{' '}
                {entry.prerequisiteSummaries.length === 0 ? 'no assessment recorded' : entry.prerequisiteSummaries.map((a) => `${a.assessmentCode} / ${a.basisCode}`).join(', ')}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}

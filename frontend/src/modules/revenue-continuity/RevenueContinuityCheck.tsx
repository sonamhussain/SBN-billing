import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A7.9 — minimal read-only engineering check for the revenue evidence continuity of one Claim. Synthetic development
// data only. The page reads once on request, never polls, keeps nothing in browser storage and logs nothing. A gap only
// says which evidence is not recorded for a frozen submission: never a zero balance, a payer decision, a payment or a
// closed account, and no result here means ready to close.

type Gap = {
  ordinal: number
  claimSubmissionId: string
  caseId: string | null
  assessmentId: string | null
  gapCode: string
  basisCode: string | null
}

type Continuity = { contractVersion: string; claimId: string; evaluatedAt: string; continuityCode: string; submissionCount: number; comparisonCount: number; gaps: Gap[] }

export default function RevenueContinuityCheck() {
  const [claimId, setClaimId] = useState('')
  const [continuity, setContinuity] = useState<Continuity | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleRead(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    setContinuity(null)
    try {
      const response = await fetch(`/api/claims/${claimId.trim()}/revenue-evidence-continuity`)
      if (!response.ok) {
        const apiError = await readApiError(response)
        throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
      }
      setContinuity((await response.json()) as Continuity)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Revenue Evidence Continuity Check (A7.9)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. Continuity lists, for every frozen submission in a claim's correction chain, which recorded evidence is
        missing; it is not a balance, a payer decision, a payment or a closed account.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read continuity (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {continuity && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p className="break-all">
            {continuity.continuityCode} — {continuity.submissionCount} freeze(s), {continuity.comparisonCount} comparison(s) — evaluated {continuity.evaluatedAt}
          </p>
          <ol className="mt-2 grid gap-1">
            {continuity.gaps.map((gap) => (
              <li key={gap.ordinal} className="break-all">
                {gap.ordinal}. {gap.gapCode}
                {gap.basisCode ? ` (${gap.basisCode})` : ''}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}

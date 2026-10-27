import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A7.8 — minimal read-only engineering check for the revenue evidence delta of one Claim. Synthetic development data
// only. The page reads once on request, never polls, keeps nothing in browser storage and logs nothing. A delta only
// says whether the RECORDED evidence summary differs between two adjacent frozen submissions: never more or less
// money, a payer decision, a payment, a balance or a closed account.

type Comparison = {
  ordinal: number
  predecessorSubmissionId: string
  correctedSubmissionId: string
  evidenceDeltaCode: string
  sourceCountBefore: number | null
  sourceCountAfter: number | null
}

type Delta = { contractVersion: string; claimId: string; evaluatedAt: string; baselineCode: string; comparisonCount: number; comparisons: Comparison[] }

export default function RevenueDeltaCheck() {
  const [claimId, setClaimId] = useState('')
  const [delta, setDelta] = useState<Delta | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleRead(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    setDelta(null)
    try {
      const response = await fetch(`/api/claims/${claimId.trim()}/revenue-evidence-delta`)
      if (!response.ok) {
        const apiError = await readApiError(response)
        throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
      }
      setDelta((await response.json()) as Delta)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  const count = (value: number | null) => (value === null ? 'none' : String(value))

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Revenue Evidence Delta Check (A7.8)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. A delta compares the recorded evidence summaries of adjacent frozen submissions in a claim's correction
        chain; it is not a change in money, a payer decision, a payment, a balance or a closed account.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read delta (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {delta && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p className="break-all">
            {delta.baselineCode} — {delta.comparisonCount} comparison(s) — evaluated {delta.evaluatedAt}
          </p>
          <ol className="mt-2 grid gap-1">
            {delta.comparisons.map((comparison) => (
              <li key={comparison.ordinal} className="break-all">
                {comparison.ordinal}. {comparison.evidenceDeltaCode} — sources {count(comparison.sourceCountBefore)} → {count(comparison.sourceCountAfter)}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}

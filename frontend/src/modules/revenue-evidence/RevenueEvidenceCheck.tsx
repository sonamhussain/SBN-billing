import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A7.1 — minimal read-only engineering check for the revenue source evidence registered against one frozen
// claim submission. Synthetic development data only. The page never registers evidence, asserts a payment or
// sends anything, and keeps nothing in browser storage. A registration only records where source evidence came
// from: it is never a payer verdict, a cash receipt, an amount or a status.

type RevenueSourceEvidence = {
  revenueSourceEvidenceId: string
  claimSubmissionId: string
  sourceKind: string
  sourceReference: string
  sourceVersion: string
  sourceDigestSha256: string | null
  receivedAt: string
  recordedByUserId: string
}

export default function RevenueEvidenceCheck() {
  const [submissionId, setSubmissionId] = useState('')
  const [items, setItems] = useState<RevenueSourceEvidence[] | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleRead(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    setItems(null)
    try {
      const response = await fetch(`/api/claim-submissions/${submissionId.trim()}/revenue-source-evidence`)
      if (!response.ok) {
        const apiError = await readApiError(response)
        throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
      }
      setItems(((await response.json()) as { items: RevenueSourceEvidence[] }).items)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Revenue Source Evidence Check (A7.1)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. A registration records which source evidence exists for a frozen submission; it is not a payment, a payer decision
        or a claim status.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={submissionId} onChange={(event) => setSubmissionId(event.target.value)} placeholder="Claim submission UUID" aria-label="Claim submission UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read source evidence (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {items && (
        <ol className="mt-3 grid gap-1 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          {items.length === 0 && <li>No source evidence registered for this submission.</li>}
          {items.map((item) => (
            <li key={item.revenueSourceEvidenceId} className="break-all">
              {item.sourceKind} {item.sourceReference} — {item.receivedAt} — {item.sourceVersion}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

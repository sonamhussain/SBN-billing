import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A7.4 — minimal read-only engineering check for the case snapshots recorded for one frozen claim submission.
// Synthetic development data only. The page never assembles a case, adjudicates, pays or sends anything, and keeps
// nothing in browser storage. A case is an as-recorded inventory of evidence links: never an insurer decision, a
// payment, a balance or a claim status.

type CaseHeader = {
  caseId: string
  claimSubmissionId: string
  contractVersion: string
  assemblyCode: string
  sourceCount: number
  classifiedCount: number
  readinessCount: number
  itemCount: number
  manifestSha256: string
  recordedByUserId: string
  recordedAt: string
}

export default function EvidenceCaseCheck() {
  const [submissionId, setSubmissionId] = useState('')
  const [items, setItems] = useState<CaseHeader[] | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleRead(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    setItems(null)
    try {
      const response = await fetch(`/api/claim-submissions/${submissionId.trim()}/revenue-evidence-cases`)
      if (!response.ok) {
        const apiError = await readApiError(response)
        throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
      }
      setItems(((await response.json()) as { items: CaseHeader[] }).items)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Evidence Case Check (A7.4)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. A case lists which evidence was recorded for a frozen submission and how it links; it is not an insurer
        decision, a payment, a balance or a claim status.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={submissionId} onChange={(event) => setSubmissionId(event.target.value)} placeholder="Claim submission UUID" aria-label="Claim submission UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read cases (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {items && (
        <ol className="mt-3 grid gap-1 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          {items.length === 0 && <li>No case recorded for this submission.</li>}
          {items.map((item) => (
            <li key={item.caseId} className="break-all">
              {item.assemblyCode} — {item.itemCount} item(s), {item.readinessCount} linked — {item.recordedAt} — {item.manifestSha256.slice(0, 12)}…
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

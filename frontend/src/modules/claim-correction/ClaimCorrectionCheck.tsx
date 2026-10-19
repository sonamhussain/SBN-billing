import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A6.9 — minimal read-only engineering check for a Claim's correction lineage: the immutable links between
// its frozen submissions, in chain order. Synthetic development data only. The page never records a link,
// resubmits or sends anything, and keeps nothing in browser storage. A correction link is an internal
// traceability fact, never evidence that anything was resubmitted to a payer.

type CorrectionLink = {
  correctionLinkId: string
  claimId: string
  priorSubmissionId: string
  correctedSubmissionId: string
  reasonCode: string
  recordedByUserId: string
  recordedAt: string
  contractVersion: string
}

export default function ClaimCorrectionCheck() {
  const [claimId, setClaimId] = useState('')
  const [links, setLinks] = useState<CorrectionLink[] | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleRead(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    setLinks(null)
    try {
      const response = await fetch(`/api/claims/${claimId.trim()}/correction-links`)
      if (!response.ok) {
        const apiError = await readApiError(response)
        throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
      }
      setLinks(((await response.json()) as { items: CorrectionLink[] }).items)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Claim Correction Lineage Check (A6.9)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. A correction link records which frozen submission corrected which earlier one; it is not a resubmission and
        changes neither freeze.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read correction chain (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {links && (
        <ol className="mt-3 grid gap-1 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          {links.length === 0 && <li>No correction link for this Claim.</li>}
          {links.map((link, index) => (
            <li key={link.correctionLinkId} className="break-all">
              #{index + 1} {link.priorSubmissionId} → {link.correctedSubmissionId} ({link.reasonCode}) — {link.recordedAt} — {link.contractVersion}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

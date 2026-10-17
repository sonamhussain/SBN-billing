import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A6.6 — minimal engineering check for the canonical claim payload: preview the A6-PAYLOAD-1 view and its
// SHA-256 preview digest for an exact Claim, draft assessment and approval decision. Synthetic development
// data only. The page sends exactly the two ids, shows only what the server composed and decides nothing:
// no payload, amount or code is ever sent, nothing is logged or kept in browser storage, and the digest is
// a comparison aid, never a submission hash. There is no submit or send action.

type Preview = {
  schemaVersion: string
  previewDigestSha256: string
  byteLength: number
  payload: {
    header: { claimId: string; serviceDate: string; jurisdictionCode: string; draftAssessmentId: string; approvalDecisionId: string }
    lines: { sequence: number; claimLineId: string; quantity: string; extendedAmount: string; currencyCode: string }[]
    diagnoses: { sequence: number; claimDiagnosisId: string; roleCode: string }[]
    financial: { totalExtendedAmount: string; currencyCode: string }
  }
}

export default function ClaimPayloadCheck() {
  const [claimId, setClaimId] = useState('')
  const [draftAssessmentId, setDraftAssessmentId] = useState('')
  const [approvalDecisionId, setApprovalDecisionId] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handlePreview(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    setPreview(null)
    try {
      const response = await fetch(`/api/claims/${claimId.trim()}/canonical-payload/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftAssessmentId: draftAssessmentId.trim(), approvalDecisionId: approvalDecisionId.trim() }),
      })
      if (!response.ok) {
        const apiError = await readApiError(response)
        throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
      }
      setPreview((await response.json()) as Preview)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Canonical Claim Payload Check (A6.6)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. The preview digest is a comparison aid for one approved draft; it is not a submission, a submission hash or a
        payer message.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handlePreview}>
        <input className={inputClass} value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <input className={inputClass} value={draftAssessmentId} onChange={(event) => setDraftAssessmentId(event.target.value)} placeholder="Exact draft assessment UUID" aria-label="Draft assessment UUID" />
        <input className={inputClass} value={approvalDecisionId} onChange={(event) => setApprovalDecisionId(event.target.value)} placeholder="Exact approval decision UUID" aria-label="Approval decision UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Preview canonical payload (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {preview && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            {preview.schemaVersion} — {preview.byteLength} bytes — Claim {preview.payload.header.claimId} — service date {preview.payload.header.serviceDate} —{' '}
            {preview.payload.header.jurisdictionCode}
          </p>
          <p className="break-all">Preview digest (SHA-256) {preview.previewDigestSha256}</p>
          <p>
            Total {preview.payload.financial.totalExtendedAmount} {preview.payload.financial.currencyCode} — {preview.payload.lines.length} line(s),{' '}
            {preview.payload.diagnoses.length} diagnosis(es)
          </p>
          <ul className="mt-1 grid gap-1">
            {preview.payload.lines.map((line) => (
              <li key={line.claimLineId}>
                #{line.sequence} {line.claimLineId} — quantity {line.quantity} — {line.extendedAmount} {line.currencyCode}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

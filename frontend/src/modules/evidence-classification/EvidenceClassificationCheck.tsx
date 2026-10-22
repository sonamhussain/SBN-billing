import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A7.2 — minimal read-only engineering check for the classifications recorded for one revenue source evidence
// record. Synthetic development data only. The page never classifies, verifies, asserts a payment or sends
// anything, and keeps nothing in browser storage. A classification only says what kind of internal evidence was
// registered: it is never a payer verdict, a cash receipt, an amount or a status.

type EvidenceClassification = {
  classificationId: string
  sourceEvidenceId: string
  contractVersion: string
  classificationCode: string
  normalizationOutcome: string
  reasonCode: string
  sourceFingerprintSha256: string
  recordedByUserId: string
  recordedAt: string
}

export default function EvidenceClassificationCheck() {
  const [evidenceId, setEvidenceId] = useState('')
  const [items, setItems] = useState<EvidenceClassification[] | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleRead(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    setItems(null)
    try {
      const response = await fetch(`/api/revenue-source-evidence/${evidenceId.trim()}/classifications`)
      if (!response.ok) {
        const apiError = await readApiError(response)
        throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
      }
      setItems(((await response.json()) as { items: EvidenceClassification[] }).items)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Evidence Classification Check (A7.2)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. A classification says what kind of internal evidence a source record is; it is not a verification, a payment, a
        payer decision or a claim status.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={evidenceId} onChange={(event) => setEvidenceId(event.target.value)} placeholder="Source evidence UUID" aria-label="Source evidence UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read classifications (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {items && (
        <ol className="mt-3 grid gap-1 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          {items.length === 0 && <li>No classification recorded for this source record.</li>}
          {items.map((item) => (
            <li key={item.classificationId} className="break-all">
              {item.classificationCode} / {item.normalizationOutcome} ({item.reasonCode}) — {item.recordedAt} — {item.contractVersion}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

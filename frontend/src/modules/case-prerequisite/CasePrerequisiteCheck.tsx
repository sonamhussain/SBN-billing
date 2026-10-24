import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A7.5 — minimal read-only engineering check for the closure-prerequisite assessments recorded for one exact case
// snapshot. Synthetic development data only. The page never assesses, adjudicates, pays, posts or closes anything,
// and keeps nothing in browser storage. An assessment states which closure prerequisite is ABSENT: never a payment, a
// balance, a payer decision or a closed account.

type Assessment = {
  assessmentId: string
  caseId: string
  contractVersion: string
  assessmentCode: string
  basisCode: string
  caseManifestSha256: string
  recordedByUserId: string
  recordedAt: string
}

export default function CasePrerequisiteCheck() {
  const [caseId, setCaseId] = useState('')
  const [items, setItems] = useState<Assessment[] | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleRead(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    setItems(null)
    try {
      const response = await fetch(`/api/revenue-evidence-cases/${caseId.trim()}/closure-prerequisite-assessments`)
      if (!response.ok) {
        const apiError = await readApiError(response)
        throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
      }
      setItems(((await response.json()) as { items: Assessment[] }).items)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Case Closure Prerequisite Check (A7.5)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. An assessment says which prerequisite for any later financial closure is missing for one exact case; it
        is not a payment, a balance, a payer decision or a closed account.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={caseId} onChange={(event) => setCaseId(event.target.value)} placeholder="Revenue evidence case UUID" aria-label="Revenue evidence case UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read assessments (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {items && (
        <ol className="mt-3 grid gap-1 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          {items.length === 0 && <li>No assessment recorded for this case.</li>}
          {items.map((item) => (
            <li key={item.assessmentId} className="break-all">
              {item.assessmentCode} / {item.basisCode} — {item.contractVersion} — {item.recordedAt} — case {item.caseManifestSha256.slice(0, 12)}…
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

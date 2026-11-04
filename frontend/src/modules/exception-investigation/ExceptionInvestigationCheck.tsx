import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A8.3 — minimal read-only engineering check that shows the investigation history and derived summary of one exception
// intake. Synthetic development data only. The page reads once on request, never records an event, never polls, keeps
// nothing in browser storage and logs nothing. A finding is an observation about linked evidence: never a resolution,
// a payer decision, a payment or a closed claim.

type InvestigationEvent = {
  investigationEventId: string
  sequence: number
  eventCode: string
  evidenceKind: string | null
  evidenceRecordId: string | null
  evidenceBasisCode: string | null
  linkedEvidenceEventId: string | null
  findingCode: string | null
  recordedByMembershipId: string
  recordedAt: string
}

type History = { items: InvestigationEvent[] }

type Summary = {
  investigationCode: string
  evidenceLinks: { investigationEventId: string }[]
  findings: { investigationEventId: string }[]
  latestFinding: { sequence: number; findingCode: string; linkedEvidenceEventId: string } | null
  eventCount: number
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

export default function ExceptionInvestigationCheck() {
  const [claimId, setClaimId] = useState('')
  const [intakeId, setIntakeId] = useState('')
  const [history, setHistory] = useState<History | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleRead(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    setHistory(null)
    setSummary(null)
    const base = `/api/claims/${claimId.trim()}/exceptions/${intakeId.trim()}`
    try {
      setHistory(await readJson<History>(`${base}/investigation-history`))
      setSummary(await readJson<Summary>(`${base}/investigation-summary`))
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Exception Investigation Check (A8.3)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. Shows the evidence links and findings of one exception intake in sequence and the summary derived from
        them. A finding is not a resolution, a payer decision, a payment or a closed claim.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={intakeId} onChange={(event) => setIntakeId(event.target.value)} placeholder="Exception intake UUID" aria-label="Exception intake UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read investigation (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {summary && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            {summary.investigationCode} — {summary.evidenceLinks.length} evidence link(s), {summary.findings.length} finding(s)
            {summary.latestFinding && ` — latest finding ${summary.latestFinding.findingCode} (event ${summary.latestFinding.sequence})`} ({summary.eventCount} event(s), evaluated{' '}
            {summary.evaluatedAt})
          </p>
        </div>
      )}

      {history && (
        <ol className="mt-3 grid gap-1 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          {history.items.map((item) => (
            <li key={item.investigationEventId} className="break-all">
              {item.sequence}. {item.recordedAt} — {item.eventCode}
              {item.evidenceKind && ` ${item.evidenceKind} ${item.evidenceRecordId}`}
              {item.evidenceBasisCode && ` (${item.evidenceBasisCode})`}
              {item.findingCode && ` ${item.findingCode} on ${item.linkedEvidenceEventId}`} — membership {item.recordedByMembershipId}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

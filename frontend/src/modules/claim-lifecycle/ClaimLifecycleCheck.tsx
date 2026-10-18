import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A6.8 — minimal read-only engineering check for the internal lifecycle of a frozen claim submission: its
// derived disposition and its append-only event history. Synthetic development data only. The page never
// records an event, sends anything or keeps anything in browser storage. The dispositions are internal SBN
// processing states — never "submitted", "received", "accepted" or "paid".

type Lifecycle = { submissionId: string; lifecycleContractVersion: string; state: string; lastEventId: string | null; lastSequence: number; evaluatedAt: string }
type LifecycleEvent = { id: string; sequence: number; eventCode: string; reasonCode: string | null; actorUserId: string; occurredAt: string }

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path)
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return (await response.json()) as T
}

export default function ClaimLifecycleCheck() {
  const [submissionId, setSubmissionId] = useState('')
  const [lifecycle, setLifecycle] = useState<Lifecycle | null>(null)
  const [events, setEvents] = useState<LifecycleEvent[] | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleRead(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    setLifecycle(null)
    setEvents(null)
    try {
      const id = submissionId.trim()
      setLifecycle(await getJson<Lifecycle>(`/api/claim-submissions/${id}/lifecycle`))
      setEvents((await getJson<{ items: LifecycleEvent[] }>(`/api/claim-submissions/${id}/lifecycle-events`)).items)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Internal Claim Lifecycle Check (A6.8)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. FROZEN, HELD, RELEASE_ELIGIBLE and WITHDRAWN_INTERNAL are internal dispositions of a frozen submission; none of
        them means sent, received, accepted or paid.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={submissionId} onChange={(event) => setSubmissionId(event.target.value)} placeholder="Submission UUID" aria-label="Submission UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read lifecycle (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {lifecycle && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            {lifecycle.lifecycleContractVersion} — internal disposition <strong>{lifecycle.state}</strong> — {lifecycle.lastSequence} event(s) — evaluated {lifecycle.evaluatedAt}
          </p>
          {events && (
            <ol className="mt-2 grid gap-1">
              {events.length === 0 && <li>No lifecycle event: the freeze is FROZEN.</li>}
              {events.map((item) => (
                <li key={item.id} className="break-all">
                  #{item.sequence} {item.eventCode}
                  {item.reasonCode ? ` (${item.reasonCode})` : ''} — {item.occurredAt} — actor {item.actorUserId}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  )
}

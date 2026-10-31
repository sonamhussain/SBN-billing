import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A8.1 — minimal read-only engineering check that lists the exception intakes of one Claim. Synthetic development data
// only. The page reads once on request, never records an intake, never polls, keeps nothing in browser storage and
// logs nothing. An intake is an owner-established exception identity: never a payer decision, a payment, a balance,
// an assignment, a status or a closed claim.

type Intake = {
  exceptionIntakeId: string
  sourceKind: string
  sourceRecordId: string
  exceptionReasonCode: string
  basisCode: string
  basisRecordId: string
  recordedAt: string
}

type IntakeList = { items: Intake[] }

export default function ExceptionIntakeCheck() {
  const [claimId, setClaimId] = useState('')
  const [list, setList] = useState<IntakeList | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleRead(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    setList(null)
    try {
      const response = await fetch(`/api/claims/${claimId.trim()}/exception-intake`)
      if (!response.ok) {
        const apiError = await readApiError(response)
        throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
      }
      setList((await response.json()) as IntakeList)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Exception Intake Check (A8.1)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. Lists the recorded exception intakes of one claim, oldest first. An intake is not a payer decision, a
        payment, a balance, an assignment, a status or a closed claim.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read intakes (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {list && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>{list.items.length} intake(s)</p>
          <ol className="mt-2 grid gap-1">
            {list.items.map((item) => (
              <li key={item.exceptionIntakeId} className="break-all">
                {item.recordedAt} — {item.exceptionReasonCode} on {item.sourceKind} {item.sourceRecordId} (basis {item.basisCode} {item.basisRecordId})
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}

import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A6.2 — minimal engineering check for a Claim's draft lines: add a line from one exact EncounterActivity
// of the Claim's bound handoff, list, reorder, remove, and set a line's diagnosis pointers. Only ids,
// positions and pointer ids are shown — no service, procedure, quantity, modifier, code, patient or
// member value. Only SBN UUIDs appear in a path, nothing travels in a query string, nothing is logged and
// nothing is kept in browser storage. A line here has no price, status, approval or submission.

type ClaimLineSummary = {
  id: string
  claimId: string
  sequence: number
  claimLineContractVersion: string
  removedAt: string | null
  source: { encounterActivityId: string }
  claimDiagnosisIds: string[]
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

const send = (method: 'POST' | 'PUT', body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const idList = (value: string) => value.split(/[\s,]+/).map((id) => id.trim()).filter((id) => id !== '')

export default function ClaimLineCheck() {
  const [claimId, setClaimId] = useState('')
  const [encounterActivityId, setEncounterActivityId] = useState('')
  const [order, setOrder] = useState('')
  const [lineId, setLineId] = useState('')
  const [pointers, setPointers] = useState('')
  const [lines, setLines] = useState<ClaimLineSummary[] | null>(null)
  const [line, setLine] = useState<ClaimLineSummary | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setNotice('')
    try {
      await action()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  const claimPath = () => `/api/claims/${claimId.trim()}`

  function handleAdd(event: FormEvent) {
    event.preventDefault()
    void run(async () => setLine(await handle<ClaimLineSummary>(await fetch(`${claimPath()}/lines`, send('POST', { encounterActivityId: encounterActivityId.trim() })))))
  }

  function handleList(event: FormEvent) {
    event.preventDefault()
    void run(async () => setLines((await handle<{ items: ClaimLineSummary[] }>(await fetch(`${claimPath()}/lines`))).items))
  }

  function handleReorder(event: FormEvent) {
    event.preventDefault()
    void run(async () => setLines((await handle<{ items: ClaimLineSummary[] }>(await fetch(`${claimPath()}/lines/order`, send('PUT', { claimLineIds: idList(order) })))).items))
  }

  function handleRemove(event: FormEvent) {
    event.preventDefault()
    void run(async () => setLine(await handle<ClaimLineSummary>(await fetch(`/api/claim-lines/${lineId.trim()}/remove`, send('POST', {})))))
  }

  function handlePointers(event: FormEvent) {
    event.preventDefault()
    void run(async () =>
      setLine(await handle<ClaimLineSummary>(await fetch(`/api/claim-lines/${lineId.trim()}/diagnosis-pointers`, send('PUT', { claimDiagnosisIds: idList(pointers) })))),
    )
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Claim Line Check (A6.2)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. A line is created from one exact EncounterActivity of the Claim&apos;s bound handoff. It has no price, status,
        approval or submission.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleList}>
        <input className={inputClass} value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          List claim lines
        </button>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleAdd}>
        <input
          className={inputClass}
          value={encounterActivityId}
          onChange={(event) => setEncounterActivityId(event.target.value)}
          placeholder="Encounter activity UUID"
          aria-label="Encounter activity UUID"
        />
        <button className={buttonClass} disabled={busy} type="submit">
          Add line
        </button>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleReorder}>
        <input className={inputClass} value={order} onChange={(event) => setOrder(event.target.value)} placeholder="Every active line UUID, in the new order" aria-label="Line order" />
        <button className={buttonClass} disabled={busy} type="submit">
          Reorder lines
        </button>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleRemove}>
        <input className={inputClass} value={lineId} onChange={(event) => setLineId(event.target.value)} placeholder="Claim line UUID" aria-label="Claim line UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          Remove line
        </button>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handlePointers}>
        <input className={inputClass} value={pointers} onChange={(event) => setPointers(event.target.value)} placeholder="Claim diagnosis UUIDs (empty clears)" aria-label="Diagnosis pointers" />
        <button className={buttonClass} disabled={busy} type="submit">
          Set diagnosis pointers of the line above
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {line && (
        <p className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          Line {line.id} — position {line.sequence} — {line.claimLineContractVersion} — source {line.source.encounterActivityId}
          {line.removedAt ? ' — removed' : ''} — pointers [{line.claimDiagnosisIds.join(', ')}]
        </p>
      )}

      {lines && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>{lines.length} active line(s), in claim order</p>
          <ul className="mt-1 grid gap-1">
            {lines.map((item) => (
              <li key={item.id}>
                {item.sequence}. {item.id} — source {item.source.encounterActivityId} — pointers [{item.claimDiagnosisIds.join(', ')}]
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

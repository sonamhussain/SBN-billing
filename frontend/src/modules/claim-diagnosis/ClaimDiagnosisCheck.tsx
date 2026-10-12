import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A6.2 — minimal engineering check for a Claim's diagnoses: add one exact EncounterDiagnosis of the
// Claim's bound handoff with an explicitly chosen role, list, reorder and remove. Only ids, positions and
// roles are shown — no diagnosis code, text, patient or member value. The role is never pre-selected or
// inferred. Nothing is logged and nothing is kept in browser storage.

type ClaimDiagnosisSummary = {
  id: string
  claimId: string
  encounterDiagnosisId: string
  sequence: number
  roleCode: string
  claimDiagnosisContractVersion: string
  removedAt: string | null
}

const roles = ['PRIMARY', 'SECONDARY', 'ADMITTING'] as const

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

const send = (method: 'POST' | 'PUT', body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const idList = (value: string) => value.split(/[\s,]+/).map((id) => id.trim()).filter((id) => id !== '')

export default function ClaimDiagnosisCheck() {
  const [claimId, setClaimId] = useState('')
  const [encounterDiagnosisId, setEncounterDiagnosisId] = useState('')
  const [roleCode, setRoleCode] = useState('')
  const [order, setOrder] = useState('')
  const [claimDiagnosisId, setClaimDiagnosisId] = useState('')
  const [diagnoses, setDiagnoses] = useState<ClaimDiagnosisSummary[] | null>(null)
  const [diagnosis, setDiagnosis] = useState<ClaimDiagnosisSummary | null>(null)
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
    void run(async () =>
      setDiagnosis(await handle<ClaimDiagnosisSummary>(await fetch(`${claimPath()}/diagnoses`, send('POST', { encounterDiagnosisId: encounterDiagnosisId.trim(), roleCode })))),
    )
  }

  function handleList(event: FormEvent) {
    event.preventDefault()
    void run(async () => setDiagnoses((await handle<{ items: ClaimDiagnosisSummary[] }>(await fetch(`${claimPath()}/diagnoses`))).items))
  }

  function handleReorder(event: FormEvent) {
    event.preventDefault()
    void run(async () =>
      setDiagnoses((await handle<{ items: ClaimDiagnosisSummary[] }>(await fetch(`${claimPath()}/diagnoses/order`, send('PUT', { claimDiagnosisIds: idList(order) })))).items),
    )
  }

  function handleRemove(event: FormEvent) {
    event.preventDefault()
    void run(async () => setDiagnosis(await handle<ClaimDiagnosisSummary>(await fetch(`/api/claim-diagnoses/${claimDiagnosisId.trim()}/remove`, send('POST', {})))))
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Claim Diagnosis Check (A6.2)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. A claim diagnosis is one exact EncounterDiagnosis of the Claim&apos;s bound handoff with an explicitly chosen
        canonical role. A role is corrected by removing and adding again.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleList}>
        <input className={inputClass} value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          List claim diagnoses
        </button>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleAdd}>
        <input
          className={inputClass}
          value={encounterDiagnosisId}
          onChange={(event) => setEncounterDiagnosisId(event.target.value)}
          placeholder="Encounter diagnosis UUID"
          aria-label="Encounter diagnosis UUID"
        />
        <select className={inputClass} value={roleCode} onChange={(event) => setRoleCode(event.target.value)} aria-label="Claim diagnosis role">
          <option value="">Choose a role</option>
          {roles.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
        <button className={buttonClass} disabled={busy || roleCode === ''} type="submit">
          Add diagnosis
        </button>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleReorder}>
        <input className={inputClass} value={order} onChange={(event) => setOrder(event.target.value)} placeholder="Every active claim diagnosis UUID, in the new order" aria-label="Diagnosis order" />
        <button className={buttonClass} disabled={busy} type="submit">
          Reorder diagnoses
        </button>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleRemove}>
        <input
          className={inputClass}
          value={claimDiagnosisId}
          onChange={(event) => setClaimDiagnosisId(event.target.value)}
          placeholder="Claim diagnosis UUID"
          aria-label="Claim diagnosis UUID"
        />
        <button className={buttonClass} disabled={busy} type="submit">
          Remove diagnosis
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {diagnosis && (
        <p className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          Claim diagnosis {diagnosis.id} — position {diagnosis.sequence} — {diagnosis.roleCode} — {diagnosis.claimDiagnosisContractVersion} — source{' '}
          {diagnosis.encounterDiagnosisId}
          {diagnosis.removedAt ? ' — removed' : ''}
        </p>
      )}

      {diagnoses && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>{diagnoses.length} active claim diagnosis(es), in claim order</p>
          <ul className="mt-1 grid gap-1">
            {diagnoses.map((item) => (
              <li key={item.id}>
                {item.sequence}. {item.id} — {item.roleCode} — source {item.encounterDiagnosisId}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

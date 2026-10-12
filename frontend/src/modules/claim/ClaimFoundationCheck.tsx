import { useState, type FormEvent } from 'react'
import { createClaim, listEncounterClaims, readClaim, type ClaimSummary } from './claim.api.ts'

// A6.1 — minimal engineering check: create one Claim from an exact READY_FOR_REVIEW readiness
// assessment, read a Claim, and list an Encounter's Claims. Only the Claim id, its bound assessment and
// Encounter ids, the two contract versions and the creation time are shown. No finding, context,
// patient or member value is displayed, nothing is logged, and nothing is kept in browser storage. A
// Claim here is an identity only: it has no lines, amount, status, approval or submission.

export default function ClaimFoundationCheck() {
  const [assessmentId, setAssessmentId] = useState('')
  const [claimId, setClaimId] = useState('')
  const [encounterId, setEncounterId] = useState('')
  const [claim, setClaim] = useState<ClaimSummary | null>(null)
  const [claims, setClaims] = useState<ClaimSummary[] | null>(null)
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

  function handleCreate(event: FormEvent) {
    event.preventDefault()
    void run(async () => setClaim(await createClaim(assessmentId.trim())))
  }

  function handleRead(event: FormEvent) {
    event.preventDefault()
    void run(async () => setClaim(await readClaim(claimId.trim())))
  }

  function handleList(event: FormEvent) {
    event.preventDefault()
    void run(async () => setClaims((await listEncounterClaims(encounterId.trim())).items))
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Claim Foundation Check (A6.1)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. A Claim is a stable identity bound to one exact READY_FOR_REVIEW readiness assessment. It has no lines, amount,
        status, approval or submission yet.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleCreate}>
        <input className={inputClass} value={assessmentId} onChange={(event) => setAssessmentId(event.target.value)} placeholder="Readiness assessment UUID" aria-label="Readiness assessment UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          Create claim
        </button>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className={inputClass} value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          Read claim
        </button>
      </form>

      {claim && (
        <p className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          Claim {claim.id} — {claim.claimContractVersion} / {claim.handoffSchemaVersion} — assessment {claim.preClaimReadinessAssessmentId} — encounter{' '}
          {claim.encounterId}
        </p>
      )}

      <form className="mt-4 grid gap-2" onSubmit={handleList}>
        <input className={inputClass} value={encounterId} onChange={(event) => setEncounterId(event.target.value)} placeholder="Encounter UUID" aria-label="Encounter UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          List encounter claims
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {claims && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>{claims.length} claim(s), newest first (history order, not a current claim)</p>
          <ul className="mt-1 grid gap-1">
            {claims.map((item) => (
              <li key={item.id}>
                {item.id} — {item.claimContractVersion} — assessment {item.preClaimReadinessAssessmentId}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

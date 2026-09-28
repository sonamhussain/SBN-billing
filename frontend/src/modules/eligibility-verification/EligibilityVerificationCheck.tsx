import { useState, type FormEvent } from 'react'
import {
  createEligibilityVerification,
  listEligibilityVerifications,
  type EligibilityVerification,
} from './eligibility-verification.api.ts'

// A5.2 — minimal engineering check: record a synthetic verification for an Encounter and list that
// Encounter's verification history.
//
// It shows the verification id, the reported status and the derived freshness, and nothing else.
// The payer, TPA, network and product identities, the response timing and the evidence version ids
// together describe a patient's insurance situation, so a development screen has no reason to
// display them. Nothing is logged or kept in browser storage, and this is not the pre-claim
// workflow UI.

const METHODS = ['ELECTRONIC', 'PORTAL', 'MANUAL', 'OTHER'] as const
const STATUSES = ['ELIGIBLE', 'INELIGIBLE', 'UNKNOWN'] as const

export default function EligibilityVerificationCheck() {
  const [encounterId, setEncounterId] = useState('')
  const [evidenceVersionId, setEvidenceVersionId] = useState('')
  const [method, setMethod] = useState<(typeof METHODS)[number]>('PORTAL')
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('UNKNOWN')
  const [withBoundary, setWithBoundary] = useState(true)
  const [verifications, setVerifications] = useState<EligibilityVerification[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  // Every value is generated here and is synthetic. The validity boundary is optional on purpose:
  // leaving it out is how a verification with no known boundary — and therefore UNKNOWN freshness —
  // is produced, which is a real answer rather than a missing one.
  const syntheticInput = () => {
    const respondedAt = new Date()
    return {
      verificationMethod: method,
      status,
      requestedAt: null,
      respondedAt: respondedAt.toISOString(),
      validThrough: withBoundary ? new Date(respondedAt.getTime() + 24 * 60 * 60 * 1000).toISOString() : null,
      authorizationRequired: null,
      referralRequired: null,
      requestEvidenceVersionId: null,
      responseEvidenceVersionId: evidenceVersionId.trim(),
    }
  }

  function handleCreate(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      await createEligibilityVerification(encounterId.trim(), syntheticInput())
      setVerifications(await listEligibilityVerifications(encounterId.trim()))
    })
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Eligibility Verification Check (A5.2)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. A verification records what a source actually reported for one Encounter, against the membership selected
        on that Encounter. It is immutable — re-verifying records a new one. Freshness is derived from the validity boundary at read time and is never
        stored, and <strong>FRESH never means ELIGIBLE</strong>.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleCreate}>
        <input className={inputClass} value={encounterId} onChange={(event) => setEncounterId(event.target.value)} placeholder="Encounter UUID" aria-label="Encounter UUID" />
        <input
          className={inputClass}
          value={evidenceVersionId}
          onChange={(event) => setEvidenceVersionId(event.target.value)}
          placeholder="Response evidence version UUID (A5.1)"
          aria-label="Response evidence version UUID"
        />
        <select className={inputClass} value={method} onChange={(event) => setMethod(event.target.value as (typeof METHODS)[number])} aria-label="Verification method">
          {METHODS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select className={inputClass} value={status} onChange={(event) => setStatus(event.target.value as (typeof STATUSES)[number])} aria-label="Reported status">
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={withBoundary} onChange={(event) => setWithBoundary(event.target.checked)} />
          Record a validity boundary (unchecked leaves freshness UNKNOWN)
        </label>
        <button className={buttonClass} disabled={busy} type="submit">
          Record synthetic verification
        </button>
      </form>

      <div className="mt-3">
        <button
          className={buttonClass}
          disabled={busy}
          type="button"
          onClick={() => void run(async () => setVerifications(await listEligibilityVerifications(encounterId.trim())))}
        >
          Load verification history
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {verifications && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            {verifications.length} verification(s), newest first. Re-verification adds a row; none is marked &ldquo;current&rdquo; here — choosing a usable
            verification belongs to a later governed module.
          </p>
          <ul className="mt-1 grid gap-1">
            {verifications.map((verification) => (
              <li key={verification.id}>
                {verification.id} — reported <strong>{verification.status}</strong> — freshness <strong>{verification.freshness.state}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
